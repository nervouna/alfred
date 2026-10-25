// Drives the real message handler without WeChat: a fake iLink client records
// every reply, and a scenario sends messages on a schedule. Point
// ALFRED_WORKSPACE and ALFRED_STATE_DIR at scratch directories.
// usage: node scripts/handler-smoke.ts <scenario>
//   background   three parallel collectors (two run, one queues), /status and a
//                quick question while they run, one reviewed reply per run
//   restart      a shutdown while a background subagent runs, then a new handler
//                and a message that gets the lost-runs note
//   undelivered  replies fail as after the 24-hour window, then the next message
//                gets the note naming the run
//   stop         two background collectors, then /stop <run id> for one of them
//   nested       a foreground general-purpose subagent starts three background
//                collectors: nested calls share the slot cap
//   channels     a WeChat message starts a run, an app message steers it and /status
//                comes from the app, then a second run starts from the app; ends with one
//                pass or fail line per routing rule
//   api          the real handler behind the command API on a socket in a temp dir, driven over
//                HTTP only: a question and its reply, a task stopped with run.stop, a duplicate
//                client id and a reconnect with Last-Event-ID; ends with one pass or fail line
//                per check
//   stream       the real handler behind the command API on a temp socket, driven over HTTP: a
//                question streams its reply as message.delta events, a longer task is stopped with
//                run.stop after its first run.step (an interrupt: the stop reply, no error reply,
//                the run ends stopped), and the next message starts a new turn in the same
//                session; ends with one pass or fail line per check and the spend
//   prompt <text>  one message on the default model, then the spend per model
// Every WeChat send and every message event is printed as it happens.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { LiveEventSchema } from "../src/api/schema.ts";
import type { Event, LiveEvent, Message } from "../src/api/schema.ts";
import { createAgentHandler } from "../src/agent/handler.ts";
import { request, streamEvents } from "../src/api/client.ts";
import { startApi } from "../src/api/server.ts";
import type { BotContext } from "../src/bot.ts";
import { appOutbound } from "../src/channels.ts";
import { WeChatChannel } from "../src/channels/wechat.ts";
import { sharedEventLog } from "../src/events.ts";
import { IlinkApiError } from "../src/ilink/client.ts";
import type { WeixinMessage } from "../src/ilink/types.ts";
import { listRunFiles } from "../src/runs.ts";

const scenario = process.argv[2] ?? "";
const t0 = Date.now();
const at = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const OWNER = "owner@im.wechat";

let failSends = false;
const sent: { at: string; text: string }[] = [];
const client = {
  async sendMessage(req: { msg: { item_list?: { text_item?: { text?: string } }[] } }) {
    const text = req.msg.item_list?.[0]?.text_item?.text ?? "[media]";
    if (failSends) {
      console.log(`[wechat ✗] ${at()} ${text.replace(/\n/g, " ⏎ ").slice(0, 200)}`);
      throw new IlinkApiError("sendMessage", { ret: -2, errmsg: "prepare failed" });
    }
    sent.push({ at: at(), text });
    console.log(`[wechat] ${at()} ${text.replace(/\n/g, " ⏎ ")}`);
    return { ret: 0 };
  },
  async getUploadUrl() {
    throw new Error("uploads are not available in the handler smoke test");
  },
};
const ctx = {
  client,
  account: { botToken: "x", botId: "smoke@im.bot", baseUrl: "https://invalid", ownerUserId: OWNER, loggedInAt: new Date().toISOString() },
  cdnBaseUrl: "https://invalid",
  tokens: { get: () => undefined, set: () => {} },
  typing: { start: async () => async () => {} },
  startedAt: Date.now(),
} as unknown as BotContext;

function message(text: string): WeixinMessage {
  return { from_user_id: OWNER, item_list: [{ type: 1, text_item: { text } }] } as WeixinMessage;
}

const wechat = new WeChatChannel(ctx);
const flat = (text: string) => text.replace(/\n/g, " ⏎ ");

/** Every message event as it is appended: who said it, where, and for which run. */
const messages: Message[] = [];
sharedEventLog().subscribe((event) => {
  if (event.type !== "message.created") return;
  const m = event.data;
  messages.push(m);
  const files = m.files.length ? ` files=${m.files.map((f) => f.path).join(",")}` : "";
  const error = m.error ? ` error="${m.error.slice(0, 60)}"` : "";
  console.log(`[event] ${at()} ${m.channel} ${m.direction} run=${m.runId ?? "-"}${files}${error} ${flat(m.text).slice(0, 80)}`);
});

