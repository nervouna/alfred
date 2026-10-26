// Drives the real message handler on the app channel, through the command API on a
// socket in a temp dir, the way the app does: a scenario posts messages on a schedule,
// and every message event (the reply to the owner) is printed as it is appended. Point
// ALFRED_WORKSPACE and ALFRED_STATE_DIR at scratch directories.
// usage: node scripts/handler-smoke.ts <scenario>
//   background   three parallel collectors (two run, one queues), /status and a
//                quick question while they run, one reviewed reply per run
//   restart      a shutdown while a background subagent runs, then a new handler
//                and a message that gets the lost-runs note
//   stop         two background collectors, then /stop <run id> for one of them
//   nested       a foreground general-purpose subagent starts three background
//                collectors: nested calls share the slot cap
//   api          the real handler behind the command API on a socket in a temp dir, driven over
//                HTTP only: a question and its reply, a task stopped with run.stop, a duplicate
//                client id and a reconnect with Last-Event-ID; ends with one pass or fail line
//                per check
//   stream       the real handler behind the command API on a temp socket, driven over HTTP: a
//                question streams its reply as message.delta events, a longer task is stopped with
//                run.stop after its first run.step (an interrupt: the stop reply, no error reply,
//                the run ends stopped), and the next message starts a new turn in the same
//                session; ends with one pass or fail line per check and the spend
//   attach       the real handler behind the command API on a temp socket, driven over HTTP: a
//                text file with a made-up word is uploaded into the inbox, a message names it and
//                asks for the word (the reply must contain it, and the message event lists the
//                file), and a message naming a file never uploaded gets 400; ends with one pass or
//                fail line per check and the spend
//   ask          the real handler behind the command API on a temp socket, driven over HTTP: the agent
//                asks a question (a question.asked event), a question.answer with one label gets a reply
//                naming it (a key that is no question's text is 400, an unknown question 404); a question
//                answered with a plain message.send gets a reply using the text; run.stop with a question
//                open records it as cancelled and the run ends stopped; ends with one pass or fail line
//                per check and the spend
//   prompt <text>  one message on the default model, then the spend per model

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { LiveEventSchema } from "../src/api/schema.ts";
import type { Event, LiveEvent, Message } from "../src/api/schema.ts";
import { createAgentHandler } from "../src/agent/handler.ts";
import { request, streamEvents } from "../src/api/client.ts";
import { startApi } from "../src/api/server.ts";
import { sharedEventLog } from "../src/events.ts";
import { listRunFiles } from "../src/runs.ts";
import { createLocalHandler } from "./local-stack.ts";

const scenario = process.argv[2] ?? "";
const t0 = Date.now();
const at = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

const flat = (text: string) => text.replace(/\n/g, " ⏎ ");

/** Every message event as it is appended: who said it, in which direction, and for which run. */
sharedEventLog().subscribe((event) => {
  if (event.type !== "message.created") return;
  const m = event.data;
  const files = m.files.length ? ` files=${m.files.map((f) => f.path).join(",")}` : "";
  const error = m.error ? ` error="${m.error.slice(0, 60)}"` : "";
  console.log(`[event] ${at()} ${m.channel} ${m.direction} run=${m.runId ?? "-"}${files}${error} ${flat(m.text).slice(0, 80)}`);
});

type Handler = ReturnType<typeof createAgentHandler>;

function newHandler(): Handler {
  return createLocalHandler();
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
      `  ${f.id} ${f.kind}${f.role ? `/${f.role}` : ""} ${f.status} parent=${f.parentRunId ?? "-"} ${cost} steps=${f.steps.length} files=${f.files.map((x) => x.path).join(",") || "-"} "${f.title}"`,
    );
  }
  for (const f of listRunFiles().filter((r) => r.kind === "task")) {
    console.log(`[models] ${f.id} ${Object.entries(f.modelCostUsd ?? {}).map(([m, c]) => `${m} $${c.toFixed(4)}`).join(", ")}`);
  }
}

