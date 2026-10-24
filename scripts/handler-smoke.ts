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
//   prompt <text>  one message on the default model, then the spend per model

import { createAgentHandler } from "../src/agent/handler.ts";
import type { BotContext } from "../src/bot.ts";
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
}

async function send(handler: ReturnType<typeof createAgentHandler>, text: string): Promise<void> {
  console.log(`[owner] ${at()} ${text}`);
  await handler(ctx, message(text));
}

if (scenario === "background") {
  const handler = createAgentHandler();
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
  const first = createAgentHandler();
  await send(first, "/model haiku");
  await send(first, "用一个 collector 子代理在后台读 https://en.wikipedia.org/wiki/Berlin 并写三行摘要到 notes/berlin.md，派出去后回我一句。");
  for (let i = 0; i < 30 && !listRunFiles().some((f) => f.kind === "subagent" && f.status === "running"); i++) await sleep(1000);
  console.log(`[shutdown] ${at()} with ${listRunFiles().filter((f) => f.status === "running").length} live run(s)`);
  await first.shutdown?.();
  console.log(`[shutdown] ${at()} done`);
  summary();
  const second = createAgentHandler();
  await send(second, "/status");
  summary();
} else if (scenario === "undelivered") {
  const handler = createAgentHandler();
  await send(handler, "/model haiku");
  failSends = true;
  await send(handler, "在 notes/hello.md 里写一行“你好”，然后回复“写好了”。");
  await idle();
  failSends = false;
  await send(handler, "/status");
  summary();
} else if (scenario === "stop") {
  const handler = createAgentHandler();
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
  const handler = createAgentHandler();
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
  const handler = createAgentHandler();
  await send(handler, process.argv[3]);
  await idle();
  summary();
  for (const f of listRunFiles().filter((r) => r.kind === "task")) {
    console.log(`[models] ${f.id} ${Object.entries(f.modelCostUsd ?? {}).map(([m, c]) => `${m} $${c.toFixed(4)}`).join(", ")}`);
  }
} else {
  console.error("usage: node scripts/handler-smoke.ts background|restart|undelivered|stop|nested|prompt <text>");
  process.exit(2);
}
process.exit(0);
