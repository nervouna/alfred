// The handler on fake channels and a fake agent: no model is called, nothing is sent anywhere.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import type { Channel, LiveEvent, Message, Run } from "../api/schema.ts";
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
const { EventLog, isLiveEvent } = await import("../events.ts");
const { readRunFile } = await import("../runs.ts");
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

/** What a turn returns when the handler interrupted it: the fake agent then ends it as the SDK does. */
const INTERRUPTED = Symbol("interrupted");
/** The same for an interrupt that landed before the model did anything: the result counts no turns. */
const INTERRUPTED_EARLY = Symbol("interrupted early");
type Ended = string | typeof INTERRUPTED | typeof INTERRUPTED_EARLY;

/** What a fake turn can do while it runs. */
interface Turn {
  /** Sends a message to the handler, as the SDK does during a turn. */
  emit(message: object): void;
  /** Settles when the handler interrupts the turn. */
  interrupted: Promise<void>;
  options: Options;
}

type TurnFn = (prompt: string, signal: AbortSignal, turn: Turn) => Promise<Ended>;

/** A turn of the fake agent that ends when the test says so, when it is interrupted, or when the run is aborted. */
function held(interruptedAs: typeof INTERRUPTED | typeof INTERRUPTED_EARLY = INTERRUPTED) {
  const waiting: ((text: Ended) => void)[] = [];
  return {
    turn: (_prompt: string, signal: AbortSignal, turn: Turn) =>
      new Promise<Ended>((resolve, reject) => {
        waiting.push(resolve);
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        void turn.interrupted.then(() => {
          const i = waiting.indexOf(resolve);
          if (i >= 0) waiting.splice(i, 1);
          resolve(interruptedAs);
        });
      }),
    get waiting() {
      return waiting.length;
    },
    release: (text: string) => waiting.shift()?.(text),
  };
}

/** A turn that ignores interrupts and ends only when the run is aborted. */
const stubborn: TurnFn = (_prompt, signal) =>
  new Promise<Ended>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));

const SESSION = "sess-1";

/** The result the SDK sends for a turn an interrupt cut short. */
function interruptedResult(uuid: string, numTurns = 3, costUsd = 0.02) {
  return {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: [],
    terminal_reason: "aborted_streaming",
    num_turns: numTurns,
    total_cost_usd: costUsd,
    modelUsage: {},
    session_id: SESSION,
    user_message_uuid: uuid,
    user_message_uuids: [uuid],
  };
}

/**
 * Stands in for the SDK's query(): answers every message of the task's input with one result, in a
 * turn of its own. `turn` says what a turn does; it can send more messages (stream events, tool
 * calls, task messages) with `emit`, and `agent.emit` sends one between turns.
 */