type Handler = ReturnType<typeof createAgentHandler>;

function newHandler(progressMs?: number): Handler {
  return createAgentHandler({ owner: OWNER, channels: { wechat: wechat.outbound(OWNER), app: appOutbound() }, progressMs });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until no run is live or queued, then a little longer for the last replies. */
async function idle(limitMs = 600_000): Promise<void> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    await sleep(2000);
    const live = listRunFiles().filter((f) => f.status === "running" || f.status === "queued");
    if (!live.length) break;
    if (Date.now() > deadline) throw new Error(`still live after ${limitMs / 1000}s: ${live.map((f) => f.id).join(", ")}`);
  }
  await sleep(3000);
}

function summary(): void {
  console.log("\n[runs]");
  for (const f of listRunFiles().reverse()) {
    const cost = `${f.costEstimated ? "≈" : ""}$${f.costUsd.toFixed(4)}`;
    console.log(
      `  ${f.id} ${f.kind}${f.role ? `/${f.role}` : ""} ${f.status} parent=${f.parentRunId ?? "-"} ${cost} steps=${f.steps.length} files=${f.files.map((x) => x.path).join(",") || "-"}${f.undelivered?.length ? ` undelivered=${f.undelivered.length}` : ""} "${f.title}"`,
    );
  }
  for (const f of listRunFiles().filter((r) => r.kind === "task")) {
    console.log(`[models] ${f.id} ${Object.entries(f.modelCostUsd ?? {}).map(([m, c]) => `${m} $${c.toFixed(4)}`).join(", ")}`);
  }
}

async function send(handler: Handler, text: string): Promise<void> {
  console.log(`[owner] ${at()} ${text}`);
  await handler.submit(() => wechat.inbound(message(text)));
}

async function sendApp(handler: Handler, text: string, clientId: string): Promise<void> {
  console.log(`[app] ${at()} ${text}`);
  await handler.submit({ channel: "app", text, files: [], clientId });
}

/** The channels scenario: who got what, checked against the routing rules. Returns the number of rules that failed. */
async function channels(): Promise<number> {
  // A short progress interval, so a run of a few seconds already gets a note.
  const handler = newHandler(4000);
  await send(handler, "/model haiku");

  // A WeChat message starts a run; while it works, an app message steers it and /status comes from the app.
  const STEERED = "收到，会在当前步骤结束后转给 Alfred。";
  const first = "用 WebFetch 读 https://en.wikipedia.org/wiki/Rome ，把三行历史摘要写到 notes/rome.md；再读 https://en.wikipedia.org/wiki/Paris ，写到 notes/paris.md；最后回复“完成 A”。";
  await send(handler, first);
  await sleep(3000);
  const steer = "补充：回复里也列出两个文件名。";
  await sendApp(handler, steer, "c-steer");
  await sendApp(handler, "/status", "c-status");
  await idle();

  // A second run starts from the app, and delivers a file with send_file.
  const sentBefore = sent.length;
  const second = "在 notes/b.md 写一行“你好”，用 send_file 把它发给我，然后回复“完成 B”。";
  await sendApp(handler, second, "c-second");
  await idle();
  summary();

  const runOf = (channel: string, text: string) => messages.find((m) => m.direction === "in" && m.channel === channel && m.text === text)?.runId;
  const run1 = runOf("wechat", first);
  const run2 = runOf("app", second);
  const outOf = (runId: string | undefined) => messages.filter((m) => m.direction === "out" && m.runId === runId);
  const wechatSent = (re: RegExp) => sent.filter((s) => re.test(s.text)).length;
  const rules: { rule: string; problems: string[] }[] = [];
  const rule = (name: string, problems: string[]) => rules.push({ rule: name, problems });

  const problems1: string[] = [];
  if (!run1 || !run2 || run1 === run2) problems1.push(`runs not found (first=${run1} second=${run2})`);
  if (!outOf(run1).some((m) => m.channel === "wechat")) problems1.push("the WeChat run has no reply event on WeChat");
  if (outOf(run1).some((m) => m.channel !== "wechat")) problems1.push("the WeChat run's output reached the app");
  if (!outOf(run2).some((m) => m.channel === "app" && m.files.some((f) => f.path === "notes/b.md"))) {
    problems1.push("the app run's send_file delivery is not an app file event");
  }
  if (!outOf(run2).some((m) => m.channel === "app" && m.text)) problems1.push("the app run has no reply event on the app");
  if (outOf(run2).some((m) => m.channel !== "app")) problems1.push("the app run's output reached WeChat");
  if (sent.length !== sentBefore) problems1.push(`${sent.length - sentBefore} WeChat send(s) during the app run`);
  if (messages.find((m) => m.direction === "in" && m.text === steer)?.runId !== run1) problems1.push("the app message did not steer the WeChat run");
  rule("1 a run's output goes to the channel of the message that started it", problems1);

  const problems2: string[] = [];
  const wechatAnswer = messages.find((m) => m.direction === "out" && m.channel === "wechat" && /^已切换到 haiku/.test(m.text));
  if (!wechatAnswer || wechatSent(/^已切换到 haiku/) !== 1) problems2.push("/model from WeChat was not answered once on WeChat");
  const appStatus = messages.find((m) => m.direction === "out" && m.channel === "app" && /^模型：/.test(m.text));
  if (!appStatus) problems2.push("/status from the app was not answered on the app");
  if (wechatSent(/^模型：/) !== 0) problems2.push("/status from the app was sent on WeChat");
  rule("2 a command's reply goes to the command's channel", problems2);

  const problems3: string[] = [];
  if (!messages.some((m) => m.direction === "out" && m.channel === "app" && m.text === STEERED)) problems3.push("the app message's acknowledgement is not an app event");
  if (wechatSent(/^收到/) !== 0) problems3.push("an acknowledgement went to WeChat");
  rule("3 the notices a message triggers go to that message's channel", problems3);

  const problems4: string[] = [];
  if (wechatSent(/^仍在处理（/) < 1) problems4.push("no progress note on WeChat for the WeChat run");
  if (messages.some((m) => m.text.includes("仍在处理"))) problems4.push("a progress note was recorded as an event");
  rule("4 progress notes go to WeChat only and are never events", problems4);

  console.log("");
  for (const { rule: name, problems } of rules) {
    console.log(`[${problems.length ? "fail" : "pass"}] rule ${name}${problems.length ? `: ${problems.join("; ")}` : ""}`);
  }
  return rules.filter((r) => r.problems.length).length;
}

