// The handler on fake channels and a fake agent: no model is called, nothing is sent anywhere.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import type { Channel, Message, Run } from "../api/schema.ts";
import type { Inbound, Outbound } from "../channels.ts";

// store.ts and config.ts read these at import time, so set them before loading the modules under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-handler-")));
Object.assign(process.env, {
  ALFRED_WORKSPACE: path.join(tmp, "workspace"),
  ALFRED_STATE_DIR: path.join(tmp, "state"),
  ALFRED_ANTHROPIC_API_KEY: "sk-test",
  ALFRED_MEMORY_SCAN_MINUTES: "0",
  ALFRED_WORKBENCH: "",
  ALFRED_WORKBENCH_URL: "",
});

const { createAgentHandler } = await import("./handler.ts");
const { EventLog } = await import("../events.ts");
const { appOutbound } = await import("../channels.ts");

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups) await cleanup();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(what: string, done: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** A turn of the fake agent that ends when the test says so, or when the run is aborted. */
function held() {
  const waiting: ((text: string) => void)[] = [];
  return {
    turn: (_prompt: string, signal: AbortSignal) =>
      new Promise<string>((resolve, reject) => {
        waiting.push(resolve);
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    get waiting() {
      return waiting.length;
    },
    release: (text: string) => waiting.shift()?.(text),
  };
}

/** Stands in for the SDK's query(): answers every message of the task's input with one result. */
function fakeAgent(turn: (prompt: string, signal: AbortSignal) => Promise<string> = async (prompt) => `echo: ${prompt}`) {
  const prompts: string[] = [];
  const runQuery = ((params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => {
    const signal = params.options?.abortController?.signal ?? new AbortController().signal;
    async function* messages() {
      for await (const message of params.prompt) {
        const prompt = String(message.message.content);
        prompts.push(prompt);
        yield { type: "system", subtype: "init", session_id: "sess-1" };
        const result = await turn(prompt, signal);
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result,
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
  return { runQuery, prompts };
}

/** A channel that records what it is asked to send and refuses every text while `refusing` is set. */
function fakeChannel(channel: Channel) {
  const texts: string[] = [];
  const files: { path: string; caption?: string }[] = [];
  const state = { refusing: false, typing: 0, waiting: false, hold: undefined as Promise<void> | undefined };
  const out: Outbound = {
    channel,
    async text(text) {
      const hold = state.hold;
      state.hold = undefined;
      if (hold) {
        state.waiting = true;
        await hold;
        state.waiting = false;
      }
      if (state.refusing) throw new Error("sendMessage failed: ret=-2");
      texts.push(text);
    },
    async file(absPath, caption) {
      if (caption) texts.push(caption);
      files.push({ path: absPath, caption });
      return "file";
    },
    async typing() {
      state.typing++;
      return async () => {};
    },
  };
  return { out, texts, files, state };
}

let owners = 0;

/** A handler on fake channels, a log of its own and an owner of its own. */
function setup(options: { turn?: (prompt: string, signal: AbortSignal) => Promise<string>; progressMs?: number; owner?: string } = {}) {
  const wechat = fakeChannel("wechat");
  const app = fakeChannel("app");
  const events = new EventLog(path.join(tmp, `events-${owners}`, "events.jsonl"));
  const agent = fakeAgent(options.turn);
  const handler = createAgentHandler({
    owner: options.owner ?? `owner-${owners++}`,
    channels: { wechat: wechat.out, app: app.out },
    events,
    runQuery: agent.runQuery,
    progressMs: options.progressMs,
  });
  cleanups.push(() => handler.shutdown());
  const messages = (): Message[] => events.readSince(0).flatMap((e) => (e.type === "message.created" ? [e.data] : []));
  const runs = (): Run[] => events.readSince(0).flatMap((e) => (e.type === "run.updated" ? [e.data] : []));
  const finished = (n = 1) => runs().filter((r) => r.kind === "task" && r.status !== "running").length >= n;
  const send = (channel: Channel, text: string, more: Partial<Inbound> = {}) => handler.submit({ channel, text, files: [], ...more });
  return { handler, wechat, app, events, agent, messages, runs, finished, send };
}

const STEERED = "收到，会在当前步骤结束后转给 Alfred。";
const QUEUED = "收到，排在当前任务之后处理。发 /stop 可以停止当前任务。";

test("a run started from the app replies only on the app channel", async () => {
  const t = setup();
  await t.send("app", "你好", { clientId: "c-1" });
  await until("the run to finish", () => t.finished());

  assert.deepEqual(t.app.texts, ["echo: 你好"]);
  assert.deepEqual(t.wechat.texts, []);
  assert.equal(t.wechat.state.typing, 0, "the WeChat typing indicator stays off for a run the app started");
});

test("a run started from WeChat replies only on WeChat", async () => {
  const t = setup();
  await t.send("wechat", "你好");
  await until("the run to finish", () => t.finished());

  assert.deepEqual(t.wechat.texts, ["echo: 你好"]);
  assert.deepEqual(t.app.texts, []);
  assert.equal(t.wechat.state.typing, 1);
});

test("a command's reply goes to the channel it came from, during a run too", async () => {
  const hold = held();
  const t = setup({ turn: hold.turn });
  await t.send("app", "/help");
  await t.send("wechat", "/model");
  assert.match(t.app.texts[0] ?? "", /^Alfred 调研助手/);
  assert.match(t.wechat.texts[0] ?? "", /^当前模型：/);
  assert.equal(t.app.texts.length + t.wechat.texts.length, 2);

  await t.send("wechat", "查一下");
  await until("the run to start", () => hold.waiting === 1);
  await t.send("app", "/status");
  assert.match(t.app.texts.at(-1) ?? "", /任务：运行 \w{6}/, "the status of the run WeChat started comes back on the app");
  assert.equal(t.wechat.texts.length, 1, "nothing about it on WeChat");

  hold.release("好了");
  await until("the run to finish", () => t.finished());
});

test("an app message during a run WeChat started steers it, and the output stays on WeChat", async () => {
  const hold = held();
  const t = setup({ turn: hold.turn });
  await t.send("wechat", "查 VPS 价格");
  await until("the run to start", () => hold.waiting === 1);
  await t.send("app", "只看便宜的", { clientId: "c-2" });

  assert.deepEqual(t.app.texts, [STEERED], "the acknowledgement goes to the message's channel");
  assert.deepEqual(t.wechat.texts, []);
  hold.release("第一轮");
  await until("the second turn", () => hold.waiting === 1);
  hold.release("第二轮");
  await until("the run to finish", () => t.finished());

  assert.deepEqual(t.wechat.texts, ["第一轮", "第二轮"]);
  assert.deepEqual(t.app.texts, [STEERED]);
  assert.deepEqual(t.agent.prompts, ["查 VPS 价格", "只看便宜的"], "one run, two messages");
});

test("every message is recorded with its channel, files, client id and run", async () => {
  const hold = held();
  const t = setup({ turn: hold.turn });
  const image = { path: "inbox/2026-10-25/image-083110.jpg", kind: "image" as const };

  await t.send("wechat", "", { files: [image] });
  assert.match(t.wechat.texts[0] ?? "", /^已保存 inbox\/2026-10-25\/image-083110\.jpg，告诉我要怎么处理。/);

  await t.send("app", "看看这张图", { clientId: "c-3" });
  await until("the run to start", () => hold.waiting === 1);
  assert.match(t.agent.prompts[0] ?? "", /^Attached files \(workspace paths\):\n- inbox\/2026-10-25\/image-083110\.jpg\n\n看看这张图$/);
  await t.send("app", "再补一句", { clientId: "c-4" });
  hold.release("看到了");
  await until("the second turn", () => hold.waiting === 1);
  hold.release("补充收到");
  await until("the run to finish", () => t.finished());

  const runId = t.runs().find((r) => r.kind === "task")?.id;
  assert.ok(runId);
  const view = t.messages().map((m) => [m.channel, m.direction, m.text, m.files.map((f) => f.path), m.clientId, m.runId]);
  assert.deepEqual(view, [
    ["wechat", "in", "", [image.path], undefined, undefined],
    ["wechat", "out", t.wechat.texts[0], [], undefined, undefined],
    ["app", "in", "看看这张图", [], "c-3", runId],
    ["app", "in", "再补一句", [], "c-4", runId],
    ["app", "out", STEERED, [], undefined, undefined],
    ["app", "out", "看到了", [], undefined, runId],
    ["app", "out", "补充收到", [], undefined, runId],
  ]);
  assert.deepEqual(t.messages()[0]?.files, [image]);
});

test("a command and what it replies are recorded without a run", async () => {
  const t = setup();
  await t.send("app", "/help", { clientId: "c-5" });

  const [request, response, ...rest] = t.messages();
  assert.equal(rest.length, 0);
  assert.deepEqual([request?.channel, request?.direction, request?.text, request?.clientId, request?.runId], ["app", "in", "/help", "c-5", undefined]);
  assert.deepEqual([response?.channel, response?.direction, response?.runId], ["app", "out", undefined]);
});

test("a WeChat send that fails is recorded with its error, and the run is noted as undelivered on the next message's channel", async () => {
  const t = setup();
  t.wechat.state.refusing = true;
  await t.send("wechat", "写好了就告诉我");
  await until("the run to finish", () => t.finished());

  const failed = t.messages().find((m) => m.direction === "out" && m.channel === "wechat");
  assert.equal(failed?.text, "echo: 写好了就告诉我");
  assert.equal(failed?.error, "sendMessage failed: ret=-2");
  assert.ok(failed?.runId);
  assert.deepEqual(t.wechat.texts, []);

  t.wechat.state.refusing = false;
  await t.send("app", "/status");
  assert.match(t.app.texts[0] ?? "", /的结果没送到微信/);
  assert.match(t.app.texts[1] ?? "", /^模型：/);
  assert.deepEqual(t.wechat.texts, [], "the note went where the message came from");
  assert.equal(t.messages().filter((m) => m.error).length, 1);
});

test("a progress note goes to WeChat only: never to the app, and never recorded", async () => {
  const slow = async (prompt: string, signal: AbortSignal) => {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 250);
      signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
    });
    return `echo: ${prompt}`;
  };
  const t = setup({ turn: slow, progressMs: 40 });

  await t.send("app", "慢一点的任务");
  await until("the app run to finish", () => t.finished(1));
  assert.deepEqual(t.app.texts, ["echo: 慢一点的任务"], "no progress note on the app channel");
  assert.equal(t.wechat.texts.length, 0, "and none on WeChat for a run the app started");

  await t.send("wechat", "慢一点的任务");
  await until("the WeChat run to finish", () => t.finished(2));
  const notes = t.wechat.texts.filter((text) => text.startsWith("仍在处理（"));
  assert.ok(notes.length >= 1, "a long run that WeChat started gets progress notes");
  assert.equal(t.wechat.texts.at(-1), "echo: 慢一点的任务");
  assert.equal(
    t.messages().filter((m) => m.text.includes("仍在处理")).length,
    0,
    "progress notes are not events",
  );
  assert.equal(t.messages().filter((m) => m.direction === "out" && m.channel === "wechat").length, 1);
});

test("messages are taken in arrival order across channels, whatever their channel and however long each takes to prepare", async () => {
  const hold = held();
  const t = setup({ turn: hold.turn });
  const slow = async (): Promise<Inbound> => {
    await sleep(60);
    return { channel: "wechat", text: "第一条", files: [] };
  };
  const done = [
    t.handler.submit(slow),
    t.send("app", "第二条", { clientId: "c-6" }),
    t.send("wechat", "第三条"),
    t.send("app", "第四条", { clientId: "c-7" }),
  ];
  await Promise.all(done);

  assert.deepEqual(
    t.messages().filter((m) => m.direction === "in").map((m) => [m.channel, m.text]),
    [["wechat", "第一条"], ["app", "第二条"], ["wechat", "第三条"], ["app", "第四条"]],
  );
  const runId = t.runs().find((r) => r.kind === "task")?.id;
  assert.deepEqual(
    t.messages().filter((m) => m.direction === "in").map((m) => m.runId),
    [runId, runId, runId, runId],
    "the first started the run, the others steered it",
  );
  assert.deepEqual(t.wechat.texts, [STEERED], "only the message that came from WeChat is acknowledged on WeChat");
  assert.deepEqual(t.app.texts, [STEERED, STEERED]);
  await until("the run to start", () => hold.waiting === 1);
  hold.release("1");
  await until("the next turn", () => hold.waiting === 1);
  hold.release("2");
  await until("the next turn", () => hold.waiting === 1);
  hold.release("3");
  await until("the last turn", () => hold.waiting === 1);
  hold.release("4");
  await until("the run to finish", () => t.finished());
});

test("stopRun stops the live run and says so on the channel it was asked from; an unknown id stops nothing", async () => {
  const hold = held();
  const t = setup({ turn: hold.turn });
  assert.equal(await t.handler.stopRun("k7m2qa", "app"), false, "nothing runs yet");

  await t.send("wechat", "长任务");
  await until("the run to start", () => hold.waiting === 1);
  const runId = t.runs().find((r) => r.kind === "task")?.id ?? "";

  assert.equal(await t.handler.stopRun("k7m2qa", "app"), false);
  assert.deepEqual(t.app.texts, [], "an unknown id sends nothing");
  assert.equal(await t.handler.stopRun(runId, "app"), true);
  assert.deepEqual(t.app.texts, ["已停止当前任务。"]);
  assert.deepEqual(t.wechat.texts, []);

  await until("the run to stop", () => t.runs().some((r) => r.id === runId && r.status === "stopped"));
  assert.equal(await t.handler.stopRun(runId, "app"), false, "the run is over");
});

test("/stop <run id> goes through stopRun, and its reply goes to the command's channel", async () => {
  const hold = held();
  const t = setup({ turn: hold.turn });
  await t.send("app", "长任务");
  await until("the run to start", () => hold.waiting === 1);
  const runId = t.runs().find((r) => r.kind === "task")?.id ?? "";

  await t.send("wechat", "/stop zzzzzz");
  assert.deepEqual(t.wechat.texts, ["没有进行中或排队的运行 zzzzzz。发 /status 查看。"]);
  await t.send("wechat", `/stop ${runId}`);
  assert.deepEqual(t.wechat.texts.at(-1), "已停止当前任务。");
  assert.deepEqual(t.app.texts, []);
  await until("the run to stop", () => t.runs().some((r) => r.id === runId && r.status === "stopped"));
});

test("a message that arrives once the task takes no more input is queued, and the next task goes to the channel of the first one queued", async () => {
  const t = setup();
  let release = () => {};
  t.wechat.state.hold = new Promise<void>((resolve) => (release = resolve));
  await t.send("wechat", "第一个任务");
  await until("the final reply to be on its way", () => t.wechat.state.waiting);

  await t.send("app", "补充任务");
  await t.send("wechat", "第二条");
  assert.deepEqual(t.app.texts, [QUEUED], "the acknowledgement goes to the message's channel");
  assert.deepEqual(t.wechat.texts, [QUEUED]);
  assert.deepEqual(
    t.messages().filter((m) => m.direction === "in").map((m) => [m.channel, m.text, m.runId]),
    [["wechat", "第一个任务", t.runs()[0]?.id], ["app", "补充任务", undefined], ["wechat", "第二条", undefined]],
    "a queued message belongs to no run yet",
  );

  release();
  await until("the second task to finish", () => t.finished(2));
  assert.deepEqual(t.wechat.texts, [QUEUED, "echo: 第一个任务"]);
  assert.deepEqual(t.app.texts, [QUEUED, "echo: 补充任务\n\n---\n\n第二条"]);
  assert.equal(t.messages().filter((m) => m.direction === "in").length, 3, "the queued messages are not recorded again when their task starts");
});

test("the notice for rules a run changed goes to the channel of the message that started it", async () => {
  const writesRules = async (prompt: string) => {
    fs.mkdirSync(path.join(tmp, "workspace", "notes"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "workspace", "notes", "ALFRED.md"), `rules ${prompt}`);
    return "写好了";
  };
  const t = setup({ turn: writesRules });
  await t.send("app", "加一条规则");
  await until("the run to finish", () => t.finished());
  await until("the notice", () => t.app.texts.length === 2);

  assert.deepEqual(t.app.texts, ["写好了", "已新建 notes/ALFRED.md"]);
  assert.deepEqual(t.wechat.texts, []);
  const notice = t.messages().find((m) => m.text.startsWith("已新建"));
  assert.equal(notice?.channel, "app");
  assert.equal(notice?.runId, t.runs()[0]?.id, "the notice belongs to the run that changed the rules");
});

test("the note about a run a restart cut short goes to the channel of the next message, and only once", async () => {
  const hold = held();
  const first = setup({ turn: hold.turn, owner: "owner-restart" });
  await first.send("wechat", "长任务");
  await until("the run to start", () => hold.waiting === 1);
  await first.handler.shutdown();
  await until("the run to be lost", () => first.runs().some((r) => r.kind === "task" && r.status === "lost"));

  const second = setup({ owner: "owner-restart" });
  await second.send("app", "/status");
  assert.match(second.app.texts[0] ?? "", /^Alfred 重启时中断了 1 个任务：「长任务」/);
  assert.match(second.app.texts[1] ?? "", /^模型：/);
  assert.deepEqual(second.wechat.texts, []);
  await second.send("wechat", "/help");
  assert.match(second.wechat.texts[0] ?? "", /^Alfred 调研助手/, "the note was said once");
});
