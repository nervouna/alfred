// The handler on a fake channel and a fake agent: no model is called, nothing is sent anywhere.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import type { LiveEvent, Message, Run } from "../api/schema.ts";
import type { Inbound, Outbound } from "../channels.ts";
import type { Documents } from "../documents/register.ts";

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
const { InvalidAnswer, appOutbound } = await import("../channels.ts");
const { DocumentStore } = await import("../documents/store.ts");
const { Versions } = await import("../documents/versions.ts");

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
function fakeApp() {
  const texts: string[] = [];
  const files: { path: string; caption?: string }[] = [];
  const state = { refusing: false, waiting: false, hold: undefined as Promise<void> | undefined };
  const out: Outbound = {
    channel: "app",
    async text(text) {
      const hold = state.hold;
      state.hold = undefined;
      if (hold) {
        state.waiting = true;
        await hold;
        state.waiting = false;
      }
      if (state.refusing) throw new Error("the channel refused the message");
      texts.push(text);
    },
    async file(absPath, caption) {
      if (caption) texts.push(caption);
      files.push({ path: absPath, caption });
      return "file";
    },
  };
  return { out, texts, files, state };
}

let states = 0;
let logs = 0;

/** A handler on a fake channel, a log of its own and a state file of its own (or the given one). */
function setup(options: { turn?: TurnFn; interruptMs?: number; stateFile?: string; documents?: Documents } = {}) {
  const app = fakeApp();
  const events = new EventLog(path.join(tmp, `events-${logs++}`, "events.jsonl"));
  const agent = fakeAgent(options.turn);
  const handler = createAgentHandler({
    out: app.out,
    events,
    stateFile: options.stateFile ?? path.join(tmp, `state-${states++}`, "agent-state.json"),
    runQuery: agent.runQuery,
    interruptMs: options.interruptMs,
    documents: options.documents,
  });
  cleanups.push(() => handler.shutdown());
  const live: LiveEvent[] = [];
  events.subscribe((event) => {
    if (isLiveEvent(event)) live.push(event);
  });
  const messages = (): Message[] => events.readSince(0).flatMap((e) => (e.type === "message.created" ? [e.data] : []));
  const runs = (): Run[] => events.readSince(0).flatMap((e) => (e.type === "run.updated" ? [e.data] : []));
  const questions = () => events.readSince(0).flatMap((e) => (e.type === "question.asked" ? [e.data] : []));
  const answered = () => events.readSince(0).flatMap((e) => (e.type === "question.answered" ? [e.data] : []));
  const finished = (n = 1) => runs().filter((r) => r.kind === "task" && r.status !== "running").length >= n;
  const send = (text: string, more: Partial<Inbound> = {}) => handler.submit({ text, files: [], ...more });
  /** The run's id once it started, and the ids of the background subagents it started so far. */
  const taskId = (): string => runs().findLast((r) => r.kind === "task")?.id ?? "";
  const subagentIds = (): string[] => [...new Set(runs().filter((r) => r.kind === "subagent").map((r) => r.id))];
  const statusOf = (id: string): string | undefined => runs().findLast((r) => r.id === id)?.status;
  return { handler, app, events, agent, live, messages, runs, questions, answered, finished, send, taskId, subagentIds, statusOf };
}

const STEERED = "收到，会在当前步骤结束后转给 Alfred。";
const QUEUED = "收到，排在当前运行之后处理。发 /stop 可以停止当前运行。";

test("a run replies on the app channel, and the reply is a message event of the run", async () => {
  const t = setup();
  await t.send("你好", { clientId: "c-1" });
  await until("the run to finish", () => t.finished());

  assert.deepEqual(t.app.texts, ["echo: 你好"]);
  const reply = t.messages().find((m) => m.direction === "out");
  assert.deepEqual([reply?.channel, reply?.text, reply?.runId], ["app", "echo: 你好", t.taskId()]);
});

test("a command is answered at once, during a run too", async () => {
  const hold = held();
  const t = setup({ turn: hold.turn });
  await t.send("/help");
  await t.send("/model");
  assert.match(t.app.texts[0] ?? "", /^Alfred 调研助手/);
  assert.match(t.app.texts[1] ?? "", /^当前模型：/);

  await t.send("查一下");
  await until("the run to start", () => hold.waiting === 1);
  await t.send("/status");
  assert.match(t.app.texts.at(-1) ?? "", /运行：\w{6}，进行中/, "the status shows the run");

  hold.release("好了");
  await until("the run to finish", () => t.finished());
});

test("a message during a run steers it: it is acknowledged, and the same run answers it", async () => {
  const hold = held();
  const t = setup({ turn: hold.turn });
  await t.send("查 VPS 价格");
  await until("the run to start", () => hold.waiting === 1);
  await t.send("只看便宜的", { clientId: "c-2" });

  assert.deepEqual(t.app.texts, [STEERED]);
  hold.release("第一轮");
  await until("the second turn", () => hold.waiting === 1);
  hold.release("第二轮");
  await until("the run to finish", () => t.finished());

  assert.deepEqual(t.app.texts, [STEERED, "第一轮", "第二轮"]);
  assert.deepEqual(t.agent.prompts, ["查 VPS 价格", "只看便宜的"], "one run, two messages");
});

test("every message is recorded with its files, client id and run", async () => {
  const hold = held();
  const t = setup({ turn: hold.turn });
  const image = { path: "inbox/2026-10-25/image-083110.jpg", kind: "image" as const };

  await t.send("", { files: [image], clientId: "c-3a" });
  assert.match(t.app.texts[0] ?? "", /^已保存 inbox\/2026-10-25\/image-083110\.jpg，告诉我要怎么处理。/);

  await t.send("看看这张图", { clientId: "c-3" });
  await until("the run to start", () => hold.waiting === 1);
  assert.match(t.agent.prompts[0] ?? "", /^Attached files \(workspace paths\):\n- inbox\/2026-10-25\/image-083110\.jpg\n\n看看这张图$/);
  await t.send("再补一句", { clientId: "c-4" });
  hold.release("看到了");
  await until("the second turn", () => hold.waiting === 1);
  hold.release("补充收到");
  await until("the run to finish", () => t.finished());

  const runId = t.runs().find((r) => r.kind === "task")?.id;
  assert.ok(runId);
  const view = t.messages().map((m) => [m.channel, m.direction, m.text, m.files.map((f) => f.path), m.clientId, m.runId]);
  assert.deepEqual(view, [
    ["app", "in", "", [image.path], "c-3a", undefined],
    ["app", "out", t.app.texts[0], [], undefined, undefined],
    ["app", "in", "看看这张图", [], "c-3", runId],
    ["app", "in", "再补一句", [], "c-4", runId],
    ["app", "out", STEERED, [], undefined, undefined],
    ["app", "out", "看到了", [], undefined, runId],
    ["app", "out", "补充收到", [], undefined, runId],
  ]);
  assert.deepEqual(t.messages()[0]?.files, [image]);
});