/** A handler behind the command API on a socket in a temp dir, as `run` serves it; `send` posts a message the way the app does. */
async function startStack() {
  const handler = newHandler();
  // A short path: Unix socket paths are limited to about 100 bytes.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alf-"));
  const socket = path.join(dir, "api.sock");
  const closeApi = await startApi({ socket, handler, events: sharedEventLog() });
  let sent = 0;
  return {
    async send(text: string): Promise<void> {
      console.log(`[app] ${at()} ${text}`);
      const answer = await request(socket, "POST", "/commands", { type: "message.send", clientId: `smoke-${++sent}`, text });
      if (answer.status !== 202) throw new Error(`message.send answered ${answer.status} ${answer.body}`);
    },
    /** The API closes first, then the handler stops its runs, as at a shutdown. */
    async stop(): Promise<void> {
      await closeApi();
      await handler.shutdown();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
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

/** The attach scenario: an upload, a message that names it, and a message that names a file never uploaded. Returns the number of checks that failed. */
async function attach(): Promise<number> {
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
  const json = (value: unknown) => JSON.stringify(value);

  try {
    // The model stays on haiku, as in the other scenarios.
    console.log(`[app] ${at()} /model haiku`);
    await post({ type: "message.send", clientId: "smoke-model", text: "/model haiku" });
    await waitFor(() => messageOf((m) => m.direction === "out" && m.channel === "app" && /^已切换到 haiku/.test(m.text)), 30_000);

    // A text file with a made-up word that only the file holds.
    const word = "quorvantle-4217";
    const name = "attach-smoke.txt";
    console.log(`[app] ${at()} upload ${name}`);
    const uploaded = await request(socket, "POST", `/uploads?name=${encodeURIComponent(name)}`, Buffer.from(`这个文件里的暗号是 ${word}。\n`, "utf8"));
    const uploadedPath = (JSON.parse(uploaded.body) as { file?: { path?: string } }).file?.path ?? "";
    check(
      "the upload is answered 201 with a file in the inbox",
      uploaded.status === 201 && uploadedPath.startsWith("inbox/") ? [] : [`got ${uploaded.status} ${uploaded.body}`],
    );

    // A message that names the file and asks for the word.
    const question = {
      type: "message.send",
      clientId: "smoke-attach",
      text: "读一下附件，告诉我文件里的暗号，只回答那个暗号。",
      files: [{ path: uploadedPath }],
    };
    console.log(`[app] ${at()} ${question.text} files=${uploadedPath}`);
    const accepted = await post(question);
    check("the message naming the file is answered 202", accepted.status === 202 ? [] : [`got ${accepted.status} ${accepted.body}`]);
    const inbound = await waitFor(() => messageOf((m) => m.direction === "in" && m.clientId === "smoke-attach"), 30_000);
    const runId = inbound?.type === "message.created" ? inbound.data.runId : undefined;
    check(
      "the message event lists the uploaded file and the run it started",
      inbound?.type === "message.created" && inbound.data.channel === "app" && inbound.data.files.some((f) => f.path === uploadedPath) && runId
        ? []
        : ["no such message.created event"],
    );
    const reply = await waitFor(() => messageOf((m) => m.direction === "out" && m.runId === runId && m.channel === "app" && m.text.includes(word)), 180_000);
    check("the reply contains the word that only the file holds", reply ? [] : [`no reply with ${word} within 180 s`]);
    await idle();

    // A message that names a file no upload made: refused before anything is submitted.
    const never = { type: "message.send", clientId: "smoke-never", text: "看看这个", files: [{ path: "inbox/1999-01-01/never-uploaded.txt" }] };
    const refused = await post(never);
    check(
      "a message naming a file that was never uploaded is answered 400, and no event is recorded for it",
      refused.status === 400 && refused.body === json({ error: "files.0.path: no such file in the inbox" }) && !messageOf((m) => m.clientId === "smoke-never")
        ? []
        : [`got ${refused.status} ${refused.body}`],
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


/** The ask scenario: structured questions on the real handler, driven over HTTP only. Returns the number of checks that failed. */
async function ask(): Promise<number> {
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
        if (Number.isNaN(frame.id)) continue; // a live event has no id and is not in the log
        const event = JSON.parse(frame.data) as Event;
        followed.push(event);
        if (event.type === "question.asked") console.log(`[question] ${at()} ${event.data.id} run=${event.data.runId} ${event.data.questions.map((q) => q.question).join(" / ")}`);
        if (event.type === "question.answered") console.log(`[answered] ${at()} ${event.data.id} ${event.data.cancelled ? "cancelled" : JSON.stringify(event.data.answers)}`);
      }
    } catch (err) {
      if (!stopFollowing.signal.aborted) console.log(`[follower] ended: ${err}`);
    }
  })();
  const post = (command: unknown) => request(socket, "POST", "/commands", command);
  const json = (value: unknown) => JSON.stringify(value);
  const messageOf = (pick: (m: Message) => boolean) => {
    const found = followed.find((e) => e.type === "message.created" && pick(e.data));
    return found?.type === "message.created" ? found.data : undefined;
  };
  const askedOf = (runId: string | undefined) => {
    const found = followed.find((e) => e.type === "question.asked" && e.data.runId === runId);
    return found?.type === "question.asked" ? found.data : undefined;
  };
  const answeredOf = (id: string) => {
    const found = followed.find((e) => e.type === "question.answered" && e.data.id === id);
    return found?.type === "question.answered" ? found.data : undefined;
  };
  const runEvent = (runId: string, status: string) => followed.find((e) => e.type === "run.updated" && e.data.id === runId && e.data.status === status);
  /** Sends a message and waits for the run it started and for the question that run asks. */
  const sendAndWaitForQuestion = async (clientId: string, text: string) => {
    console.log(`[app] ${at()} ${text.slice(0, 70)}`);
    await post({ type: "message.send", clientId, text });
    const runId = (await waitFor(() => messageOf((m) => m.direction === "in" && m.clientId === clientId), 30_000))?.runId;
    const asked = runId ? await waitFor(() => askedOf(runId), 120_000) : undefined;
    return { runId, asked };
  };

  try {
    // The model stays on haiku, as in the other scenarios.
    console.log(`[app] ${at()} /model haiku`);
    await post({ type: "message.send", clientId: "smoke-model", text: "/model haiku" });
    await waitFor(() => messageOf((m) => m.direction === "out" && m.channel === "app" && /^已切换到 haiku/.test(m.text)), 30_000);

    // 1. The agent asks; the answer comes by question.answer with one label.
    const first = await sendAndWaitForQuestion(
      "smoke-ask-1",
      "封面要用一个代号，我自己定不了。请用 AskUserQuestion 工具问我，选项的 label 分别是 Maple、Cedar、Birch（各配一句说明）。拿到我的答案后，只回复一句话，里面要有我选的那个代号。",
    );
    const q1 = first.asked?.questions[0];
    check(
      "the agent asks: a question.asked event arrives with the run's id, one question and its options",
      first.asked && q1 && first.asked.questions.length === 1 && q1.options.length >= 2 && q1.options.length <= 4
        ? []
        : [`run=${first.runId ?? "none"} asked=${json(first.asked)?.slice(0, 160)}`],
    );
    if (first.asked && q1) {
      const label = q1.options.find((o) => /cedar/i.test(o.label))?.label ?? q1.options[1]?.label ?? "";
      const stray = await post({ type: "question.answer", questionId: first.asked.id, answers: { "不是这个问题的原文": label } });
      check(
        "a key that is not one of the question's texts is answered 400, and the question stays open",
        stray.status === 400 && !answeredOf(first.asked.id) ? [] : [`got ${stray.status} ${stray.body}; answered=${Boolean(answeredOf(first.asked.id))}`],
      );
      const unknown = await post({ type: "question.answer", questionId: "q-unknown", answers: { [q1.question]: label } });
      check(
        "question.answer for a question that is not open is answered 404",
        unknown.status === 404 && unknown.body === json({ error: "no open question q-unknown" }) ? [] : [`got ${unknown.status} ${unknown.body}`],
      );
      const answer = await post({ type: "question.answer", questionId: first.asked.id, answers: { [q1.question]: label } });
      check("question.answer with one label is answered 202", answer.status === 202 && answer.body === json({ answered: true }) ? [] : [`got ${answer.status} ${answer.body}`]);
      const answered = await waitFor(() => answeredOf(first.asked?.id ?? ""), 30_000);
      check(
        "a question.answered event records the label against the question's text",
        answered && !answered.cancelled && answered.answers[q1.question] === label ? [] : [`got ${json(answered)}`],
      );
      const reply = await waitFor(() => messageOf((m) => m.direction === "out" && m.runId === first.runId && m.channel === "app" && m.text.includes(label)), 180_000);
      check("the reply names the label that was chosen", reply ? [] : [`no reply containing ${label} within 180 s`]);
    }
    await idle();

    // 2. The next question is answered by a plain message.
    const word = "quorvantle-4217";
    const second = await sendAndWaitForQuestion(
      "smoke-ask-2",
      "摘要的口吻我定不了。请用 AskUserQuestion 工具问我，选项的 label 是“正式”和“轻松”（各配一句说明）。拿到我的答案后，只回复一句话，原样包含我给你的答案原文。",
    );
    if (!second.asked) {
      check("a question answered with a plain message.send gets a reply that uses the text", [`run=${second.runId ?? "none"} asked nothing`]);
    } else {
      console.log(`[app] ${at()} ${word}`);
      await post({ type: "message.send", clientId: "smoke-answer", text: word });
      const answered = await waitFor(() => answeredOf(second.asked?.id ?? ""), 30_000);
      const inbound = messageOf((m) => m.direction === "in" && m.clientId === "smoke-answer");
      const reply = await waitFor(() => messageOf((m) => m.direction === "out" && m.runId === second.runId && m.channel === "app" && m.text.includes(word)), 180_000);
      const problems: string[] = [];
      if (!answered || Object.values(answered.answers).join("") !== word) problems.push(`question.answered ${json(answered)}`);
      if (inbound?.runId !== second.runId) problems.push(`the message is recorded with run ${inbound?.runId ?? "none"}, not ${second.runId}`);
      if (messageOf((m) => m.direction === "out" && m.text === "收到，会在当前步骤结束后转给 Alfred。")) problems.push("the answer was also acknowledged as a follow-up");
      if (!reply) problems.push(`no reply containing ${word} within 180 s`);
      check("a question answered with a plain message.send gets a reply that uses the text", problems);
    }
    await idle();

    // 3. run.stop with a question open cancels it.
    const third = await sendAndWaitForQuestion(
      "smoke-ask-3",
      "标题我定不了。请用 AskUserQuestion 工具问我，选项的 label 是“长”和“短”（各配一句说明）。拿到答案之前什么都不要做。",
    );
    if (!third.runId || !third.asked) {
      check("run.stop with a question open records it as cancelled, and the run ends stopped", [`run=${third.runId ?? "none"} asked nothing`]);
    } else {
      const stop = await post({ type: "run.stop", runId: third.runId });
      const cancelled = await waitFor(() => answeredOf(third.asked?.id ?? ""), 30_000);
      const stopped = await waitFor(() => runEvent(third.runId ?? "", "stopped"), 60_000);
      const errors = followed.flatMap((e) => (e.type === "message.created" && e.data.direction === "out" && e.data.runId === third.runId && /执行出错|出错了/.test(e.data.text) ? [e.data.text] : []));
      const problems: string[] = [];
      if (stop.status !== 202) problems.push(`run.stop answered ${stop.status} ${stop.body}`);
      if (!cancelled?.cancelled || Object.keys(cancelled.answers).length > 0) problems.push(`question.answered ${json(cancelled)}`);
      if (!stopped) problems.push("no stopped run.updated event");
      if (errors.length) problems.push(`error reply "${errors[0]?.slice(0, 60)}"`);
      check("run.stop with a question open records it as cancelled, and the run ends stopped", problems);
      const late = await post({ type: "question.answer", questionId: third.asked.id, answers: { [third.asked.questions[0]?.question ?? ""]: "长" } });
      check("a cancelled question is closed: question.answer for it is answered 404", late.status === 404 ? [] : [`got ${late.status} ${late.body}`]);
    }
    await idle();
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
  const stack = await startStack();
  await stack.send("/model haiku");
  await stack.send(
    "用 collector 子代理在后台分别读这三页：https://en.wikipedia.org/wiki/Rome 、https://en.wikipedia.org/wiki/Paris 、https://en.wikipedia.org/wiki/London ，每页写三行历史摘要，分别存到 notes/rome.md、notes/paris.md、notes/london.md。三个一起派出去，派完先回我一句。",
  );
  await sleep(15_000);
  await stack.send("/status");
  await stack.send("顺便问一下，2 的 10 次方是多少？");
  await idle();
  summary();
  await stack.stop();
} else if (scenario === "restart") {
  const first = await startStack();
  await first.send("/model haiku");
  await first.send("用一个 collector 子代理在后台读 https://en.wikipedia.org/wiki/Berlin 并写三行摘要到 notes/berlin.md，派出去后回我一句。");
  for (let i = 0; i < 30 && !listRunFiles().some((f) => f.kind === "subagent" && f.status === "running"); i++) await sleep(1000);
  console.log(`[shutdown] ${at()} with ${listRunFiles().filter((f) => f.status === "running").length} live run(s)`);
  await first.stop();
  console.log(`[shutdown] ${at()} done`);
  summary();
  const second = await startStack();
  await second.send("/status");
  await sleep(2000);
  summary();
  await second.stop();
} else if (scenario === "stop") {
  const stack = await startStack();
  await stack.send("/model haiku");
  await stack.send(
    "用两个 collector 子代理在后台分别读 https://en.wikipedia.org/wiki/Vienna 和 https://en.wikipedia.org/wiki/Prague ，各写三行摘要到 notes/vienna.md 和 notes/prague.md，派出去后回我一句。",
  );
  let target: string | undefined;
  for (let i = 0; i < 30 && !target; i++) {
    await sleep(1000);
    target = listRunFiles().find((f) => f.kind === "subagent" && f.status === "running")?.id;
  }
  if (!target) throw new Error("no background subagent started");
  await stack.send(`/stop ${target}`);
  await stack.send("/status");
  await idle();
  summary();
  await stack.stop();
} else if (scenario === "nested") {
  const stack = await startStack();
  await stack.send("/model haiku");
  await stack.send(
    "这是测试。用 Agent 工具启动一个 general-purpose 子代理，前台运行（run_in_background: false）。给它的 brief：用 Agent 工具在后台（run_in_background: true）派出三个 collector 子代理，分别读 https://en.wikipedia.org/wiki/Rome 、https://en.wikipedia.org/wiki/Paris 、https://en.wikipedia.org/wiki/London ，每页写三行历史摘要到 notes/rome.md、notes/paris.md、notes/london.md；三个都派出后就结束，报告每个调用的结果。它结束后回我一句。",
  );
  await sleep(20_000);
  await stack.send("/status");
  await idle();
  summary();
  await stack.stop();
} else if (scenario === "prompt" && process.argv[3]) {
  const stack = await startStack();
  await stack.send(process.argv[3]);
  await idle();
  summary();
  await stack.stop();
} else if (scenario === "api") {
  failedRules = await api();
} else if (scenario === "stream") {
  failedRules = await stream();
} else if (scenario === "attach") {
  failedRules = await attach();
} else if (scenario === "ask") {
  failedRules = await ask();
} else {
  console.error("usage: node scripts/handler-smoke.ts background|restart|stop|nested|api|stream|attach|ask|prompt <text>");
  process.exit(2);
}
process.exit(failedRules ? 1 : 0);
