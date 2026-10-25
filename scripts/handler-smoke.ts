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
//   prompt <text>  one message on the default model, then the spend per model
// Every WeChat send and every message event is printed as it happens.

import type { Message } from "../src/api/schema.ts";
import { createAgentHandler } from "../src/agent/handler.ts";
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
} else {
  console.error("usage: node scripts/handler-smoke.ts background|restart|undelivered|stop|nested|channels|prompt <text>");
  process.exit(2);
}
process.exit(failedRules ? 1 : 0);