/** Polls until `find` returns something; undefined once `ms` have passed. */
async function waitFor<T>(find: () => T | undefined, ms: number): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = find();
    if (found !== undefined || Date.now() > deadline) return found;
    await sleep(250);
  }
}

/** The api scenario: the real handler behind the command API, driven over HTTP only. Returns the number of checks that failed. */
async function api(): Promise<number> {
  const handler = newHandler();
  // A short path: Unix socket paths are limited to about 100 bytes.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alf-"));
  const socket = path.join(dir, "api.sock");
  const closeApi = await startApi({ socket, handler, events: sharedEventLog() });
  let failed = 0;
  const check = (name: string, problems: string[]) => {
    if (problems.length) failed++;
    console.log(`[${problems.length ? "fail" : "pass"}] ${name}${problems.length ? `: ${problems.join("; ")}` : ""}`);
  };

  // A client that follows the stream from the start, as the app does.
  const followed: Event[] = [];
  const stopFollowing = new AbortController();
  const follower = (async () => {
    try {
      for await (const frame of streamEvents(socket, { signal: stopFollowing.signal })) {
        if (!Number.isNaN(frame.id)) followed.push(JSON.parse(frame.data) as Event); // a live event has no id and is not in the log
      }
    } catch (err) {
      if (!stopFollowing.signal.aborted) console.log(`[follower] ended: ${err}`);
    }
  })();
  const post = (command: unknown) => request(socket, "POST", "/commands", command);
  const messageOf = (pick: (m: Message) => boolean) => followed.find((e) => e.type === "message.created" && pick(e.data));
  const runEvent = (runId: string, status: string) => followed.find((e) => e.type === "run.updated" && e.data.id === runId && e.data.status === status);
  const health = async () => JSON.parse((await request(socket, "GET", "/health")).body) as { ok: boolean; lastEventId: number };
  const json = (value: unknown) => JSON.stringify(value);

  try {
    const h = await health();
    check("GET /health answers ok with the last event id", h.ok === true && Number.isInteger(h.lastEventId) ? [] : [`got ${json(h)}`]);

    // The model stays on haiku, as in the other scenarios. The command goes in as an ordinary message.
    console.log(`[app] ${at()} /model haiku`);
    await post({ type: "message.send", clientId: "smoke-model", text: "/model haiku" });
    await waitFor(() => messageOf((m) => m.direction === "out" && m.channel === "app" && /^已切换到 haiku/.test(m.text)), 30_000);

    // A short question and its reply.
    const question = { type: "message.send", clientId: "smoke-question", text: "2 的 10 次方是多少？只回答数字。" };
    console.log(`[app] ${at()} ${question.text}`);
    const accepted = await post(question);
    check("message.send is answered 202 accepted", accepted.status === 202 && accepted.body === json({ accepted: true }) ? [] : [`got ${accepted.status} ${accepted.body}`]);
    const inbound = await waitFor(() => messageOf((m) => m.direction === "in" && m.clientId === "smoke-question"), 30_000);
    const questionRun = inbound?.type === "message.created" ? inbound.data.runId : undefined;
    check(
      "the message is an app event with its client id and the run it started",
      inbound?.type === "message.created" && inbound.data.channel === "app" && questionRun ? [] : ["no such message.created event"],
    );
    const reply = await waitFor(() => messageOf((m) => m.direction === "out" && m.runId === questionRun && m.channel === "app" && m.text !== ""), 180_000);
    check("the reply arrives as a message.created event on the app channel", reply ? [] : ["no reply within 180 s"]);
    await idle();

    // A task that runs for a while, stopped with run.stop.
    const task = {
      type: "message.send",
      clientId: "smoke-task",
      text: "依次用 WebFetch 读这五页：https://en.wikipedia.org/wiki/Rome 、https://en.wikipedia.org/wiki/Paris 、https://en.wikipedia.org/wiki/London 、https://en.wikipedia.org/wiki/Vienna 、https://en.wikipedia.org/wiki/Prague ，每读完一页就把三行历史摘要保存到 notes/ 下以城市命名的 .md 文件里；全部读完后回复“完成”。",
    };
    console.log(`[app] ${at()} ${task.text.slice(0, 40)}…`);
    await post(task);
    const started = await waitFor(() => messageOf((m) => m.direction === "in" && m.clientId === "smoke-task"), 30_000);
    const taskRun = started?.type === "message.created" ? started.data.runId : undefined;
    const running = taskRun ? await waitFor(() => runEvent(taskRun, "running"), 30_000) : undefined;
    await sleep(8000);
    const unknown = await post({ type: "run.stop", runId: "zzzzzz" });
    check(
      "run.stop for an unknown run is answered 404",
      unknown.status === 404 && unknown.body === json({ error: "no live or queued run zzzzzz" }) ? [] : [`got ${unknown.status} ${unknown.body}`],
    );
    const stop = taskRun ? await post({ type: "run.stop", runId: taskRun }) : undefined;
    check(
      "run.stop for the task is answered 202 stopped",
      running && stop?.status === 202 && stop.body === json({ stopped: true }) ? [] : [`run=${taskRun ?? "none"} running=${Boolean(running)} got ${stop?.status} ${stop?.body}`],
    );
    const stopped = taskRun ? await waitFor(() => runEvent(taskRun, "stopped"), 60_000) : undefined;
    check("the stopped run arrives as a run.updated event with status stopped", stopped ? [] : [`no stopped event for run ${taskRun ?? "none"}`]);
    await idle();

    // The same client id again.
    const withClientId = () => followed.filter((e) => e.type === "message.created" && e.data.clientId === "smoke-question").length;
    const before = withClientId();
    const again = await post(question);
    await sleep(1500);
    check(
      "a client id sent again is answered as a duplicate and not submitted",
      again.status === 200 && again.body === json({ accepted: false, duplicate: true }) && withClientId() === before
        ? []
        : [`got ${again.status} ${again.body}; events with that client id ${before} -> ${withClientId()}`],
    );

    // Everything is in the log now. The events the follower got and a reconnect from the middle must match it exactly.
    const last = (await health()).lastEventId;
    const all = sharedEventLog().readSince(0, 100_000);
    await waitFor(() => (followed.at(-1)?.id === last ? true : undefined), 10_000);
    const ids = (events: Event[]) => events.map((e) => e.id).join(",").slice(0, 80);
    check(
      "the stream followed from the start matches the event log, with no gap and no duplicate",
      json(followed) === json(all) ? [] : [`stream ${followed.length} events, log ${all.length}; stream ids ${ids(followed)}`],
    );
    const middle = all[Math.floor(all.length / 2)]?.id ?? 0;
    const resumed: Event[] = [];
    for await (const frame of streamEvents(socket, { lastEventId: middle })) {
      if (Number.isNaN(frame.id)) continue;
      resumed.push(JSON.parse(frame.data) as Event);
      if (frame.id >= last) break;
    }
    const expected = all.filter((e) => e.id > middle);
    check(
      `a reconnect with Last-Event-ID ${middle} receives exactly the events after it`,
      json(resumed) === json(expected) && resumed.every((e, i) => e.id === middle + 1 + i)
        ? []
        : [`got ${resumed.length} events (ids ${ids(resumed)}), the log has ${expected.length} after ${middle}`],
    );
    summary();
  } finally {
    stopFollowing.abort();
    await follower;
    await closeApi();
    await handler.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return failed;
}

/** The stream scenario: live events and the interrupting stop on the real handler, driven over HTTP only. Returns the number of checks that failed. */
async function stream(): Promise<number> {
  // What the handler logs, to tell an interrupted turn from an aborted run.
  const logged: string[] = [];
  for (const name of ["log", "error"] as const) {
    const original = console[name].bind(console);
    console[name] = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
      original(...args);
    };
  }
  const handler = newHandler();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alf-"));
  const socket = path.join(dir, "api.sock");
  const closeApi = await startApi({ socket, handler, events: sharedEventLog() });
  let failed = 0;
  const check = (name: string, problems: string[]) => {
    if (problems.length) failed++;
    console.log(`[${problems.length ? "fail" : "pass"}] ${name}${problems.length ? `: ${problems.join("; ")}` : ""}`);
  };

  // A client that follows the stream from the start, as the app does: durable events by id, live ones as they come.
  const followed: Event[] = [];
  const live: LiveEvent[] = [];
  const stopFollowing = new AbortController();
  const follower = (async () => {
    try {
      for await (const frame of streamEvents(socket, { signal: stopFollowing.signal })) {
        const parsed: unknown = JSON.parse(frame.data);
        if (!Number.isNaN(frame.id)) {
          followed.push(parsed as Event);
          continue;
        }
        const event = LiveEventSchema.safeParse(parsed);
        if (!event.success) {
          console.log(`[follower] a live event that does not parse: ${frame.data.slice(0, 120)}`);
          continue;
        }
        live.push(event.data);
        if (event.data.type === "run.step") {
          const { runId, step } = event.data.data;
          console.log(`[live] ${at()} run.step run=${runId}${step.agent ? ` ${step.agent}` : ""} ${step.tool} ${step.detail.slice(0, 60)}`);
        }
      }
    } catch (err) {
      if (!stopFollowing.signal.aborted) console.log(`[follower] ended: ${err}`);
    }
  })();
  const post = (command: unknown) => request(socket, "POST", "/commands", command);
  const messageOf = (pick: (m: Message) => boolean) => {
    const found = followed.find((e) => e.type === "message.created" && pick(e.data));
    return found?.type === "message.created" ? found.data : undefined;
  };
  const runEvent = (runId: string, status: string) => followed.find((e) => e.type === "run.updated" && e.data.id === runId && e.data.status === status);
  const deltasOf = (runId: string) => live.flatMap((e) => (e.type === "message.delta" && e.data.runId === runId ? [e.data] : []));
  const send = async (clientId: string, text: string): Promise<string | undefined> => {
    console.log(`[app] ${at()} ${text.slice(0, 60)}`);
    await post({ type: "message.send", clientId, text });
    return (await waitFor(() => messageOf((m) => m.direction === "in" && m.clientId === clientId), 30_000))?.runId;
  };

  try {
    // The model stays on haiku, as in the other scenarios.
    await post({ type: "message.send", clientId: "smoke-model", text: "/model haiku" });
    await waitFor(() => messageOf((m) => m.direction === "out" && m.channel === "app" && /^已切换到 haiku/.test(m.text)), 30_000);

    // 1. A question: its reply text streams as message.delta events.
    const questionRun = await send("smoke-question", "用两三句话解释一下为什么天空是蓝色的。");
    const reply = questionRun ? await waitFor(() => messageOf((m) => m.direction === "out" && m.runId === questionRun && m.text !== ""), 180_000) : undefined;
    await sleep(500);
    const deltas = questionRun ? deltasOf(questionRun) : [];
    const lastStream = deltas.at(-1)?.streamId;
    const streamed = deltas.filter((d) => d.streamId === lastStream).map((d) => d.text).join("");
    const streams = new Set(deltas.map((d) => d.streamId));
    console.log(`[stream] ${deltas.length} delta(s) in ${streams.size} stream(s); the last stream ${lastStream ?? "-"} has ${streamed.length} of the reply's ${reply?.text.length ?? 0} characters`);
    check(
      "a question gets message.delta events, and the deltas of the run's last stream, concatenated, equal the start of the reply text",
      !questionRun || !reply
        ? [`no run (${questionRun ?? "none"}) or no reply`]
        : deltas.length === 0
          ? ["no message.delta events"]
          : streamed !== "" && reply.text.startsWith(streamed)
            ? []
            : [`the last stream's text ${JSON.stringify(streamed.slice(0, 60))} is not the start of the reply ${JSON.stringify(reply.text.slice(0, 60))}`],
    );
    await idle();

    // 2. A longer task, stopped with run.stop after its first step.
    const task =
      "依次用 WebFetch 读这五页：https://en.wikipedia.org/wiki/Rome 、https://en.wikipedia.org/wiki/Paris 、https://en.wikipedia.org/wiki/London 、https://en.wikipedia.org/wiki/Vienna 、https://en.wikipedia.org/wiki/Prague ，每读完一页就把三行历史摘要保存到 notes/ 下以城市命名的 .md 文件里；全部读完后回复“完成”。";
    const taskRun = await send("smoke-task", task);
    const step = taskRun ? await waitFor(() => live.find((e) => e.type === "run.step" && e.data.runId === taskRun), 120_000) : undefined;
    const stopAt = followed.length;
    const stop = taskRun && step ? await post({ type: "run.stop", runId: taskRun }) : undefined;
    const stopReply = await waitFor(() => messageOf((m) => m.direction === "out" && m.channel === "app" && m.text === "已停止当前任务。"), 30_000);
    const stopped = taskRun ? await waitFor(() => runEvent(taskRun, "stopped"), 60_000) : undefined;
    await sleep(5000);
    const after = followed.slice(stopAt).flatMap((e) => (e.type === "message.created" && e.data.direction === "out" ? [e.data] : []));
    const taskOut = followed.flatMap((e) => (e.type === "message.created" && e.data.direction === "out" && e.data.runId === taskRun ? [e.data] : []));
    check(
      "a longer task is stopped with run.stop after its first run.step: the stop reply arrives",
      !taskRun || !step
        ? [`no run (${taskRun ?? "none"}) or no run.step within 120 s`]
        : stop?.status === 202 && stopReply
          ? []
          : [`run.stop answered ${stop?.status} ${stop?.body}; stop reply ${stopReply ? "arrived" : "missing"}`],
    );
    check("no error reply follows the stop", [
      ...after.filter((m) => /执行出错|出错了/.test(m.text)).map((m) => `error line "${m.text.slice(0, 60)}"`),
      ...taskOut.map((m) => `a reply of the stopped run: "${m.text.slice(0, 60)}"`),
    ]);
    check("the run ends stopped", stopped ? [] : [`no stopped event for run ${taskRun ?? "none"}`]);
    const interrupted = logged.some((l) => l.includes(`agent turn done run=${taskRun}`) && l.includes("(interrupted)"));
    const aborted = logged.some((l) => l.includes(`run ${taskRun}:`) && l.includes("aborting the run"));
    check("it was the turn that was interrupted, not the run that was aborted", [
      ...(interrupted ? [] : ["no interrupted result in the log"]),
      ...(aborted ? ["the abort fallback fired"] : []),
    ]);
    await idle();

    // 3. The next message starts a new turn in the same session and is answered.
    const nextRun = await send("smoke-next", "刚才的任务已经停了，不用管它。现在只回答：2 的 5 次方是多少？");
    const answer = nextRun ? await waitFor(() => messageOf((m) => m.direction === "out" && m.runId === nextRun && m.text !== ""), 180_000) : undefined;
    await idle();
    const sessionOf = (id: string | undefined) => listRunFiles().find((f) => f.id === id)?.sessionId;
    check(
      "a message sent after that starts a new turn in the same session and is answered",
      !taskRun || !nextRun || !answer
        ? [`no run (${nextRun ?? "none"}) or no answer`]
        : /出错/.test(answer.text)
          ? [`the answer is an error: ${answer.text.slice(0, 80)}`]
          : sessionOf(nextRun) && sessionOf(nextRun) === sessionOf(taskRun)
            ? []
            : [`sessions differ: stopped run ${sessionOf(taskRun) ?? "-"}, new run ${sessionOf(nextRun) ?? "-"}`],
    );
    summary();
    const tasks = listRunFiles().filter((f) => f.kind === "task");
    console.log(`[spend] $${tasks.reduce((sum, f) => sum + f.costUsd, 0).toFixed(4)} across ${tasks.length} run(s)`);
  } finally {
    stopFollowing.abort();
    await follower;
    await closeApi();
    await handler.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return failed;
}

let failedRules = 0;
if (scenario === "background") {
  const handler = newHandler();
  await send(handler, "/model haiku");
  await send(
    handler,
    "用 collector 子代理在后台分别读这三页：https://en.wikipedia.org/wiki/Rome 、https://en.wikipedia.org/wiki/Paris 、https://en.wikipedia.org/wiki/London ，每页写三行历史摘要，分别存到 notes/rome.md、notes/paris.md、notes/london.md。三个一起派出去，派完先回我一句。",
  );
  await sleep(15_000);
  await send(handler, "/status");
  await send(handler, "顺便问一下，2 的 10 次方是多少？");
  await idle();
  summary();
} else if (scenario === "restart") {
  const first = newHandler();
  await send(first, "/model haiku");
  await send(first, "用一个 collector 子代理在后台读 https://en.wikipedia.org/wiki/Berlin 并写三行摘要到 notes/berlin.md，派出去后回我一句。");
  for (let i = 0; i < 30 && !listRunFiles().some((f) => f.kind === "subagent" && f.status === "running"); i++) await sleep(1000);
  console.log(`[shutdown] ${at()} with ${listRunFiles().filter((f) => f.status === "running").length} live run(s)`);
  await first.shutdown();
  console.log(`[shutdown] ${at()} done`);
  summary();
  const second = newHandler();
  await send(second, "/status");
  summary();
} else if (scenario === "undelivered") {
  const handler = newHandler();
  await send(handler, "/model haiku");
  failSends = true;
  await send(handler, "在 notes/hello.md 里写一行“你好”，然后回复“写好了”。");
  await idle();
  failSends = false;
  await send(handler, "/status");
  summary();
} else if (scenario === "stop") {
  const handler = newHandler();
  await send(handler, "/model haiku");
  await send(
    handler,
    "用两个 collector 子代理在后台分别读 https://en.wikipedia.org/wiki/Vienna 和 https://en.wikipedia.org/wiki/Prague ，各写三行摘要到 notes/vienna.md 和 notes/prague.md，派出去后回我一句。",
  );
  let target: string | undefined;
  for (let i = 0; i < 30 && !target; i++) {
    await sleep(1000);
    target = listRunFiles().find((f) => f.kind === "subagent" && f.status === "running")?.id;
  }
  if (!target) throw new Error("no background subagent started");
  await send(handler, `/stop ${target}`);
  await send(handler, "/status");
  await idle();
  summary();
} else if (scenario === "nested") {
  const handler = newHandler();
  await send(handler, "/model haiku");
  await send(
    handler,
    "这是测试。用 Agent 工具启动一个 general-purpose 子代理，前台运行（run_in_background: false）。给它的 brief：用 Agent 工具在后台（run_in_background: true）派出三个 collector 子代理，分别读 https://en.wikipedia.org/wiki/Rome 、https://en.wikipedia.org/wiki/Paris 、https://en.wikipedia.org/wiki/London ，每页写三行历史摘要到 notes/rome.md、notes/paris.md、notes/london.md；三个都派出后就结束，报告每个调用的结果。它结束后回我一句。",
  );
  await sleep(20_000);
  await send(handler, "/status");
  await idle();
  summary();
} else if (scenario === "prompt" && process.argv[3]) {
  const handler = newHandler();
  await send(handler, process.argv[3]);
  await idle();
  summary();
} else if (scenario === "channels") {
  failedRules = await channels();
} else if (scenario === "api") {
  failedRules = await api();
} else if (scenario === "stream") {
  failedRules = await stream();
} else {
  console.error("usage: node scripts/handler-smoke.ts background|restart|undelivered|stop|nested|channels|api|stream|prompt <text>");
  process.exit(2);
}
process.exit(failedRules ? 1 : 0);
