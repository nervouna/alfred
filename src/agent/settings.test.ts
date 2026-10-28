// What a change of a setting does to the running handler, on a fake channel and a fake agent: no model is called,
// nothing is sent anywhere. The store, the handler and the settings command are the real ones.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, mock, test } from "node:test";

import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import type { Message, Run, Settings } from "../api/schema.ts";
import type { Outbound } from "../channels.ts";

// store.ts and config.ts read these at import time, so set them before loading the modules under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-settings-live-")));
Object.assign(process.env, {
  ALFRED_WORKSPACE: path.join(tmp, "workspace"),
  ALFRED_STATE_DIR: path.join(tmp, "state"),
  ALFRED_ANTHROPIC_API_KEY: "sk-test",
  ALFRED_WORKBENCH: "",
  ALFRED_WORKBENCH_URL: "",
});
// The scans of the environment's own settings are on: a test turns the timer by its store's settings.
delete process.env.ALFRED_MEMORY_SCAN_MINUTES;
delete process.env.ALFRED_DAILY_BUDGET_USD;
delete process.env.ALFRED_SESSION_IDLE_HOURS;
delete process.env.ALFRED_MAX_BUDGET_USD;
delete process.env.ALFRED_COMPACT_TOKENS;

const { createAgentHandler } = await import("./handler.ts");
const { EventLog } = await import("../events.ts");
const { MODELS, agentEnv, envSettings, setting } = await import("./config.ts");
const { SettingsStore } = await import("../settings/store.ts");
const { settingsCommands } = await import("../settings/commands.ts");
const { parseCommand } = await import("../api/schema.ts");
const { RunRecorder } = await import("../runs.ts");

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups) await cleanup();
  fs.rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => mock.restoreAll());

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(what: string, done: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** What a turn ends with: the reply of a successful result, or the fields of a result of another kind. */
type Ended = string | Record<string, unknown>;
type TurnFn = (prompt: string, signal: AbortSignal, options: Options) => Promise<Ended>;

interface Query {
  options: Options;
  prompts: string[];
  /** The models the handler moved this query to. */
  models: string[];
}

/** Stands in for the SDK's query(): answers every message of the input with one result, in a turn of its own. */
function fakeAgent(turn: TurnFn = async (prompt) => `echo: ${prompt}`) {
  const queries: Query[] = [];
  const runQuery = ((params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => {
    const options = params.options ?? {};
    const signal = options.abortController?.signal ?? new AbortController().signal;
    const record: Query = { options, prompts: [], models: [] };
    queries.push(record);
    const outbox: object[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    let failure: unknown;
    const push = (message: object) => {
      outbox.push(message);
      wake?.();
    };
    void (async () => {
      for await (const message of params.prompt) {
        const prompt = String(message.message.content);
        record.prompts.push(prompt);
        push({ type: "system", subtype: "init", session_id: "sess-1" });
        const result = await turn(prompt, signal, options);
        push({
          type: "result",
          subtype: "success",
          is_error: false,
          result: typeof result === "string" ? result : "",
          num_turns: 1,
          total_cost_usd: 0,
          modelUsage: {},
          session_id: "sess-1",
          user_message_uuid: message.uuid,
          ...(typeof result === "string" ? {} : result),
        });
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
      setModel: async (model: string) => void record.models.push(model),
      interrupt: async () => ({ still_queued: [] }),
    });
  }) as unknown as typeof query;
  return { runQuery, queries };
}

/** A turn that waits until the test lets it end. */
function held() {
  const waiting: ((text: Ended) => void)[] = [];
  return {
    turn: (_prompt: string, signal: AbortSignal) =>
      new Promise<Ended>((resolve, reject) => {
        waiting.push(resolve);
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    release: (result: Ended) => waiting.shift()?.(result),
    get waiting() {
      return waiting.length;
    },
  };
}

/** A result that reports its cost, as the SDK's does. */
const priced = (result: string, costUsd: number): Ended => ({ result, total_cost_usd: costUsd, modelUsage: { [MODELS.sonnet]: { costUSD: costUsd } } });

function fakeApp() {
  const texts: string[] = [];
  const out: Outbound = {
    channel: "app",
    async text(text) {
      texts.push(text);
    },
    async file() {
      return "file";
    },
  };
  return { out, texts };
}

let cases = 0;

interface SetupOptions {
  turn?: TurnFn;
  /** The environment the store is made over, as variables. */
  env?: Record<string, string>;
  /** The owner's record in agent-state.json before the handler starts. */
  owner?: Record<string, unknown>;
  /** Run without a settings store. */
  noStore?: boolean;
}

/** A handler on a fake channel and agent, over a settings store of its own and the command that changes it. */
function setup(options: SetupOptions = {}) {
  const dir = path.join(tmp, `case-${cases++}`);
  fs.mkdirSync(dir, { recursive: true });
  const stateFile = path.join(dir, "agent-state.json");
  if (options.owner) fs.writeFileSync(stateFile, JSON.stringify({ owner: options.owner }));
  const app = fakeApp();
  const events = new EventLog(path.join(dir, "events.jsonl"));
  const agent = fakeAgent(options.turn);
  const store = options.noStore
    ? undefined
    : new SettingsStore({ file: path.join(dir, "settings.json"), mirror: path.join(dir, "mirror.json"), events, env: () => envSettings(options.env ?? {}) });
  const handler = createAgentHandler({ out: app.out, events, stateFile, runQuery: agent.runQuery, settings: store });
  cleanups.push(() => handler.shutdown());
  const commands = store && settingsCommands(store, handler);
  const messages = (): Message[] => events.readSince(0).flatMap((e) => (e.type === "message.created" ? [e.data] : []));
  const runs = (): Run[] => events.readSince(0).flatMap((e) => (e.type === "run.updated" ? [e.data] : []));
  const announced = () => events.readSince(0).flatMap((e) => (e.type === "settings.updated" ? [e.data] : []));
  const finished = (n = 1) => runs().filter((r) => r.kind === "task" && r.status !== "running").length >= n;
  let sent = 0;
  const send = (text: string) => handler.submit({ text, files: [], clientId: `c-${sent++}` });
  /** Sends a message and waits for the run it starts to end. */
  const runOnce = async (text: string) => {
    const before = runs().filter((r) => r.kind === "task" && r.status !== "running").length;
    await send(text);
    await until(`the run of "${text}"`, () => finished(before + 1));
  };
  /** A settings.update as the API hands it to the commands: parsed by the contract first. */
  const update = async (json: object) => {
    assert.ok(commands, "the setup has a store");
    const parsed = parseCommand({ type: "settings.update", ...json });
    if (!parsed.ok || parsed.command.type !== "settings.update") throw new Error(parsed.ok ? "not a settings command" : parsed.error);
    return commands.update(parsed.command);
  };
  return { handler, store, app, events, agent, messages, runs, announced, finished, send, runOnce, update, stateFile };
}

const lines = (): { texts: () => string[] } => {
  const log = mock.method(console, "log", () => {});
  const warn = mock.method(console, "error", () => {});
  return { texts: () => [...log.mock.calls, ...warn.mock.calls].map((c) => String(c.arguments[0])) };
};

// --- the daily cap -----------------------------------------------------------------------------------------------

test("a daily cap lowered after a run stops the next run from starting, and raised or reset lets it start", async () => {
  // Each run's result reports the session's running total, so every run spends 3 more.
  let total = 0;
  const s = setup({ turn: async () => priced("done", (total += 3)), env: { ALFRED_DAILY_BUDGET_USD: "10" } });
  await s.runOnce("first");
  assert.equal(s.agent.queries.length, 1);

  await s.update({ dailyBudgetUsd: 2 });
  await s.send("second");
  assert.equal(s.agent.queries.length, 1, "no run started");
  assert.ok(s.app.texts.includes("今天的花费已到每日上限 $2.00（已花 $3.00），新运行明天再开始。"), s.app.texts.join("|"));
  assert.deepEqual(
    s.messages().filter((m) => m.direction === "in").map((m) => [m.text, m.runId]),
    [["first", s.runs()[0]?.id], ["second", undefined]],
    "the refused message is recorded with no run",
  );

  await s.update({ dailyBudgetUsd: 50 });
  await s.runOnce("third");
  assert.equal(s.agent.queries.length, 2, "the raised cap lets a run start");

  await s.update({ dailyBudgetUsd: 5 });
  await s.send("fourth");
  assert.equal(s.agent.queries.length, 2, "6 spent of 5: refused again");

  await s.update({ reset: ["dailyBudgetUsd"] });
  assert.equal(setting("dailyBudgetUsd"), 10, "a reset returns to the environment's cap");
  await s.runOnce("fifth");
  assert.equal(s.agent.queries.length, 3, "6 spent of 10 lets it run");
});

test("/status shows the cap now in force", async () => {
  const s = setup({ env: { ALFRED_DAILY_BUDGET_USD: "10" } });
  await s.send("/status");
  assert.match(s.app.texts.at(-1) ?? "", /今天 \$0\.000 \/ 上限 \$10\.00/);
  await s.update({ dailyBudgetUsd: 25 });
  await s.send("/status");
  assert.match(s.app.texts.at(-1) ?? "", /今天 \$0\.000 \/ 上限 \$25\.00/);
});

// --- the run cap -------------------------------------------------------------------------------------------------

test("a run cap changed between runs applies to the next run, and a run that hits its cap says the cap it ran under", async () => {
  const turn = held();
  const s = setup({ turn: turn.turn, env: { ALFRED_MAX_BUDGET_USD: "8" } });
  await s.send("one");
  await until("the first turn", () => turn.waiting === 1);
  assert.equal(s.agent.queries[0]?.options.maxBudgetUsd, 8);

  await s.update({ runBudgetUsd: 3 });
  assert.equal(s.agent.queries[0]?.options.maxBudgetUsd, 8, "the live run keeps its cap");
  turn.release({ subtype: "error_max_budget_usd", is_error: true, errors: [] });
  await until("the first run to end", () => s.finished(1));
  assert.ok(s.app.texts.some((t) => t.startsWith("本次运行花费超过上限 $8.00")), s.app.texts.join("|"));

  await s.send("two");
  await until("the second turn", () => turn.waiting === 1);
  assert.equal(s.agent.queries[1]?.options.maxBudgetUsd, 3);
  turn.release("ok");
  await until("the second run to end", () => s.finished(2));
});

// --- the idle hours ----------------------------------------------------------------------------------------------

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

test("/help and /status show the idle hours now in force, and nothing about rotation at 0", async () => {
  const s = setup({
    env: { ALFRED_SESSION_IDLE_HOURS: "4" },
    owner: { model: "sonnet", sessionId: "old-session", sessionCostUsd: 0, totalCostUsd: 0, lastRunAt: hoursAgo(1) },
  });
  await s.send("/help");
  assert.match(s.app.texts.at(-1) ?? "", /\/new {2}开始新会话（清空上下文；空闲超过 4 小时也会自动开始）/);

  await s.update({ sessionIdleHours: 12 });
  await s.send("/help");
  assert.match(s.app.texts.at(-1) ?? "", /空闲超过 12 小时也会自动开始/);
  await s.send("/status");
  assert.match(s.app.texts.at(-1) ?? "", /空闲：60min，再过 11\.0h 下一条消息会开新会话/);

  await s.update({ sessionIdleHours: 0 });
  await s.send("/help");
  assert.match(s.app.texts.at(-1) ?? "", /\/new {2}开始新会话（清空上下文）/);
  await s.send("/status");
  assert.match(s.app.texts.at(-1) ?? "", /自动开新会话已关闭/);

  await s.update({ reset: ["sessionIdleHours"] });
  await s.send("/help");
  assert.match(s.app.texts.at(-1) ?? "", /空闲超过 4 小时/);
});

test("rotation uses the idle hours at the moment a run starts", async () => {
  const owner = { model: "sonnet", sessionId: "old-session", sessionCostUsd: 0, totalCostUsd: 0, lastRunAt: hoursAgo(2) };

  const kept = setup({ env: { ALFRED_SESSION_IDLE_HOURS: "4" }, owner });
  await kept.runOnce("hello");
  assert.equal(kept.agent.queries[0]?.options.resume, "old-session", "2 idle hours of 4: the session is resumed");
  assert.ok(!kept.app.texts.some((t) => t.includes("已开始新会话")));

  const rotated = setup({ env: { ALFRED_SESSION_IDLE_HOURS: "4" }, owner });
  await rotated.update({ sessionIdleHours: 1 });
  await rotated.runOnce("hello");
  assert.equal(rotated.agent.queries[0]?.options.resume, undefined, "2 idle hours of 1: a new session");
  assert.ok(rotated.app.texts.includes("距上次对话已超过 1 小时，已开始新会话（发 /resume 接回上一个会话）。"), rotated.app.texts.join("|"));

  const off = setup({ env: { ALFRED_SESSION_IDLE_HOURS: "1" }, owner });
  await off.update({ sessionIdleHours: 0 });
  await off.runOnce("hello");
  assert.equal(off.agent.queries[0]?.options.resume, "old-session", "0 turns rotation off");
});

// --- compaction ---------------------------------------------------------------------------------------------------

test("agentEnv reads the compaction size on each call: the next run gets the owner's value, and 0 leaves the window out", async () => {
  const s = setup({ env: { ALFRED_COMPACT_TOKENS: "120000" } });
  assert.equal(agentEnv().CLAUDE_CODE_AUTO_COMPACT_WINDOW, "120000");
  await s.runOnce("one");
  assert.equal(s.agent.queries[0]?.options.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "120000");

  await s.update({ compactTokens: 50000 });
  assert.equal(agentEnv().CLAUDE_CODE_AUTO_COMPACT_WINDOW, "50000");
  await s.runOnce("two");
  assert.equal(s.agent.queries[1]?.options.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "50000");

  await s.update({ compactTokens: 0 });
  assert.equal("CLAUDE_CODE_AUTO_COMPACT_WINDOW" in agentEnv(), false);
  await s.update({ reset: ["compactTokens"] });
  assert.equal(agentEnv().CLAUDE_CODE_AUTO_COMPACT_WINDOW, "120000");
});

// --- the memory scan ----------------------------------------------------------------------------------------------

const scanned = (texts: string[], trigger: string) => texts.filter((t) => t.includes("memory scan:") && t.includes(`trigger=${trigger}`)).length;
const settle = () => new Promise((resolve) => setImmediate(resolve));
const MINUTE_MS = 60_000;

test("the memory scan timer follows the setting: 0 has none, more starts it with the first scan, a new interval restarts it, 0 stops it", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const log = lines();
  const s = setup({ env: { ALFRED_MEMORY_SCAN_MINUTES: "0" } });
  await settle();
  t.mock.timers.tick(120 * MINUTE_MS);
  await settle();
  assert.equal(scanned(log.texts(), "startup") + scanned(log.texts(), "timer"), 0, "off at startup: no scan, no timer");

  await s.update({ memoryScanMinutes: 5 });
  await settle();
  assert.equal(scanned(log.texts(), "startup"), 1, "from 0 to more: the first scan");
  t.mock.timers.tick(5 * MINUTE_MS);
  await settle();
  assert.equal(scanned(log.texts(), "timer"), 1, "the timer runs at the new interval");

  await s.update({ memoryScanMinutes: 20 });
  await settle();
  assert.equal(scanned(log.texts(), "startup"), 1, "a running timer asks for no first scan again");
  t.mock.timers.tick(15 * MINUTE_MS);
  await settle();
  assert.equal(scanned(log.texts(), "timer"), 1, "the old 5-minute interval no longer fires");
  t.mock.timers.tick(5 * MINUTE_MS);
  await settle();
  assert.equal(scanned(log.texts(), "timer"), 2, "the 20-minute one does");

  await s.update({ memoryScanMinutes: 0 });
  t.mock.timers.tick(120 * MINUTE_MS);
  await settle();
  assert.equal(scanned(log.texts(), "timer"), 2, "0 stops it");
});

test("a retired session requests a scan only while the interval is above 0", async () => {
  const log = lines();
  const owner = { model: "sonnet", sessionId: "old-session", sessionCostUsd: 0, totalCostUsd: 0, lastRunAt: hoursAgo(1) };
  const s = setup({ env: { ALFRED_MEMORY_SCAN_MINUTES: "0" }, owner });
  await s.send("/new");
  await settle();
  await settle();
  assert.equal(scanned(log.texts(), "session retired (new)"), 0, "off: no scan");

  await s.update({ memoryScanMinutes: 90 });
  await settle();
  await s.runOnce("start a session");
  await s.send("/new");
  await until("the scan of the retired session", () => scanned(log.texts(), "session retired (new)") === 1);
});

// --- the model ---------------------------------------------------------------------------------------------------

test("/model and settings.update take the same path: the stored key, setModel on the live query, the run's model, and the event", async () => {
  const turn = held();
  const s = setup({ turn: turn.turn });
  await s.send("work");
  await until("the live turn", () => turn.waiting === 1);
  const agentState = () => JSON.parse(fs.readFileSync(s.stateFile, "utf8")).owner.model;
  // The record is written to its file a moment after it is updated, so the updates themselves are watched.
  const updates = mock.method(RunRecorder.prototype, "update");
  const recordedModels = () => updates.mock.calls.flatMap((call) => (call.arguments[0].model ? [call.arguments[0].model] : []));

  await s.send("/model haiku");
  assert.deepEqual(s.agent.queries[0]?.models, [MODELS.haiku]);
  assert.equal(agentState(), "haiku");
  assert.deepEqual(recordedModels(), [MODELS.haiku], "the run's record");
  assert.deepEqual(s.announced().map((x) => x.model), ["haiku"], "the event");
  assert.ok(s.app.texts.includes(`已切换到 haiku（${MODELS.haiku}），当前运行的下一轮起生效。`));

  const reply = await s.update({ model: "opus" });
  assert.equal(reply.ok && reply.settings.model, "opus");
  assert.deepEqual(s.agent.queries[0]?.models, [MODELS.haiku, MODELS.opus]);
  assert.equal(agentState(), "opus");
  assert.deepEqual(recordedModels(), [MODELS.haiku, MODELS.opus]);
  assert.deepEqual(s.announced().map((x) => x.model), ["haiku", "opus"]);
  assert.deepEqual(s.announced().at(-1)?.overridden, ["model"]);

  await s.send("/model opus");
  await s.update({ model: "opus" });
  assert.deepEqual(s.announced().map((x) => x.model), ["haiku", "opus"], "the same model again announces nothing");

  await s.update({ reset: ["model"] });
  assert.equal(agentState(), "sonnet");
  assert.deepEqual(s.agent.queries[0]?.models.at(-1), MODELS.sonnet);
  assert.deepEqual(s.announced().at(-1)?.overridden, []);

  turn.release("done");
  await until("the run to end", () => s.finished(1));
  assert.equal(s.runs().findLast((r) => r.kind === "task")?.model, MODELS.sonnet, "the run ended on the model the owner reset to");
});

test("with no run live, /model and settings.update store the key and announce it, and the next run is on it", async () => {
  const s = setup();
  await s.send("/model opus");
  assert.deepEqual(s.announced().map((x) => x.model), ["opus"]);
  assert.ok(s.app.texts.includes(`已切换到 opus（${MODELS.opus}）。`));
  await s.update({ model: "haiku", dailyBudgetUsd: 33 });
  assert.deepEqual(s.announced().map((x) => [x.model, x.dailyBudgetUsd]), [["opus", 20], ["haiku", 33]], "one event for the command");
  await s.runOnce("go");
  assert.equal(s.agent.queries[0]?.options.model, MODELS.haiku);
  assert.equal(s.store?.get().model, "haiku");
});

test("the model at startup is the one in agent-state.json: it is overridden when it is not sonnet, and nothing is announced for it", () => {
  const s = setup({ owner: { model: "opus", sessionCostUsd: 0, totalCostUsd: 0 } });
  assert.equal(s.store?.get().model, "opus");
  assert.deepEqual(s.store?.get().overridden, ["model"]);
  assert.deepEqual(s.announced(), []);
  assert.equal((JSON.parse(fs.readFileSync(path.join(path.dirname(s.stateFile), "mirror.json"), "utf8")) as Settings).model, "opus");
});

// --- without a store -----------------------------------------------------------------------------------------------

test("a handler without a store reads the environment alone, and a store's handler leaves nothing installed when it shuts down", async () => {
  const withStore = setup({ env: { ALFRED_DAILY_BUDGET_USD: "77" } });
  assert.equal(setting("dailyBudgetUsd"), 77);
  await withStore.handler.shutdown();
  assert.equal(setting("dailyBudgetUsd"), 20, "back to the environment and the built-in default");

  process.env.ALFRED_SESSION_IDLE_HOURS = "9";
  try {
    const bare = setup({ noStore: true });
    await bare.send("/help");
    assert.match(bare.app.texts.at(-1) ?? "", /空闲超过 9 小时也会自动开始/);
    await bare.runOnce("hello");
    assert.equal(bare.agent.queries[0]?.options.maxBudgetUsd, 10);
  } finally {
    delete process.env.ALFRED_SESSION_IDLE_HOURS;
  }
});