function fakeAgent(turn: TurnFn = async (prompt) => `echo: ${prompt}`) {
  const prompts: string[] = [];
  const signals: AbortSignal[] = [];
  const calls = { interrupt: 0, stopTask: [] as string[] };
  let current: { push: (message: object) => void; interrupt: () => void } | undefined;
  const runQuery = ((params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => {
    const options = params.options ?? {};
    const signal = options.abortController?.signal ?? new AbortController().signal;
    signals.push(signal);
    const outbox: object[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    let failure: unknown;
    const push = (message: object) => {
      outbox.push(message);
      wake?.();
    };
    let interrupt: () => void = () => {};
    const query = { push, interrupt: () => interrupt() };
    current = query;
    void (async () => {
      for await (const message of params.prompt) {
        const prompt = String(message.message.content);
        prompts.push(prompt);
        push({ type: "system", subtype: "init", session_id: SESSION });
        const interrupted = new Promise<void>((resolve) => (interrupt = resolve));
        const result = await turn(prompt, signal, { emit: push, interrupted, options });
        push(
          result === INTERRUPTED || result === INTERRUPTED_EARLY
            ? interruptedResult(message.uuid ?? "", result === INTERRUPTED ? 3 : 0)
            : {
                type: "result",
                subtype: "success",
                is_error: false,
                result,
                num_turns: 1,
                total_cost_usd: 0,
                modelUsage: {},
                session_id: SESSION,
                user_message_uuid: message.uuid,
              },
        );
      }
    })()
      .catch((err: unknown) => (failure = err))
      .finally(() => {
        ended = true;
        wake?.();
      });
    async function* messages() {
      for (;;) {
        const next = outbox.shift();
        if (next) {
          yield next;
          continue;
        }
        if (ended) break;
        await new Promise<void>((resolve) => (wake = resolve));
      }
      if (failure) throw failure;
    }
    return Object.assign(messages(), {
      stopTask: async (id: string) => void calls.stopTask.push(id),
      setModel: async () => {},
      interrupt: async () => {
        calls.interrupt++;
        query.interrupt();
        return { still_queued: [] };
      },
    });
  }) as unknown as typeof query;
  return { runQuery, prompts, signals, calls, emit: (message: object) => current?.push(message) };
}

/** A stream event, as the SDK sends it for the main agent (or for a subagent, with its Agent call's id). */
function streamEvent(event: object, parent: string | null = null) {
  return { type: "stream_event", event, parent_tool_use_id: parent, uuid: "00000000-0000-4000-8000-000000000000", session_id: SESSION };
}

const messageStart = (id: string, parent: string | null = null) => streamEvent({ type: "message_start", message: { id } }, parent);
const blockStart = (index: number, type: string, parent: string | null = null) =>
  streamEvent({ type: "content_block_start", index, content_block: { type } }, parent);
const textDelta = (index: number, text: string, parent: string | null = null) =>
  streamEvent({ type: "content_block_delta", index, delta: { type: "text_delta", text } }, parent);

/** An assistant message with tool calls, from the main agent or, with a parent, from a subagent. */
function toolCalls(calls: { name: string; input: Record<string, unknown> }[], parent: string | null = null) {
  return {
    type: "assistant",
    parent_tool_use_id: parent,
    message: { id: "msg_tools", model: "claude-haiku-4-5", content: calls.map((c, i) => ({ type: "tool_use", id: `toolu_${i}`, ...c })) },
    uuid: "00000000-0000-4000-8000-000000000001",
    session_id: SESSION,
  };
}

/** The main agent starts background subagent number `n`: the guard hook admits its Agent call, then the task starts. */
async function startBackground(turn: Turn, n: number) {
  const toolUseId = `toolu_bg${n}`;
  const description = `读第 ${n} 页`;
  const input = {
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: toolUseId,
    tool_input: { subagent_type: "collector", description, prompt: `brief ${n}`, run_in_background: true },
  };
  const hooks = (turn.options.hooks?.PreToolUse ?? []).flatMap((matcher) => matcher.hooks);
  for (const hook of hooks) await hook(input as never, toolUseId, { signal: new AbortController().signal });
  turn.emit({ type: "system", subtype: "task_started", task_id: `agent-${n}`, tool_use_id: toolUseId, subagent_type: "collector", description, task_type: "local_agent", is_backgrounded: true });
  return { toolUseId, agentId: `agent-${n}` };
}

/** What the SDK sends when a background subagent ends. */
const taskNotification = (agentId: string, status = "completed") => ({ type: "system", subtype: "task_notification", task_id: agentId, status });

/** The turn a subagent's report starts: it answers no message. */
const reportTurn = (text: string) => [
  { type: "system", subtype: "init", session_id: SESSION },
  { type: "result", subtype: "success", is_error: false, result: text, num_turns: 1, total_cost_usd: 0, modelUsage: {}, session_id: SESSION },
];

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
let logs = 0;

/** A handler on fake channels, a log of its own and an owner of its own. */
function setup(options: { turn?: TurnFn; progressMs?: number; interruptMs?: number; owner?: string } = {}) {
  const wechat = fakeChannel("wechat");
  const app = fakeChannel("app");
  const events = new EventLog(path.join(tmp, `events-${logs++}`, "events.jsonl"));
  const agent = fakeAgent(options.turn);
  const handler = createAgentHandler({
    owner: options.owner ?? `owner-${owners++}`,
    channels: { wechat: wechat.out, app: app.out },
    events,
    runQuery: agent.runQuery,
    progressMs: options.progressMs,
    interruptMs: options.interruptMs,
  });
  cleanups.push(() => handler.shutdown());
  const live: LiveEvent[] = [];
  events.subscribe((event) => {
    if (isLiveEvent(event)) live.push(event);
  });
  const messages = (): Message[] => events.readSince(0).flatMap((e) => (e.type === "message.created" ? [e.data] : []));
  const runs = (): Run[] => events.readSince(0).flatMap((e) => (e.type === "run.updated" ? [e.data] : []));
  const finished = (n = 1) => runs().filter((r) => r.kind === "task" && r.status !== "running").length >= n;
  const send = (channel: Channel, text: string, more: Partial<Inbound> = {}) => handler.submit({ channel, text, files: [], ...more });
  /** The run's id once it started, and the ids of the background subagents it started so far. */
  const taskId = (): string => runs().findLast((r) => r.kind === "task")?.id ?? "";
  const subagentIds = (): string[] => [...new Set(runs().filter((r) => r.kind === "subagent").map((r) => r.id))];
  const statusOf = (id: string): string | undefined => runs().findLast((r) => r.id === id)?.status;
  return { handler, wechat, app, events, agent, live, messages, runs, finished, send, taskId, subagentIds, statusOf };
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

test("an app message's files are attached to the next message, as WeChat media is, and the saved line goes to the app", async () => {
  const hold = held();
  const t = setup({ turn: hold.turn });
  const brief = { path: "inbox/2026-10-25/brief.pdf", kind: "file" as const };

  await t.send("app", "", { files: [brief], clientId: "c-f1" });
  assert.deepEqual(t.app.texts, [`已保存 ${brief.path}，告诉我要怎么处理。`]);
  assert.deepEqual(t.wechat.texts, []);

  await t.send("app", "看看这份", { clientId: "c-f2" });
  await until("the run to start", () => hold.waiting === 1);
  assert.match(t.agent.prompts[0] ?? "", /^Attached files \(workspace paths\):\n- inbox\/2026-10-25\/brief\.pdf\n\n看看这份$/);
  hold.release("看完了");
  await until("the run to finish", () => t.finished());

  const inbound = t.messages().filter((m) => m.direction === "in");
  assert.deepEqual(
    inbound.map((m) => [m.channel, m.text, m.files, m.clientId]),
    [
      ["app", "", [brief], "c-f1"],
      ["app", "看看这份", [], "c-f2"],
    ],
  );
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
  const [inbound, note, reply] = second.messages().slice(-3);
  assert.deepEqual([inbound?.direction, inbound?.text], ["in", "/status"], "the message is recorded before the note it triggered");
  assert.deepEqual([note?.direction, note?.channel], ["out", "app"]);
  assert.match(note?.text ?? "", /^Alfred 重启时中断了 1 个任务/);
  assert.match(reply?.text ?? "", /^模型：/);
  await second.send("wechat", "/help");
  assert.match(second.wechat.texts[0] ?? "", /^Alfred 调研助手/, "the note was said once");
});

test("the note about undelivered results is recorded after the message that starts a run, which carries the run's id", async () => {
  const t = setup();
  t.wechat.state.refusing = true;
  await t.send("wechat", "写好了就告诉我");
  await until("the run to finish", () => t.finished());
  t.wechat.state.refusing = false;

  await t.send("wechat", "再来一个");
  await until("the second run to finish", () => t.finished(2));

  const all = t.messages();
  const inbound = all.findIndex((m) => m.direction === "in" && m.text === "再来一个");
  const note = all.findIndex((m) => m.direction === "out" && /的结果没送到微信/.test(m.text));
  assert.ok(inbound >= 0 && note >= 0, "both are recorded");
  assert.ok(inbound < note, "the message comes first in the log");
  assert.equal(all[inbound]?.runId, t.taskId(), "and carries the id of the run it started");
  assert.equal(all[note]?.runId, undefined);
  assert.match(t.wechat.texts[0] ?? "", /的结果没送到微信/, "WeChat still gets the note, before the reply");
  assert.equal(t.wechat.texts[1], "echo: 再来一个");
});

test("the note about undelivered results is recorded after a follow-up that steers the run", async () => {
  const hold = held();
  const t = setup({ turn: hold.turn });
  t.wechat.state.refusing = true;
  await t.send("wechat", "第一个");
  await until("the run to start", () => hold.waiting === 1);
  hold.release("好了");
  await until("the first run to finish", () => t.finished());
  t.wechat.state.refusing = false;
  await t.send("wechat", "第二个");
  await until("the second run to start", () => hold.waiting === 1);
  await t.send("app", "补充一句", { clientId: "c-note" });

  const all = t.messages();
  const note = all.findIndex((m) => m.direction === "out" && /的结果没送到微信/.test(m.text));
  const first = all.findIndex((m) => m.direction === "in" && m.text === "第二个");
  assert.ok(first >= 0 && note > first, "the note follows the message that triggered it");
  hold.release("全部完成");
  await until("the follow-up's turn", () => hold.waiting === 1);
  hold.release("补充完成");
  await until("the second run to finish", () => t.finished(2));
});

test("the line about media that could not be saved is recorded after the message it belongs to", async () => {
  const t = setup();
  await t.send("wechat", "看看这个", { failed: ["图片 inbox/2026-10-25/image-1.jpg 保存失败"] });
  await until("the run to finish", () => t.finished());

  const view = t.messages().map((m) => [m.direction, m.text, m.runId ? "run" : "-"]);
  assert.deepEqual(view, [
    ["in", "看看这个", "run"],
    ["out", "图片 inbox/2026-10-25/image-1.jpg 保存失败", "-"],
    ["out", "echo: 看看这个", "run"],
  ]);
  assert.deepEqual(t.wechat.texts, ["图片 inbox/2026-10-25/image-1.jpg 保存失败", "echo: 看看这个"], "WeChat gets the same lines in the same order");
});

test("the main agent's text is published as message.delta, with one stream id for each text block", async () => {
  const t = setup({
    turn: async (_prompt, _signal, turn) => {
      turn.emit(messageStart("msg_a"));
      turn.emit(blockStart(0, "thinking"));
      turn.emit(streamEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "想一想" } }));
      turn.emit(blockStart(1, "text"));
      turn.emit(textDelta(1, "你"));
      turn.emit(textDelta(1, "好，"));
      turn.emit(textDelta(1, ""));
      turn.emit(blockStart(2, "tool_use"));
      turn.emit(streamEvent({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"query":' } }));
      turn.emit(streamEvent({ type: "message_stop" }));
      turn.emit(messageStart("msg_b"));
      turn.emit(blockStart(0, "text"));
      turn.emit(textDelta(0, "再"));
      turn.emit(textDelta(0, "见"));
      turn.emit(blockStart(1, "text"));
      turn.emit(textDelta(1, "。"));
      return "你好，再见。";
    },
  });
  await t.send("wechat", "打个招呼");
  await until("the run to finish", () => t.finished());

  const runId = t.taskId();
  assert.deepEqual(
    t.live.map((e) => (e.type === "message.delta" ? [e.data.runId, e.data.streamId, e.data.text] : [e.type])),
    [
      [runId, "msg_a.1", "你"],
      [runId, "msg_a.1", "好，"],
      [runId, "msg_b.0", "再"],
      [runId, "msg_b.0", "见"],
      [runId, "msg_b.1", "。"],
    ],
    "thinking, tool input and empty deltas are not streamed; a block keeps its id and the next one has another",
  );
  assert.deepEqual(t.wechat.texts, ["你好，再见。"], "WeChat gets the reply as before");
  assert.ok(t.events.readSince(0).every((e) => e.type === "message.created" || e.type === "run.updated"), "no delta is stored");
});

test("a subagent's stream events publish nothing, and do not disturb the main agent's stream id", async () => {
  const t = setup({
    turn: async (_prompt, _signal, turn) => {
      turn.emit({ type: "system", subtype: "task_started", task_id: "fg-1", tool_use_id: "toolu_fg", subagent_type: "researcher", description: "查价格", task_type: "local_agent" });
      const background = await startBackground(turn, 1);
      turn.emit(messageStart("msg_main"));
      turn.emit(blockStart(0, "text"));
      turn.emit(textDelta(0, "主"));
      turn.emit(messageStart("msg_sub", "toolu_fg"));
      turn.emit(blockStart(0, "text", "toolu_fg"));
      turn.emit(textDelta(0, "前台子代理的话", "toolu_fg"));
      turn.emit(messageStart("msg_bg", background.toolUseId));
      turn.emit(blockStart(0, "text", background.toolUseId));
      turn.emit(textDelta(0, "后台子代理的话", background.toolUseId));
      turn.emit(textDelta(0, "代理"));
      turn.emit(taskNotification(background.agentId));
      return "主代理";
    },
  });
  await t.send("app", "派活");
  await until("the run to finish", () => t.finished());

  assert.deepEqual(
    t.live.map((e) => (e.type === "message.delta" ? [e.data.streamId, e.data.text] : [e.type])),
    [["msg_main.0", "主"], ["msg_main.0", "代理"]],
  );
});

test("every step publishes run.step with its recorder's run id: the task's, a foreground subagent's and a background subagent's", async () => {
  const t = setup({
    turn: async (_prompt, _signal, turn) => {
      const background = await startBackground(turn, 1);
      turn.emit(toolCalls([{ name: "WebSearch", input: { query: "vps 价格" } }]));
      turn.emit({ type: "system", subtype: "task_started", task_id: "fg-1", tool_use_id: "toolu_fg", subagent_type: "researcher", description: "查价格", task_type: "local_agent" });
      turn.emit(toolCalls([{ name: "Read", input: { file_path: "notes/a.md" } }], "toolu_fg"));
      turn.emit(toolCalls([{ name: "WebFetch", input: { url: "https://example.com/pricing" } }], background.toolUseId));
      turn.emit(taskNotification(background.agentId));
      return "好了";
    },
  });
  await t.send("app", "查价格");
  await until("the run to finish", () => t.finished());
  await until("the subagent's run to finish", () => t.subagentIds().every((id) => t.statusOf(id) === "done"));

  const taskId = t.taskId();
  const [subId] = t.subagentIds();
  assert.ok(subId);
  const steps = t.live.flatMap((e) => (e.type === "run.step" ? [[e.data.runId, e.data.step] as const] : []));
  assert.deepEqual(
    steps.map(([runId, step]) => [runId === taskId ? "task" : runId === subId ? "background" : runId, step.tool, step.detail, step.agent]),
    [
      ["task", "WebSearch", "vps 价格", undefined],
      ["task", "Read", "notes/a.md", "researcher"],
      ["background", "WebFetch", "https://example.com/pricing", undefined],
    ],
  );
  assert.deepEqual(
    steps.filter(([runId]) => runId === taskId).map(([, step]) => step),
    readRunFile(taskId)?.steps,
    "the task's steps are exactly those on its card",
  );
  assert.deepEqual(steps.filter(([runId]) => runId === subId).map(([, step]) => step), readRunFile(subId)?.steps);
});

test("stopping interrupts the current turn instead of aborting the run, and the turn sends no reply", async () => {
  const hold = held();
  const t = setup({ turn: hold.turn });
  await t.send("wechat", "长任务");
  await until("the run to start", () => hold.waiting === 1);
  const runId = t.taskId();

  assert.equal(await t.handler.stopRun(runId, "app"), true);
  assert.equal(t.agent.calls.interrupt, 1);
  assert.equal(t.agent.signals[0]?.aborted, false, "the run is not aborted");
  assert.deepEqual(t.app.texts, ["已停止当前任务。"]);
  await until("the run to stop", () => t.statusOf(runId) === "stopped");

  assert.equal(t.agent.signals[0]?.aborted, false, "not aborted afterwards either");
  assert.deepEqual(t.wechat.texts, [], "neither the interrupted turn's text nor an error line");
  assert.ok(!t.messages().some((m) => m.text.includes("执行出错") || m.text.includes("出错了")));
  assert.equal(t.runs().findLast((r) => r.id === runId)?.costUsd, 0.02, "the turn's spend is accounted");
  assert.equal(await t.handler.stopRun(runId, "app"), false, "the run is over");
});

test("an interrupt that lands before the model did anything is a stop, not a failed resume", async () => {
  const first = held();
  const owner = "owner-early";
  const t = setup({ turn: first.turn, owner });
  await t.send("wechat", "第一个");
  await until("the first run to start", () => first.waiting === 1);
  first.release("好了");
  await until("the first run to finish", () => t.finished());

  // The second run resumes the first one's session; its interrupted result counts no turns.
  const second = held(INTERRUPTED_EARLY);
  const u = setup({ turn: second.turn, owner });
  await u.send("wechat", "第二个");
  await until("the second run to start", () => second.waiting === 1);
  assert.equal(await u.handler.stopRun(u.taskId(), "wechat"), true);
  await until("the second run to stop", () => u.statusOf(u.taskId()) === "stopped");

  assert.deepEqual(u.wechat.texts, ["已停止当前任务。"], "no new session, no error");
  assert.deepEqual(u.agent.prompts, ["第二个"], "the message was not sent again");
});

test("a stop keeps the messages already handed to the run: the next turn answers them", async () => {
  const hold = held();
  const t = setup({ turn: hold.turn });
  await t.send("wechat", "第一条");
  await until("the first turn", () => hold.waiting === 1);
  await t.send("app", "补充一条", { clientId: "c-9" });
  assert.deepEqual(t.app.texts, [STEERED]);
  const runId = t.taskId();

  assert.equal(await t.handler.stopRun(runId, "wechat"), true);
  await until("the follow-up's turn", () => hold.waiting === 1 && t.agent.prompts.length === 2);
  hold.release("补充的答复");
  await until("the run to finish", () => t.finished());

  assert.deepEqual(t.agent.prompts, ["第一条", "补充一条"]);
  assert.deepEqual(t.wechat.texts, ["已停止当前任务。", "补充的答复"]);
  assert.equal(t.statusOf(runId), "done", "the interrupted turn was not its last");
  assert.equal(t.agent.signals[0]?.aborted, false);
});

test("a stop keeps the messages queued behind the run: they start the next task", async () => {
  const t = setup();
  let release = () => {};
  t.wechat.state.hold = new Promise<void>((resolve) => (release = resolve));
  await t.send("wechat", "第一个任务");
  await until("the final reply to be on its way", () => t.wechat.state.waiting);
  await t.send("app", "排队的消息");
  assert.deepEqual(t.app.texts, [QUEUED]);

  assert.equal(await t.handler.stopRun(t.taskId(), "app"), true);
  assert.deepEqual(t.app.texts, [QUEUED, "已停止当前任务。"], "nothing is said about dropped messages");
  release();
  await until("the next task to finish", () => t.finished(2));
  assert.deepEqual(t.app.texts, [QUEUED, "已停止当前任务。", "echo: 排队的消息"]);
});

test("a stop leaves background subagents running and names them in the reply; the run goes on until they report", async () => {
  const hold = held();
  const t = setup({
    turn: async (prompt, signal, turn) => {
      await startBackground(turn, 1);
      await startBackground(turn, 2);
      return hold.turn(prompt, signal, turn);
    },
  });
  await t.send("wechat", "派两个后台任务");
  await until("both subagents to be running", () => t.subagentIds().length === 2 && hold.waiting === 1);
  const runId = t.taskId();
  const ids = t.subagentIds();

  assert.equal(await t.handler.stopRun(runId, "app"), true);
  const reply = t.app.texts[0] ?? "";
  const named = /^已停止当前任务。后台运行 (\w{6})、(\w{6}) 仍在继续，发 \/stop <id> 停止。$/.exec(reply);
  assert.ok(named, reply);
  assert.deepEqual([named[1], named[2]].sort(), [...ids].sort());
  assert.equal(t.agent.calls.interrupt, 1);

  await until("the interrupted turn to end", () => hold.waiting === 0);
  await sleep(100);
  assert.equal(t.statusOf(runId), "running", "the run goes on");
  for (const id of ids) assert.equal(t.statusOf(id), "running", "so do the subagents");
  assert.deepEqual(t.agent.calls.stopTask, [], "none was stopped");
  assert.equal(t.agent.signals[0]?.aborted, false);
  assert.deepEqual(t.wechat.texts, [], "the interrupted turn said nothing");

  // They report; the report starts a turn of its own, and the run ends as usual.
  t.agent.emit(taskNotification("agent-1"));
  t.agent.emit(taskNotification("agent-2"));
  for (const message of reportTurn("后台任务的报告")) t.agent.emit(message);
  await until("the run to finish", () => t.finished());
  assert.equal(t.statusOf(runId), "done");
  assert.ok((t.wechat.texts[0] ?? "").startsWith("后台任务的报告"));
});

test("with one background subagent left, the stop reply names that one", async () => {
  const hold = held();
  const t = setup({
    turn: async (prompt, signal, turn) => {
      await startBackground(turn, 1);
      return hold.turn(prompt, signal, turn);
    },
  });
  await t.send("app", "派一个后台任务");
  await until("the subagent to be running", () => t.subagentIds().length === 1 && hold.waiting === 1);
  const [id] = t.subagentIds();

  assert.equal(await t.handler.stopRun(t.taskId(), "app"), true);
  assert.deepEqual(t.app.texts, [`已停止当前任务。后台运行 ${id} 仍在继续，发 /stop <id> 停止。`]);
  t.agent.emit(taskNotification("agent-1"));
  for (const message of reportTurn("报告")) t.agent.emit(message);
  await until("the run to finish", () => t.finished());
});

test("if the interrupted turn does not end within the grace period, the run is aborted, and that is logged", async (t) => {
  const logged: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.join(" "));
  t.after(() => (console.error = error));
  const h = setup({ turn: stubborn, interruptMs: 40 });
  await h.send("app", "长任务");
  await until("the turn to start", () => h.agent.prompts.length === 1);
  const runId = h.taskId();

  assert.equal(await h.handler.stopRun(runId, "wechat"), true);
  assert.equal(h.agent.calls.interrupt, 1);
  assert.equal(h.agent.signals[0]?.aborted, false, "the interrupt comes first");
  await until("the abort", () => h.agent.signals[0]?.aborted === true);
  await until("the run to stop", () => h.statusOf(runId) === "stopped");

  assert.match(logged.join("\n"), new RegExp(`run ${runId}: the interrupted turn did not end within 0\\.04s; aborting the run`));
  assert.deepEqual(h.wechat.texts, ["已停止当前任务。"]);
  assert.deepEqual(h.app.texts, [], "no error line on the run's channel either");
});

test("the abort fallback waits 10 s by default", async () => {
  const hold = held();
  const t = setup({ turn: hold.turn });
  await t.send("app", "长任务");
  await until("the turn to start", () => hold.waiting === 1);
  const timers: number[] = [];
  const { setTimeout: set } = globalThis;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    if (ms === 10_000) timers.push(ms);
    return set(fn, ms);
  }) as typeof setTimeout;
  try {
    await t.handler.stopRun(t.taskId(), "app");
  } finally {
    globalThis.setTimeout = set;
  }
  assert.deepEqual(timers, [10_000]);
  await until("the run to stop", () => t.finished());
});

test("the abort fallback is dropped when the interrupted turn ends in time", async () => {
  const hold = held();
  const t = setup({ turn: hold.turn, interruptMs: 300 });
  await t.send("app", "长任务");
  await until("the turn to start", () => hold.waiting === 1);
  const runId = t.taskId();

  assert.equal(await t.handler.stopRun(runId, "app"), true);
  await until("the run to stop", () => t.statusOf(runId) === "stopped");
  await sleep(450);
  assert.equal(t.agent.signals[0]?.aborted, false, "nothing aborts the run afterwards");
});