test("files of a message are attached to the next message, and a message of only files is answered with the saved line", async () => {
  const hold = held();
  const t = setup({ turn: hold.turn });
  const brief = { path: "inbox/2026-10-25/brief.pdf", kind: "file" as const };

  await t.send("", { files: [brief], clientId: "c-f1" });
  assert.deepEqual(t.app.texts, [`已保存 ${brief.path}，告诉我要怎么处理。`]);

  await t.send("看看这份", { clientId: "c-f2" });
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
  await t.send("/help", { clientId: "c-5" });

  const [request, response, ...rest] = t.messages();
  assert.equal(rest.length, 0);
  assert.deepEqual([request?.channel, request?.direction, request?.text, request?.clientId, request?.runId], ["app", "in", "/help", "c-5", undefined]);
  assert.deepEqual([response?.channel, response?.direction, response?.runId], ["app", "out", undefined]);
});

test("a reply the channel refuses is recorded with its error and logged; the run still ends done and nothing is noted later", async () => {
  const t = setup();
  t.app.state.refusing = true;
  await t.send("写好了就告诉我");
  await until("the run to finish", () => t.finished());

  const failed = t.messages().find((m) => m.direction === "out");
  assert.equal(failed?.text, "echo: 写好了就告诉我");
  assert.equal(failed?.error, "the channel refused the message");
  assert.ok(failed?.runId);
  assert.deepEqual(t.app.texts, []);
  assert.equal(t.statusOf(t.taskId()), "done");
  assert.equal(readRunFile(t.taskId())?.undelivered, undefined, "nothing is recorded on the run's card");

  t.app.state.refusing = false;
  await t.send("/status");
  assert.equal(t.app.texts.length, 1, "no note about the reply that did not arrive");
  assert.match(t.app.texts[0] ?? "", /^模型：/);
});

