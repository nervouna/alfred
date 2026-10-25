// The bot, the WeChat channel and the agent handler wired as `run` wires them, on a fake iLink server and a fake agent.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

// store.ts and config.ts read these at import time, so set them before loading the modules under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-bot-")));
Object.assign(process.env, {
  ALFRED_WORKSPACE: path.join(tmp, "workspace"),
  ALFRED_STATE_DIR: path.join(tmp, "state"),
  ALFRED_ANTHROPIC_API_KEY: "sk-test",
  ALFRED_MEMORY_SCAN_MINUTES: "0",
  ALFRED_WORKBENCH: "",
  ALFRED_WORKBENCH_URL: "",
});

const OWNER = "owner@im.wechat";

interface Call {
  path: string;
  body: Record<string, unknown>;
}

/** An iLink server that delivers the given messages once and then has nothing more to say. */
function fakeIlink(messages: unknown[]) {
  const calls: Call[] = [];
  let delivered = false;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = req.url ?? "";
      calls.push({ path: url, body: raw ? JSON.parse(raw) : {} });
      const respond = (body: object) => res.end(JSON.stringify({ ret: 0, ...body }));
      if (url.endsWith("/getupdates")) {
        if (delivered) return void setTimeout(() => respond({ msgs: [], get_updates_buf: "c2" }), 50);
        delivered = true;
        return respond({ msgs: messages, get_updates_buf: "c1" });
      }
      respond(url.endsWith("/getconfig") ? { typing_ticket: "ticket" } : {});
    });
  });
  return { server, calls };
}

const owner = (text: string, extra: object = {}) => ({
  from_user_id: OWNER,
  message_type: 1,
  context_token: "ctx-1",
  item_list: [{ type: 1, text_item: { text } }],
  ...extra,
});

function fakeQuery(): typeof query {
  return ((params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => {
    async function* messages() {
      for await (const message of params.prompt) {
        yield { type: "system", subtype: "init", session_id: "sess-1" };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: `echo: ${String(message.message.content)}`,
          num_turns: 1,
          total_cost_usd: 0,
          modelUsage: {},
          session_id: "sess-1",
          user_message_uuid: message.uuid,
        };
      }
    }
    return Object.assign(messages(), { stopTask: async () => {}, setModel: async () => {} });
  }) as unknown as typeof query;
}

const until = async (what: string, done: () => boolean, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

const ilink = fakeIlink([
  owner("你好"),
  { ...owner("陌生人的消息"), from_user_id: "stranger@im.wechat" },
  { ...owner("群消息"), group_id: "group-1" },
  { ...owner("Alfred 自己发的"), message_type: 2 },
]);
await new Promise<void>((resolve) => ilink.server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${(ilink.server.address() as AddressInfo).port}`;
fs.mkdirSync(path.join(tmp, "state"), { recursive: true });
fs.writeFileSync(
  path.join(tmp, "state", "account.json"),
  JSON.stringify({ botToken: "bot-token", botId: "b@im.bot", baseUrl, ownerUserId: OWNER, loggedInAt: new Date().toISOString() }),
);
// The test has stopped the bot and the agent by now (see its t.after), so nothing is left to talk to the server or use the directory.
after(async () => {
  await new Promise<void>((resolve) => {
    ilink.server.close(() => resolve());
    ilink.server.closeAllConnections();
  });
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("a WeChat message long-polled by the bot gets its reply on WeChat, and both are events; the app channel shares the timeline", async (t) => {
  const { createBotContext, runBot } = await import("../bot.ts");
  const { appOutbound } = await import("../channels.ts");
  const { WeChatChannel, wechatHandler } = await import("./wechat.ts");
  const { createAgentHandler } = await import("../agent/handler.ts");
  const { EventLog } = await import("../events.ts");

  const events = new EventLog(path.join(tmp, "events", "test.jsonl"));
  const ctx = createBotContext();
  const wechat = new WeChatChannel(ctx);
  const agent = createAgentHandler({
    owner: ctx.account.ownerUserId,
    channels: { wechat: wechat.outbound(OWNER), app: appOutbound() },
    events,
    runQuery: fakeQuery(),
  });
  const stop = new AbortController();
  const bot = runBot(ctx, wechatHandler(wechat, agent), stop.signal);
  // Whether the assertions below pass or not, the bot stops polling and the agent shuts down before the server and the directory go.
  t.after(async () => {
    stop.abort();
    try {
      await bot;
    } finally {
      await agent.shutdown();
    }
  });

  const sends = () => ilink.calls.filter((c) => c.path.endsWith("/sendmessage"));
  const messages = () => events.readSince(0).flatMap((e) => (e.type === "message.created" ? [e.data] : []));
  const finishedTasks = () => events.readSince(0).filter((e) => e.type === "run.updated" && e.data.kind === "task" && e.data.status === "done").length;

  // The reply is an event once WeChat has taken it, which is a moment after the fake server has seen it.
  await until("the reply", () => messages().some((m) => m.channel === "wechat" && m.direction === "out"));
  assert.equal(sends().length, 1);
  const [send] = sends();
  const msg = send?.body.msg as { to_user_id: string; context_token: string; item_list: { text_item: { text: string } }[] };
  assert.equal(msg.to_user_id, OWNER);
  assert.equal(msg.context_token, "ctx-1", "the reply carries the context token of the owner's message");
  assert.equal(msg.item_list[0]?.text_item.text, "echo: 你好");

  // A message from the app joins the same timeline and the same session, and is answered on the app channel only.
  // It is sent once the first run is over: while that run winds down, the message would be queued behind it and acknowledged, not answered.
  await until("the first run to finish", () => finishedTasks() === 1);
  await agent.submit({ channel: "app", text: "来自 app", files: [], clientId: "c-1" });
  await until("the app run to finish", () => finishedTasks() === 2);
  assert.equal(sends().length, 1, "nothing more went to WeChat");

  const timeline = messages().map((m) => [m.channel, m.direction, m.text]);
  assert.deepEqual(timeline, [
    ["wechat", "in", "你好"],
    ["wechat", "out", "echo: 你好"],
    ["app", "in", "来自 app"],
    ["app", "out", "echo: 来自 app"],
  ]);

  stop.abort();
  await bot;
  assert.ok(ilink.calls.some((c) => c.path.endsWith("/notifystop")), "the bot says goodbye after the handler shut down");
});