test("messages are taken in arrival order: the first starts the run, the others steer it", async () => {
  const hold = held();
  const t = setup({ turn: hold.turn });
  await Promise.all([t.send("第一条"), t.send("第二条", { clientId: "c-6" }), t.send("第三条"), t.send("第四条", { clientId: "c-7" })]);

  assert.deepEqual(
    t.messages().filter((m) => m.direction === "in").map((m) => m.text),
    ["第一条", "第二条", "第三条", "第四条"],
  );
  const runId = t.runs().find((r) => r.kind === "task")?.id;
  assert.deepEqual(
    t.messages().filter((m) => m.direction === "in").map((m) => m.runId),
    [runId, runId, runId, runId],
    "the first started the run, the others steered it",
  );
  assert.deepEqual(t.app.texts, [STEERED, STEERED, STEERED]);
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

test("stopRun stops the live run and says so; an unknown id stops nothing", async () => {
  const hold = held();
  const t = setup({ turn: hold.turn });
  assert.equal(await t.handler.stopRun("k7m2qa"), false, "nothing runs yet");

  await t.send("长任务");
  await until("the run to start", () => hold.waiting === 1);
  const runId = t.runs().find((r) => r.kind === "task")?.id ?? "";

  assert.equal(await t.handler.stopRun("k7m2qa"), false);
  assert.deepEqual(t.app.texts, [], "an unknown id sends nothing");
  assert.equal(await t.handler.stopRun(runId), true);
  assert.deepEqual(t.app.texts, ["已停止当前运行。"]);

  await until("the run to stop", () => t.runs().some((r) => r.id === runId && r.status === "stopped"));
  assert.equal(await t.handler.stopRun(runId), false, "the run is over");
});

test("/stop <run id> goes through stopRun", async () => {
  const hold = held();
  const t = setup({ turn: hold.turn });
  await t.send("长任务");
  await until("the run to start", () => hold.waiting === 1);
  const runId = t.runs().find((r) => r.kind === "task")?.id ?? "";

  await t.send("/stop zzzzzz");
  assert.deepEqual(t.app.texts, ["没有进行中或排队的运行 zzzzzz。发 /status 查看。"]);
  await t.send(`/stop ${runId}`);
  assert.deepEqual(t.app.texts.at(-1), "已停止当前运行。");
  await until("the run to stop", () => t.runs().some((r) => r.id === runId && r.status === "stopped"));
});

test("messages that arrive once the task takes no more input are queued, and start the next task together", async () => {
  const t = setup();
  let release = () => {};
  t.app.state.hold = new Promise<void>((resolve) => (release = resolve));
  await t.send("第一个任务");
  await until("the final reply to be on its way", () => t.app.state.waiting);

  await t.send("补充任务");
  await t.send("第二条");
  assert.deepEqual(t.app.texts, [QUEUED, QUEUED]);
  assert.deepEqual(
    t.messages().filter((m) => m.direction === "in").map((m) => [m.channel, m.text, m.runId]),
    [["app", "第一个任务", t.runs()[0]?.id], ["app", "补充任务", undefined], ["app", "第二条", undefined]],
    "a queued message belongs to no run yet",
  );

  release();
  await until("the second task to finish", () => t.finished(2));
  assert.deepEqual(t.app.texts, [QUEUED, QUEUED, "echo: 第一个任务", "echo: 补充任务\n\n---\n\n第二条"]);
  assert.equal(t.messages().filter((m) => m.direction === "in").length, 3, "the queued messages are not recorded again when their task starts");
});

test("the notice for rules a run changed is recorded with the run that changed them", async () => {
  const writesRules = async (prompt: string) => {
    fs.mkdirSync(path.join(tmp, "workspace", "notes"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "workspace", "notes", "ALFRED.md"), `rules ${prompt}`);
    return "写好了";
  };
  const t = setup({ turn: writesRules });
  await t.send("加一条规则");
  await until("the run to finish", () => t.finished());
  await until("the notice", () => t.app.texts.length === 2);

  assert.deepEqual(t.app.texts, ["写好了", "已新建 notes/ALFRED.md"]);
  const notice = t.messages().find((m) => m.text.startsWith("已新建"));
  assert.equal(notice?.channel, "app");
  assert.equal(notice?.runId, t.runs()[0]?.id, "the notice belongs to the run that changed the rules");
});

test("the note about a run a restart cut short comes with the next message, is recorded after it, and is said only once", async () => {
  const hold = held();
  const stateFile = path.join(tmp, `state-${states++}`, "agent-state.json");
  const first = setup({ turn: hold.turn, stateFile });
  await first.send("长任务");
  await until("the run to start", () => hold.waiting === 1);
  await first.handler.shutdown();
  await until("the run to be lost", () => first.runs().some((r) => r.kind === "task" && r.status === "lost"));

  const second = setup({ stateFile });
  await second.send("/status");
  assert.match(second.app.texts[0] ?? "", /^Alfred 重启时中断了 1 个运行：「长任务」/);
  assert.match(second.app.texts[1] ?? "", /^模型：/);
  const [inbound, note, reply] = second.messages().slice(-3);
  assert.deepEqual([inbound?.direction, inbound?.text], ["in", "/status"], "the message is recorded before the note it triggered");
  assert.deepEqual([note?.direction, note?.channel], ["out", "app"]);
  assert.match(note?.text ?? "", /^Alfred 重启时中断了 1 个运行/);
  assert.match(reply?.text ?? "", /^模型：/);
  await second.send("/help");
  assert.match(second.app.texts[2] ?? "", /^Alfred 调研助手/, "the note was said once");
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
  await t.send("打个招呼");
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
  assert.deepEqual(t.app.texts, ["你好，再见。"], "the reply is sent as before");
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
  await t.send("派活");
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
  await t.send("查价格");
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
  await t.send("长任务");
  await until("the run to start", () => hold.waiting === 1);
  const runId = t.taskId();

  assert.equal(await t.handler.stopRun(runId), true);
  assert.equal(t.agent.calls.interrupt, 1);
  assert.equal(t.agent.signals[0]?.aborted, false, "the run is not aborted");
  assert.deepEqual(t.app.texts, ["已停止当前运行。"]);
  await until("the run to stop", () => t.statusOf(runId) === "stopped");

  assert.equal(t.agent.signals[0]?.aborted, false, "not aborted afterwards either");
  assert.deepEqual(t.app.texts, ["已停止当前运行。"], "neither the interrupted turn's text nor an error line");
  assert.ok(!t.messages().some((m) => m.text.includes("执行出错") || m.text.includes("出错了")));
  assert.equal(t.runs().findLast((r) => r.id === runId)?.costUsd, 0.02, "the turn's spend is accounted");
  assert.equal(await t.handler.stopRun(runId), false, "the run is over");
});

test("an interrupt that lands before the model did anything is a stop, not a failed resume", async () => {
  const first = held();
  const stateFile = path.join(tmp, `state-${states++}`, "agent-state.json");
  const t = setup({ turn: first.turn, stateFile });
  await t.send("第一个");
  await until("the first run to start", () => first.waiting === 1);
  first.release("好了");
  await until("the first run to finish", () => t.finished());

  // The second run resumes the first one's session; its interrupted result counts no turns.
  const second = held(INTERRUPTED_EARLY);
  const u = setup({ turn: second.turn, stateFile });
  await u.send("第二个");
  await until("the second run to start", () => second.waiting === 1);
  assert.equal(await u.handler.stopRun(u.taskId()), true);
  await until("the second run to stop", () => u.statusOf(u.taskId()) === "stopped");

  assert.deepEqual(u.app.texts, ["已停止当前运行。"], "no new session, no error");
  assert.deepEqual(u.agent.prompts, ["第二个"], "the message was not sent again");
});

test("a stop keeps the messages already handed to the run: the next turn answers them", async () => {
  const hold = held();
  const t = setup({ turn: hold.turn });
  await t.send("第一条");
  await until("the first turn", () => hold.waiting === 1);
  await t.send("补充一条", { clientId: "c-9" });
  assert.deepEqual(t.app.texts, [STEERED]);
  const runId = t.taskId();

  assert.equal(await t.handler.stopRun(runId), true);
  await until("the follow-up's turn", () => hold.waiting === 1 && t.agent.prompts.length === 2);
  hold.release("补充的答复");
  await until("the run to finish", () => t.finished());

  assert.deepEqual(t.agent.prompts, ["第一条", "补充一条"]);
  assert.deepEqual(t.app.texts, [STEERED, "已停止当前运行。", "补充的答复"]);
  assert.equal(t.statusOf(runId), "done", "the interrupted turn was not its last");
  assert.equal(t.agent.signals[0]?.aborted, false);
});

test("a stop keeps the messages queued behind the run: they start the next task", async () => {
  const t = setup();
  let release = () => {};
  t.app.state.hold = new Promise<void>((resolve) => (release = resolve));
  await t.send("第一个任务");
  await until("the final reply to be on its way", () => t.app.state.waiting);
  await t.send("排队的消息");
  assert.deepEqual(t.app.texts, [QUEUED]);

  assert.equal(await t.handler.stopRun(t.taskId()), true);
  assert.deepEqual(t.app.texts, [QUEUED, "已停止当前运行。"], "nothing is said about dropped messages");
  release();
  await until("the next task to finish", () => t.finished(2));
  assert.deepEqual(t.app.texts, [QUEUED, "已停止当前运行。", "echo: 第一个任务", "echo: 排队的消息"]);
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
  await t.send("派两个后台任务");
  await until("both subagents to be running", () => t.subagentIds().length === 2 && hold.waiting === 1);
  const runId = t.taskId();
  const ids = t.subagentIds();

  assert.equal(await t.handler.stopRun(runId), true);
  const reply = t.app.texts[0] ?? "";
  const named = /^已停止当前运行。后台运行 (\w{6})、(\w{6}) 仍在继续，发 \/stop <id> 停止。$/.exec(reply);
  assert.ok(named, reply);
  assert.deepEqual([named[1], named[2]].sort(), [...ids].sort());
  assert.equal(t.agent.calls.interrupt, 1);

  await until("the interrupted turn to end", () => hold.waiting === 0);
  await sleep(100);
  assert.equal(t.statusOf(runId), "running", "the run goes on");
  for (const id of ids) assert.equal(t.statusOf(id), "running", "so do the subagents");
  assert.deepEqual(t.agent.calls.stopTask, [], "none was stopped");
  assert.equal(t.agent.signals[0]?.aborted, false);
  assert.deepEqual(t.app.texts, [reply], "the interrupted turn said nothing");

  // They report; the report starts a turn of its own, and the run ends as usual.
  t.agent.emit(taskNotification("agent-1"));
  t.agent.emit(taskNotification("agent-2"));
  for (const message of reportTurn("后台任务的报告")) t.agent.emit(message);
  await until("the run to finish", () => t.finished());
  assert.equal(t.statusOf(runId), "done");
  assert.ok((t.app.texts[1] ?? "").startsWith("后台任务的报告"));
});

test("with one background subagent left, the stop reply names that one", async () => {
  const hold = held();
  const t = setup({
    turn: async (prompt, signal, turn) => {
      await startBackground(turn, 1);
      return hold.turn(prompt, signal, turn);
    },
  });
  await t.send("派一个后台任务");
  await until("the subagent to be running", () => t.subagentIds().length === 1 && hold.waiting === 1);
  const [id] = t.subagentIds();

  assert.equal(await t.handler.stopRun(t.taskId()), true);
  assert.deepEqual(t.app.texts, [`已停止当前运行。后台运行 ${id} 仍在继续，发 /stop <id> 停止。`]);
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
  await h.send("长任务");
  await until("the turn to start", () => h.agent.prompts.length === 1);
  const runId = h.taskId();

  assert.equal(await h.handler.stopRun(runId), true);
  assert.equal(h.agent.calls.interrupt, 1);
  assert.equal(h.agent.signals[0]?.aborted, false, "the interrupt comes first");
  await until("the abort", () => h.agent.signals[0]?.aborted === true);
  await until("the run to stop", () => h.statusOf(runId) === "stopped");

  assert.match(logged.join("\n"), new RegExp(`run ${runId}: the interrupted turn did not end within 0\\.04s; aborting the run`));
  assert.deepEqual(h.app.texts, ["已停止当前运行。"], "no error line either");
});

test("a compaction the query reports is logged with its run, its session and the token counts it carries", async (t) => {
  const logged: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void logged.push(args.join(" "));
  t.after(() => (console.log = log));
  const h = setup({
    turn: async (_prompt, _signal, turn) => {
      turn.emit({ type: "system", subtype: "compact_boundary", session_id: SESSION, uuid: "00000000-0000-4000-8000-000000000001", compact_metadata: { trigger: "auto", pre_tokens: 91234, post_tokens: 12345 } });
      turn.emit({ type: "system", subtype: "compact_boundary", session_id: SESSION, uuid: "00000000-0000-4000-8000-000000000002" });
      return "压缩完成";
    },
  });
  await h.send("读一个很长的文件");
  await until("the run to finish", () => h.finished());

  const runId = h.taskId();
  const lines = logged.filter((line) => line.includes("agent run compacted"));
  assert.equal(lines.length, 2, logged.join("\n"));
  assert.ok(lines[0]?.includes(`agent run compacted run=${runId} session=${SESSION} trigger=auto pre_tokens=91234 post_tokens=12345`), lines[0]);
  assert.ok(lines[1]?.includes(`agent run compacted run=${runId} session=${SESSION} trigger=- pre_tokens=- post_tokens=-`), lines[1]);
});

test("the abort fallback waits 10 s by default", async () => {
  const hold = held();
  const t = setup({ turn: hold.turn });
  await t.send("长任务");
  await until("the turn to start", () => hold.waiting === 1);
  const timers: number[] = [];
  const { setTimeout: set } = globalThis;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    if (ms === 10_000) timers.push(ms);
    return set(fn, ms);
  }) as typeof setTimeout;
  try {
    await t.handler.stopRun(t.taskId());
  } finally {
    globalThis.setTimeout = set;
  }
  assert.deepEqual(timers, [10_000]);
  await until("the run to stop", () => t.finished());
});

test("the abort fallback is dropped when the interrupted turn ends in time", async () => {
  const hold = held();
  const t = setup({ turn: hold.turn, interruptMs: 300 });
  await t.send("长任务");
  await until("the turn to start", () => hold.waiting === 1);
  const runId = t.taskId();

  assert.equal(await t.handler.stopRun(runId), true);
  await until("the run to stop", () => t.statusOf(runId) === "stopped");
  await sleep(450);
  assert.equal(t.agent.signals[0]?.aborted, false, "nothing aborts the run afterwards");
});

// Structured questions: the SDK's AskUserQuestion, answered in a PreToolUse hook (see questions.ts).

const FORMAT_ASK = {
  questions: [
    {
      question: "报告用哪种格式？",
      header: "报告格式",
      multiSelect: false,
      options: [
        { label: "短表格", description: "一张对比表", preview: "<table></table>" },
        { label: "长文章", description: "完整分析" },
      ],
    },
  ],
};
const FORMAT_Q = FORMAT_ASK.questions[0]?.question ?? "";
const VENDORS_ASK = {
  questions: [
    {
      question: "要对比哪些供应商？",
      header: "供应商",
      multiSelect: true,
      options: [
        { label: "Hetzner", description: "欧洲，价格最低" },
        { label: "Vultr", description: "节点多" },
        { label: "DigitalOcean", description: "文档好" },
      ],
    },
  ],
};
const VENDORS_Q = VENDORS_ASK.questions[0]?.question ?? "";

interface Decision {
  permissionDecision: string;
  permissionDecisionReason?: string;
  updatedInput?: { answers?: Record<string, string> };
}

/** The agent calls AskUserQuestion: every PreToolUse hook of the options runs, as in the SDK, and a deny wins. */
async function askTool(
  turn: Turn,
  input: unknown,
  opts: { agentId?: string; signal?: AbortSignal; toolUseId?: string } = {},
): Promise<Decision | undefined> {
  const toolUseId = opts.toolUseId ?? "toolu_ask";
  const event = {
    hook_event_name: "PreToolUse",
    session_id: SESSION,
    transcript_path: "/dev/null",
    cwd: "/",
    tool_name: "AskUserQuestion",
    tool_input: input,
    tool_use_id: toolUseId,
    ...(opts.agentId ? { agent_id: opts.agentId, agent_type: "general-purpose" } : {}),
  };
  const hooks = (turn.options.hooks?.PreToolUse ?? []).flatMap((matcher) => matcher.hooks);
  const outputs = await Promise.all(hooks.map((hook) => hook(event as never, toolUseId, { signal: opts.signal ?? new AbortController().signal })));
  const decisions = outputs.flatMap((out) => {
    const specific = "hookSpecificOutput" in out ? (out.hookSpecificOutput as Decision | undefined) : undefined;
    return specific?.permissionDecision ? [specific] : [];
  });
  return decisions.find((d) => d.permissionDecision === "deny") ?? decisions[0];
}

/** A turn that asks `input` once, records the hook's decision and ends as the SDK does when the call was denied by a stop. */
function asking(input: unknown, decisions: (Decision | undefined)[]): TurnFn {
  return async (_prompt, _signal, turn) => {
    const decision = await askTool(turn, input);
    decisions.push(decision);
    return decision?.permissionDecision === "deny" ? INTERRUPTED : "问完了";
  };
}

const idOfOpenQuestion = (t: ReturnType<typeof setup>): string => t.questions().at(-1)?.id ?? "";

test("a question is recorded and held until it is answered, with no text sent: the event is the delivery; the tool call then gets the answers", async () => {
  const decisions: (Decision | undefined)[] = [];
  const t = setup({ turn: asking(FORMAT_ASK, decisions) });
  await t.send("出一份报告");
  await until("the question", () => t.questions().length === 1);

  const [asked] = t.questions();
  assert.ok(asked);
  assert.match(asked.id, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(asked.runId, t.taskId());
  assert.deepEqual(asked.questions, [
    {
      question: FORMAT_Q,
      header: "报告格式",
      options: [
        { label: "短表格", description: "一张对比表" },
        { label: "长文章", description: "完整分析" },
      ],
      multiSelect: false,
    },
  ]);
  assert.deepEqual(t.app.texts, []);
  assert.deepEqual(t.messages().map((m) => [m.direction, m.text]), [["in", "出一份报告"]], "no message for the question");

  await sleep(100);
  assert.deepEqual(decisions, [], "the call is held while the question is open");
  assert.equal(t.runs().findLast((r) => r.kind === "task")?.status, "running");

  assert.equal(await t.handler.answerQuestion(asked.id, { [FORMAT_Q]: "长文章" }), true);
  await until("the call to be allowed", () => decisions.length === 1);
  assert.deepEqual(decisions[0], {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    updatedInput: { ...FORMAT_ASK, answers: { [FORMAT_Q]: "长文章" } },
  });
  assert.deepEqual(t.answered(), [{ id: asked.id, runId: asked.runId, answers: { [FORMAT_Q]: "长文章" } }]);
  await until("the run to finish", () => t.finished());
  assert.equal(t.app.texts.at(-1), "问完了");
  assert.equal(await t.handler.answerQuestion(asked.id, { [FORMAT_Q]: "短表格" }), false, "it is answered once");
  assert.equal(t.answered().length, 1);
});

test("a plain message answers the question as free text, even a bare number; it is recorded with the run id and does not steer the run", async () => {
  const decisions: (Decision | undefined)[] = [];
  const t = setup({ turn: asking(VENDORS_ASK, decisions) });
  await t.send("对比供应商");
  await until("the question", () => t.questions().length === 1);
  const runId = t.taskId();

  await t.send("1 3");
  await until("the call to be allowed", () => decisions.length === 1);
  assert.deepEqual(decisions[0]?.updatedInput?.answers, { [VENDORS_Q]: "1 3" }, "no option numbers are read");
  assert.deepEqual(t.answered().map((a) => a.answers), [{ [VENDORS_Q]: "1 3" }]);
  const reply = t.messages().find((m) => m.direction === "in" && m.text === "1 3");
  assert.equal(reply?.runId, runId, "recorded with the run id");
  assert.equal(reply?.channel, "app");
  await until("the run to finish", () => t.finished());
  assert.deepEqual(t.agent.prompts, ["对比供应商"], "the reply was not pushed as a follow-up");
  assert.deepEqual(t.app.texts, ["问完了"], "and not acknowledged as one");
});

test("the text is given as the answer to every question of the ask", async () => {
  const decisions: (Decision | undefined)[] = [];
  const both = { questions: [...FORMAT_ASK.questions, ...VENDORS_ASK.questions] };
  const t = setup({ turn: asking(both, decisions) });
  await t.send("出报告");
  await until("the question", () => t.questions().length === 1);

  await t.send("1", { clientId: "c-free" });
  await until("the call to be allowed", () => decisions.length === 1);
  assert.deepEqual(decisions[0]?.updatedInput?.answers, { [FORMAT_Q]: "1", [VENDORS_Q]: "1" }, "with several questions, even a number is text");
  const reply = t.messages().find((m) => m.direction === "in" && m.text === "1");
  assert.equal(reply?.runId, t.taskId());
  await until("the run to finish", () => t.finished());
  assert.deepEqual(t.app.texts, ["问完了"], "no acknowledgement either");
});

test("free text answers a single question too, trimmed, and so does a number", async () => {
  const decisions: (Decision | undefined)[] = [];
  const t = setup({ turn: asking(FORMAT_ASK, decisions) });
  await t.send("出报告");
  await until("the question", () => t.questions().length === 1);
  await t.send("7");
  await until("the call to be allowed", () => decisions.length === 1);
  assert.deepEqual(decisions[0]?.updatedInput?.answers, { [FORMAT_Q]: "7" });
  await until("the run to finish", () => t.finished());

  const again: (Decision | undefined)[] = [];
  const u = setup({ turn: asking(FORMAT_ASK, again) });
  await u.send("出报告");
  await until("the question", () => u.questions().length === 1);
  await u.send("  两个都要，先出表格  ");
  await until("the call to be allowed", () => again.length === 1);
  assert.deepEqual(again[0]?.updatedInput?.answers, { [FORMAT_Q]: "两个都要，先出表格" });
  await until("the run to finish", () => u.finished());
});

test("a slash command does not answer the question, and neither does a message with no text", async () => {
  const decisions: (Decision | undefined)[] = [];
  const t = setup({ turn: asking(FORMAT_ASK, decisions) });
  await t.send("出报告");
  await until("the question", () => t.questions().length === 1);

  await t.send("/status");
  await t.send("/help", { clientId: "c-help" });
  await t.send("", { files: [{ path: "inbox/2026-10-26/a.jpg", kind: "image" as const }] });
  assert.match(t.app.texts[0] ?? "", /^模型：/, "/status was answered");
  assert.match(t.app.texts[1] ?? "", /^Alfred 调研助手/, "/help was answered");
  assert.match(t.app.texts.at(-1) ?? "", /^已保存 inbox\/2026-10-26\/a\.jpg/, "a message with only a file was saved");
  assert.deepEqual(decisions, [], "still held");
  assert.deepEqual(t.answered(), []);

  assert.equal(await t.handler.answerQuestion(idOfOpenQuestion(t), { [FORMAT_Q]: "短表格" }), true, "the question was still open");
  await until("the run to finish", () => t.finished());
});

test("question.answer for an unknown question is refused, and a key that is not a question's text is refused and leaves the question open", async () => {
  const decisions: (Decision | undefined)[] = [];
  const t = setup({ turn: asking(FORMAT_ASK, decisions) });
  assert.equal(await t.handler.answerQuestion("q-none", { [FORMAT_Q]: "x" }), false, "nothing is open yet");
  await t.send("出报告");
  await until("the question", () => t.questions().length === 1);
  const id = idOfOpenQuestion(t);

  assert.equal(await t.handler.answerQuestion("q-other", { [FORMAT_Q]: "x" }), false, "an unknown id");
  await assert.rejects(t.handler.answerQuestion(id, { "不是这个问题": "x" }), (err: unknown) => {
    assert.ok(err instanceof InvalidAnswer);
    assert.match(err.message, /不是这个问题/);
    return true;
  });
  await assert.rejects(t.handler.answerQuestion(id, { [FORMAT_Q]: "x", 多余: "y" }), InvalidAnswer);
  assert.deepEqual(decisions, []);
  assert.deepEqual(t.answered(), []);

  assert.equal(await t.handler.answerQuestion(id, { [FORMAT_Q]: "x" }), true);
  await until("the run to finish", () => t.finished());
  assert.equal(t.answered().length, 1);
});

test("an answer by question.answer may leave a question of the ask unanswered", async () => {
  const decisions: (Decision | undefined)[] = [];
  const t = setup({ turn: asking({ questions: [...FORMAT_ASK.questions, ...VENDORS_ASK.questions] }, decisions) });
  await t.send("出报告", { clientId: "c-part" });
  await until("the question", () => t.questions().length === 1);
  await t.handler.answerQuestion(idOfOpenQuestion(t), { [VENDORS_Q]: "Vultr" });
  await until("the run to finish", () => t.finished());
  assert.deepEqual(decisions[0]?.updatedInput?.answers, { [VENDORS_Q]: "Vultr" });
});

test("/stop cancels an open question: it is recorded as cancelled, the call is denied with the reason, and the run ends stopped", async () => {
  const decisions: (Decision | undefined)[] = [];
  const t = setup({ turn: asking(FORMAT_ASK, decisions) });
  await t.send("出报告");
  await until("the question", () => t.questions().length === 1);
  const asked = t.questions()[0];

  await t.send("/stop");
  await until("the call to be denied", () => decisions.length === 1);
  assert.deepEqual(decisions[0], { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "The user stopped the run" });
  assert.deepEqual(t.answered(), [{ id: asked?.id, runId: asked?.runId, answers: {}, cancelled: true }]);
  await until("the run to finish", () => t.finished());
  assert.equal(t.statusOf(t.taskId()), "stopped");
  assert.ok(t.app.texts.includes("已停止当前运行。"));
  assert.equal(t.agent.calls.interrupt, 1);
  assert.equal(await t.handler.answerQuestion(asked?.id ?? "", { [FORMAT_Q]: "x" }), false, "a cancelled question cannot be answered");
  assert.equal(t.answered().length, 1);
});

test("run.stop for the run (stopRun) cancels the question the same way", async () => {
  const decisions: (Decision | undefined)[] = [];
  const t = setup({ turn: asking(FORMAT_ASK, decisions) });
  await t.send("出报告", { clientId: "c-stopq" });
  await until("the question", () => t.questions().length === 1);

  assert.equal(await t.handler.stopRun(t.taskId()), true);
  await until("the run to finish", () => t.finished());
  assert.equal(decisions[0]?.permissionDecision, "deny");
  assert.equal(decisions[0]?.permissionDecisionReason, "The user stopped the run");
  assert.deepEqual(t.answered().map((a) => [a.cancelled, a.answers]), [[true, {}]]);
  assert.equal(t.statusOf(t.taskId()), "stopped");
});

test("an aborted signal on the held call cancels the question", async () => {
  const abort = new AbortController();
  const decisions: (Decision | undefined)[] = [];
  const t = setup({
    turn: async (_prompt, _signal, turn) => {
      const decision = await askTool(turn, FORMAT_ASK, { signal: abort.signal });
      decisions.push(decision);
      return INTERRUPTED;
    },
  });
  await t.send("出报告");
  await until("the question", () => t.questions().length === 1);
  abort.abort();
  await until("the call to be denied", () => decisions.length === 1);
  assert.equal(decisions[0]?.permissionDecision, "deny");
  assert.equal(decisions[0]?.permissionDecisionReason, "The user stopped the run");
  assert.deepEqual(t.answered().map((a) => [a.cancelled, a.answers]), [[true, {}]]);
  assert.equal(await t.handler.answerQuestion(idOfOpenQuestion(t), { [FORMAT_Q]: "x" }), false);
  await until("the run to finish", () => t.finished());
});

test("a signal that is already aborted records nothing", async () => {
  const abort = new AbortController();
  abort.abort();
  const decisions: (Decision | undefined)[] = [];
  const t = setup({
    turn: async (_prompt, _signal, turn) => {
      decisions.push(await askTool(turn, FORMAT_ASK, { signal: abort.signal }));
      return "完";
    },
  });
  await t.send("出报告");
  await until("the run to finish", () => t.finished());
  assert.equal(decisions[0]?.permissionDecision, "deny");
  assert.deepEqual([t.questions(), t.answered()], [[], []]);
  assert.deepEqual(t.app.texts, ["完"]);
});

test("shutdown cancels an open question", async () => {
  const decisions: (Decision | undefined)[] = [];
  const t = setup({ turn: asking(FORMAT_ASK, decisions) });
  await t.send("出报告");
  await until("the question", () => t.questions().length === 1);
  const asked = t.questions()[0];

  await t.handler.shutdown();
  assert.deepEqual(t.answered(), [{ id: asked?.id, runId: asked?.runId, answers: {}, cancelled: true }]);
  await until("the call to be denied", () => decisions.length === 1);
  assert.equal(decisions[0]?.permissionDecision, "deny");
  assert.equal(t.statusOf(t.taskId()), "lost");
});

test("a run that ends with a question open cancels it", async () => {
  const t = setup({
    turn: async (_prompt, signal, turn) => {
      void askTool(turn, FORMAT_ASK); // never awaited: the call is still held when the turn ends
      await sleep(30);
      return signal.aborted ? "x" : "完";
    },
  });
  await t.send("出报告");
  await until("the run to finish", () => t.finished());
  assert.deepEqual(t.answered().map((a) => [a.cancelled, a.answers]), [[true, {}]]);
  assert.equal(await t.handler.answerQuestion(idOfOpenQuestion(t), { [FORMAT_Q]: "x" }), false);
});

test("a subagent's call is denied at once with a message to tell the main agent instead, and nothing is asked", async () => {
  const decisions: (Decision | undefined)[] = [];
  const t = setup({
    turn: async (_prompt, _signal, turn) => {
      decisions.push(await askTool(turn, FORMAT_ASK, { agentId: "agent-9" }));
      return "完";
    },
  });
  await t.send("出报告");
  await until("the run to finish", () => t.finished());

  assert.equal(decisions[0]?.permissionDecision, "deny");
  assert.match(decisions[0]?.permissionDecisionReason ?? "", /Tell the main agent what you need to know/);
  assert.match(decisions[0]?.permissionDecisionReason ?? "", /it will ask/);
  assert.deepEqual([t.questions(), t.answered()], [[], []]);
  assert.deepEqual(t.app.texts, ["完"]);
});

test("input that does not fit the tool is denied and asks nothing", async () => {
  const decisions: (Decision | undefined)[] = [];
  const t = setup({
    turn: async (_prompt, _signal, turn) => {
      decisions.push(await askTool(turn, { questions: [] }));
      decisions.push(await askTool(turn, { questions: [FORMAT_ASK.questions[0], FORMAT_ASK.questions[0]] }));
      return "完";
    },
  });
  await t.send("出报告");
  await until("the run to finish", () => t.finished());
  assert.deepEqual(decisions.map((d) => d?.permissionDecision), ["deny", "deny"]);
  assert.deepEqual([t.questions(), t.answered()], [[], []]);
});

test("a plain message answers every open question when the agent asked in parallel", async () => {
  const decisions: (Decision | undefined)[] = [];
  const t = setup({
    turn: async (_prompt, _signal, turn) => {
      const [a, b] = await Promise.all([askTool(turn, FORMAT_ASK, { toolUseId: "toolu_a" }), askTool(turn, VENDORS_ASK, { toolUseId: "toolu_b" })]);
      decisions.push(a, b);
      return "完";
    },
  });
  await t.send("出报告");
  await until("both questions", () => t.questions().length === 2);

  await t.send("2");
  await until("both calls", () => decisions.length === 2);
  assert.deepEqual(decisions[0]?.updatedInput?.answers, { [FORMAT_Q]: "2" });
  assert.deepEqual(decisions[1]?.updatedInput?.answers, { [VENDORS_Q]: "2" });
  assert.equal(t.answered().length, 2);
  await until("the run to finish", () => t.finished());
});

test("a question is open as soon as it is recorded, so the owner's quick reply finds it", async () => {
  const decisions: (Decision | undefined)[] = [];
  const t = setup({ turn: asking(VENDORS_ASK, decisions) });
  const order: string[] = [];
  t.events.subscribe((event) => {
    if (!isLiveEvent(event)) order.push(event.type === "message.created" ? `message:${event.data.direction}` : event.type);
  });
  await t.send("对比供应商");
  await until("the question", () => t.questions().length === 1);
  await t.send("2");
  await until("the run to finish", () => t.finished());
  assert.deepEqual(
    order.filter((o) => o.startsWith("question") || o.startsWith("message")),
    ["message:in", "question.asked", "message:in", "question.answered", "message:out"],
  );
});

// The workspace is committed on every delivery and at the end of every run.

const WORKSPACE = path.join(tmp, "workspace");
/** Git is slower than the fakes: the waits for a commit are longer. */
const GIT_MS = 20_000;
let documentStacks = 0;

/**
 * A real git dir and a document store of their own on the tests' workspace. `documents` is what the handler gets:
 * with `versions`, a repository other than the real one (one that fails or waits).
 */
async function documentStack(versions?: InstanceType<typeof Versions>) {
  const dir = path.join(tmp, `documents-${documentStacks++}`);
  const gitDir = path.join(dir, "versions.git");
  const real = new Versions({ workspace: WORKSPACE, gitDir });
  await real.init();
  const store = new DocumentStore({ file: path.join(dir, "documents.json"), events: new EventLog(path.join(dir, "events.jsonl")) });
  const git = (...args: string[]) => execFileSync("git", [`--git-dir=${gitDir}`, `--work-tree=${WORKSPACE}`, ...args], { encoding: "utf8" }).trim();
  const documents: Documents = { versions: versions ?? real, store };
  return { versions: real, store, documents, git, commitCount: () => Number(git("rev-list", "--count", "HEAD")) };
}

function put(rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(WORKSPACE, rel)), { recursive: true });
  fs.writeFileSync(path.join(WORKSPACE, rel), text);
}

/** A document delivered before the run: its file committed and registered. */
async function seedDocument(d: Awaited<ReturnType<typeof documentStack>>, rel: string, text: string) {
  put(rel, text);
  const commit = await d.versions.commit(`Seed ${rel}`, { paths: [rel], force: [rel] });
  assert.ok(commit);
  return d.store.deliver({ path: rel, version: commit.version, title: "旧稿", kind: "markdown", runId: "k7m2qa" });
}

/** The agent writes a file, as its Write tool does: the file is on disk and the PostToolUse hooks hear of it. `agentId` is a subagent's. */
async function wrote(turn: Turn, rel: string, text: string, agentId?: string): Promise<void> {
  put(rel, text);
  const input = {
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: rel },
    tool_response: {},
    tool_use_id: "toolu_write",
    ...(agentId ? { agent_id: agentId, agent_type: "collector" } : {}),
  };
  for (const matcher of turn.options.hooks?.PostToolUse ?? []) {
    for (const hook of matcher.hooks) await hook(input as never, "toolu_write", { signal: new AbortController().signal });
  }
}

/** Calls one of Alfred's tools in these options, as the agent would. */
async function callTool(options: Options, name: string, args: Record<string, unknown>): Promise<string> {
  const server = options.mcpServers?.alfred as unknown as {
    instance: { _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }> };
  };
  const tool = server.instance._registeredTools[name];
  assert.ok(tool, name);
  const result = (await tool.handler(args, {})) as { content: { text: string }[] };
  return result.content.map((c) => c.text).join("\n");
}

/** Waits for the commits the handler still has under way: a shutdown waits for what is in flight. */
const settled = (t: ReturnType<typeof setup>) => t.handler.shutdown();

test("a chat run commits the files it wrote, and only those, with the run in the message; a document among them gets a changed version", async () => {
  const d = await documentStack();
  const doc = await seedDocument(d, "notes/run-doc.md", "# 旧稿\n");
  put("notes/run-unrelated.md", "# 别人写的\n");
  const t = setup({
    documents: d.documents,
    turn: async (_prompt, _signal, turn) => {
      await wrote(turn, "notes/run-doc.md", "# 新稿\n");
      await wrote(turn, "notes/run-new.md", "# 新文件\n");
      return "写好了";
    },
  });
  await t.send("改一下文稿");
  await until("the run to finish", () => t.finished());
  // The document's version is the last thing the end of the run records, after the commit.
  await until("the commit and the version", () => (d.store.versions(doc.id)?.length ?? 0) === 2, GIT_MS);

  const runId = t.taskId();
  assert.equal(d.git("log", "-1", "--format=%s"), `Run ${runId}: 改一下文稿`);
  assert.deepEqual(d.git("show", "--name-only", "--format=", "HEAD").split("\n").sort(), ["notes/run-doc.md", "notes/run-new.md"]);
  assert.ok(!d.git("ls-tree", "-r", "--name-only", "HEAD").includes("notes/run-unrelated.md"), "a file the run did not write stays out");
  assert.deepEqual(
    d.store.versions(doc.id)?.map((v) => [v.version, v.reason, v.runId]),
    [[d.git("rev-parse", "HEAD"), "changed", runId], [doc.version, "delivered", "k7m2qa"]],
  );
  assert.equal(d.store.get(doc.id)?.version, d.git("rev-parse", "HEAD"));
  assert.equal(d.store.list().length, 1, "the new file is not a document: nothing delivered it");
});

test("a run that wrote nothing makes no commit", async () => {
  const d = await documentStack();
  const before = d.commitCount();
  const t = setup({ documents: d.documents });
  await t.send("你好");
  await until("the run to finish", () => t.finished());
  await settled(t);
  assert.equal(d.commitCount(), before);
});

test("a run that moves a file to .trash/ commits the removal", async () => {
  const d = await documentStack();
  put("notes/run-trash.md", "# 过期\n");
  assert.ok(await d.versions.commit("Seed", { paths: ["notes/run-trash.md"] }));
  const t = setup({
    documents: d.documents,
    turn: async (_prompt, _signal, turn) => {
      const moved = await callTool(turn.options, "move_file", { from: "notes/run-trash.md", to: ".trash/run-trash.md" });
      assert.match(moved, /Moved/);
      return "删了";
    },
  });
  await t.send("把过期的删掉");
  await until("the run to finish", () => t.finished());
  await until("the commit", () => d.git("log", "-1", "--format=%s").startsWith("Run "), GIT_MS);

  assert.equal(d.git("log", "-1", "--format=%s"), `Run ${t.taskId()}: 把过期的删掉`);
  assert.equal(d.git("show", "--name-only", "--format=", "HEAD"), "notes/run-trash.md");
  assert.ok(!fs.existsSync(path.join(WORKSPACE, "notes/run-trash.md")));
  assert.ok(!d.git("ls-tree", "-r", "--name-only", "HEAD").includes("notes/run-trash.md"));
});

test("a delivery in the run is not recorded again at its end, and a change after it is", async () => {
  const d = await documentStack();
  const t = setup({
    documents: d.documents,
    turn: async (_prompt, _signal, turn) => {
      await wrote(turn, "notes/run-kept.md", "# 交付后不改\n");
      assert.match(await callTool(turn.options, "deliver", { path: "notes/run-kept.md" }), /Delivered/);
      await wrote(turn, "notes/run-edited.md", "# 交付后又改\n");
      assert.match(await callTool(turn.options, "deliver", { path: "notes/run-edited.md" }), /Delivered/);
      await wrote(turn, "notes/run-edited.md", "# 交付后又改了\n");
      return "发了两份";
    },
  });
  await t.send("写两份发给我");
  await until("the run to finish", () => t.finished(), GIT_MS);
  const versionsOf = (rel: string) => d.store.versions(d.store.byPath(rel)?.id ?? "")?.length ?? 0;
  await until("the end of the run to be recorded", () => versionsOf("notes/run-edited.md") === 2, GIT_MS);

  const runId = t.taskId();
  const kept = d.store.byPath("notes/run-kept.md");
  const edited = d.store.byPath("notes/run-edited.md");
  assert.ok(kept && edited);
  assert.deepEqual(d.store.versions(kept.id)?.map((v) => [v.reason, v.runId]), [["delivered", runId]], "no second version for a file that did not change");
  assert.deepEqual(d.store.versions(edited.id)?.map((v) => [v.reason, v.runId]), [["changed", runId], ["delivered", runId]]);
  assert.equal(d.git("log", "-1", "--format=%s"), `Run ${runId}: 写两份发给我`);
  assert.equal(d.git("show", "--name-only", "--format=", "HEAD"), "notes/run-edited.md");

  const delivered = t.messages().flatMap((m) => m.files);
  assert.deepEqual(
    delivered.map((f) => [f.path, f.documentId, f.version]),
    [
      ["notes/run-kept.md", kept.id, kept.version],
      ["notes/run-edited.md", edited.id, d.store.versions(edited.id)?.[1]?.version],
    ],
    "the messages name the version each delivery made",
  );
});

test("a background subagent commits its own files when it ends, and the run that started it commits none of them", async () => {
  const d = await documentStack();
  const t = setup({
    documents: d.documents,
    turn: async (_prompt, _signal, turn) => {
      const background = await startBackground(turn, 1);
      // The step comes after task_started in the stream, so the subagent is live once it has been handled.
      turn.emit(toolCalls([{ name: "WebFetch", input: { url: "https://example.com/a" } }], background.toolUseId));
      await until("the subagent to start", () => t.live.some((e) => e.type === "run.step"));
      await wrote(turn, "notes/run-background.md", "# 后台写的\n", background.agentId);
      turn.emit(taskNotification(background.agentId));
      return "派出去了";
    },
  });
  const before = d.commitCount();
  await t.send("派一个后台任务");
  await until("the run to finish", () => t.finished());
  await until("the subagent's run to finish", () => t.subagentIds().length === 1 && t.subagentIds().every((id) => t.statusOf(id) === "done"));
  await until("the commit", () => d.commitCount() > before, GIT_MS);
  await settled(t);

  const [subId] = t.subagentIds();
  assert.equal(d.commitCount(), before + 1, "one commit: the parent run wrote nothing itself");
  assert.equal(d.git("log", "-1", "--format=%s"), `Run ${subId}: 读第 1 页`);
  assert.equal(d.git("show", "--name-only", "--format=", "HEAD"), "notes/run-background.md");
});

test("a stopped run commits what it wrote", async () => {
  const d = await documentStack();
  const hold = held();
  const t = setup({
    documents: d.documents,
    turn: async (prompt, signal, turn) => {
      await wrote(turn, "notes/run-stopped.md", "# 写了一半\n");
      return hold.turn(prompt, signal, turn);
    },
  });
  await t.send("写一份很长的东西");
  await until("the run to start", () => hold.waiting === 1);
  assert.equal(await t.handler.stopRun(t.taskId()), true);
  await until("the interrupted turn to end", () => hold.waiting === 0);
  await until("the run to finish", () => t.finished());
  await until("the commit", () => d.git("log", "-1", "--format=%s").startsWith("Run "), GIT_MS);

  assert.equal(t.statusOf(t.taskId()), "stopped");
  assert.equal(d.git("log", "-1", "--format=%s"), `Run ${t.taskId()}: 写一份很长的东西`);
  assert.equal(d.git("show", "--name-only", "--format=", "HEAD"), "notes/run-stopped.md");
});

test("a commit that fails is logged, and the run still ends done with its reply sent first and never waiting for the commit", async () => {
  const d = await documentStack();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let commits = 0;
  const failing = {
    commit: async () => {
      commits++;
      await gate;
      throw new Error("index.lock exists");
    },
  } as unknown as InstanceType<typeof Versions>;
  const t = setup({
    documents: { versions: failing, store: d.store },
    turn: async (_prompt, _signal, turn) => {
      await wrote(turn, "notes/run-failing.md", "# 提交不了\n");
      return "写好了";
    },
  });
  await t.send("写一份");
  await until("the commit to start", () => commits === 1);

  assert.ok((t.app.texts[0] ?? "").startsWith("写好了"), "the reply went out while the commit is still waiting");
  assert.equal(t.statusOf(t.taskId()), "done", "so did the run's end");
  release();
  await settled(t);
  assert.equal(t.statusOf(t.taskId()), "done");
  assert.equal(readRunFile(t.taskId())?.error, undefined);
  assert.deepEqual(t.messages().filter((m) => m.direction === "out" && /出错/.test(m.text)), [], "nothing about the failure reaches the owner");
});

test("without documents a run commits nothing, and still runs", async () => {
  const d = await documentStack();
  const before = d.commitCount();
  const t = setup({
    turn: async (_prompt, _signal, turn) => {
      await wrote(turn, "notes/run-undocumented.md", "# 没有版本库\n");
      return "好";
    },
  });
  await t.send("写一份");
  await until("the run to finish", () => t.finished());
  await settled(t);
  assert.equal(t.statusOf(t.taskId()), "done");
  assert.equal(d.commitCount(), before);
});
