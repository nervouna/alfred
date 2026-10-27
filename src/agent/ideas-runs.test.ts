// Generations of ideas on a fake channel and a fake model, with an idea store of their own: no model is called, nothing is
// sent anywhere.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, mock, test } from "node:test";

import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import type { IdeaTrigger, Message, Run } from "../api/schema.ts";
import type { Outbound } from "../channels.ts";

// Dates are local: pin the zone before any date is made, so the result does not depend on the machine.
process.env.TZ = "Asia/Taipei";
// store.ts and config.ts read these at import time, so set them before loading the modules under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-ideas-runs-")));
const workspace = path.join(tmp, "workspace");
Object.assign(process.env, {
  ALFRED_WORKSPACE: workspace,
  ALFRED_STATE_DIR: path.join(tmp, "state"),
  ALFRED_ANTHROPIC_API_KEY: "sk-test",
  ALFRED_MEMORY_SCAN_MINUTES: "0",
  ALFRED_WORKBENCH: "",
  ALFRED_WORKBENCH_URL: "",
  ALFRED_DAILY_BUDGET_USD: "5",
});

const { createAgentHandler } = await import("./handler.ts");
const { EventLog } = await import("../events.ts");
const { TaskStore } = await import("../tasks/store.ts");
const { IdeaStore } = await import("../ideas/store.ts");
const { ideaCommands } = await import("../ideas/commands.ts");
const { RunRecorder, readRunFile } = await import("../runs.ts");
const { IdeaListSchema, IdeaGenerationAcceptedSchema } = await import("../api/schema.ts");
const { MEMORY_LOCK_FILE } = await import("./memory-scan.ts");
const { MemoryLock } = await import("./memory.ts");
const { MODELS, IDEAS_BUDGET_USD } = await import("./config.ts");
const { localDate } = await import("../files.ts");

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups) await cleanup();
  fs.rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => mock.restoreAll());

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Waits for `done`. The limit is generous: a loaded machine makes the writes at the end of a run slow. */
async function until(what: string, done: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** What a turn ends with: the fields of the result message, or nothing for a call that ends without a result. */
type Ended = Record<string, unknown> | undefined;
/** The answer of the fake model to a generation: it gets the prompt, the options and the signal of the call. */
type IdeasTurn = (prompt: string, options: Options, signal: AbortSignal) => Promise<Ended> | Ended;

interface IdeasCall {
  prompt: string;
  options: Options;
}

/** A turn that ends when the test says so, or fails when the call is aborted, as the SDK's does. */
function held() {
  const waiting: ((ended: Ended) => void)[] = [];
  return {
    turn: (_prompt: string, _options: Options, signal: AbortSignal) =>
      new Promise<Ended>((resolve, reject) => {
        waiting.push(resolve);
        signal.addEventListener(
          "abort",
          () => {
            const i = waiting.indexOf(resolve);
            if (i >= 0) waiting.splice(i, 1);
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }),
    get waiting() {
      return waiting.length;
    },
    release: (ended: Ended) => waiting.shift()?.(ended),
  };
}

/**
 * Stands in for the SDK's query(). A generation (a string prompt) is answered by `ideasTurn`. A message of the chat or
 * a run beside it (a prompt that streams) is answered with one result, in a turn of its own.
 */
function fakeAgent(ideasTurn: IdeasTurn) {
  const ideasCalls: IdeasCall[] = [];
  const chatQueries: Options[] = [];
  const runQuery = ((params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => {
    const options = params.options ?? {};
    const signal = options.abortController?.signal ?? new AbortController().signal;
    if (typeof params.prompt === "string") {
      const { prompt } = params;
      ideasCalls.push({ prompt, options });
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "ideas-session" };
        const ended = await ideasTurn(prompt, options, signal);
        if (ended) yield { type: "result", subtype: "success", is_error: false, result: "", num_turns: 1, total_cost_usd: 0, modelUsage: {}, ...ended };
      })();
    }
    chatQueries.push(options);
    const outbox: object[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    let failure: unknown;
    const push = (message: object) => {
      outbox.push(message);
      wake?.();
    };
    void (async () => {
      for await (const message of params.prompt as AsyncIterable<SDKUserMessage>) {
        push({ type: "system", subtype: "init", session_id: "sess-1" });
        push({
          type: "result",
          subtype: "success",
          is_error: false,
          result: `echo: ${String(message.message.content)}`,
          num_turns: 1,
          total_cost_usd: 0,
          modelUsage: {},
          session_id: "sess-1",
          user_message_uuid: message.uuid,
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
      stopTask: async () => {},
      setModel: async () => {},
      interrupt: async () => ({ still_queued: [] }),
    });
  }) as unknown as typeof query;
  return { runQuery, ideasCalls, chatQueries };
}

/** A channel that records what it is asked to send. */
function fakeApp() {
  const texts: string[] = [];
  const out: Outbound = {
    channel: "app",
    async text(text) {
      texts.push(text);
    },
    async file(absPath, caption) {
      if (caption) texts.push(caption);
      return "file";
    },
  };
  return { out, texts };
}

let stacks = 0;
/** An event log, a task store and an idea store of their own, on the tests' workspace. */
function stack() {
  const dir = path.join(tmp, `stack-${stacks++}`);
  const events = new EventLog(path.join(dir, "events.jsonl"));
  const tasks = new TaskStore({ file: path.join(dir, "tasks.json"), events });
  const ideas = new IdeaStore({ file: path.join(dir, "ideas.json"), events });
  return { dir, events, tasks, ideas, stateFile: path.join(dir, "agent-state.json") };
}
type Stack = ReturnType<typeof stack>;

const idea = (extra: Record<string, unknown> = {}) => ({
  title: "每周追踪 VPS 价格",
  why: "你两次问到价格",
  brief: "每周一看三家定价页，只报告变化",
  kind: "recurring",
  schedule: { kind: "weekly", days: [1], time: "09:00" },
  model: "haiku",
  estimateUsd: 0.12,
  provenance: "记忆「VPS 项目」；10-25 的对话",
  ...extra,
});
const onceIdea = (extra: Record<string, unknown> = {}) => idea({ title: "对比带宽", kind: "once", schedule: null, model: "sonnet", estimateUsd: 0.4, provenance: "文档「价格报告」", ...extra });
const NOTE = "这次想到的都在这里了。";
/** A successful answer of the fake model: these ideas, this cost and this note. */
const answers = (ideas: unknown[], cost = 0.083, note: unknown = NOTE): Ended => ({
  structured_output: { ideas, note },
  total_cost_usd: cost,
  modelUsage: { [MODELS.sonnet]: { costUSD: cost } },
});

/** A handler on the stack, a fake channel and a fake model. */
function start(s: Stack, options: { turn?: IdeasTurn; ideas?: boolean; stateFile?: string } = {}) {
  const app = fakeApp();
  const agent = fakeAgent(options.turn ?? (() => answers([])));
  const handler = createAgentHandler({
    out: app.out,
    events: s.events,
    stateFile: options.stateFile ?? s.stateFile,
    runQuery: agent.runQuery,
    tasks: s.tasks,
    taskPollMs: 50,
    ...(options.ideas === false ? {} : { ideas: s.ideas }),
  });
  cleanups.push(() => handler.shutdown());
  const messages = (): Message[] => s.events.readSince(0).flatMap((e) => (e.type === "message.created" ? [e.data] : []));
  const runs = (): Run[] => s.events.readSince(0).flatMap((e) => (e.type === "run.updated" ? [e.data] : []));
  const lastRuns = (): Run[] => [...new Map(runs().map((r) => [r.id, r])).values()];
  const ideasRuns = (): Run[] => lastRuns().filter((r) => r.kind === "ideas");
  const run = (id: string): Run | undefined => lastRuns().find((r) => r.id === id);
  const ended = (id: string) => {
    const r = run(id);
    return r !== undefined && r.status !== "running" && r.status !== "queued";
  };
  const state = (): Record<string, unknown> => {
    try {
      return (JSON.parse(fs.readFileSync(options.stateFile ?? s.stateFile, "utf8")) as Record<string, Record<string, unknown>>).owner ?? {};
    } catch {
      return {};
    }
  };
  /** Starts a generation, one the owner requested unless the test says otherwise, and returns its run id; fails the test when it is refused. */
  const generate = (trigger: IdeaTrigger = "requested") => {
    const reply = handler.generateIdeas(trigger);
    assert.ok(reply.ok, reply.ok ? "" : `${reply.status} ${reply.error}`);
    return reply.body.runId;
  };
  return { handler, app, agent, messages, runs, lastRuns, ideasRuns, run, ended, state, generate };
}

/** How the store recorded the end of the run (its last generation without the run and the time), or undefined when the last one is another run's. */
function outcomeOf(s: Stack, runId: string) {
  const last = s.ideas.lastGeneration();
  if (last?.runId !== runId) return undefined;
  const { runId: _runId, endedAt, ...outcome } = last;
  assert.ok(Math.abs(Date.parse(endedAt) - Date.now()) < 60_000, `it ended just now, not ${endedAt}`);
  return outcome;
}

/** The lines the log wrote while a test ran. */
function logged() {
  const info = mock.method(console, "log", () => {});
  const warn = mock.method(console, "error", () => {});
  return () => [...info.mock.calls, ...warn.mock.calls].map((call) => String(call.arguments[0]));
}

const say = (s: Stack, direction: "in" | "out", text: string, at = new Date()) =>
  s.events.append("message.created", { id: `m-${Math.random().toString(36).slice(2)}`, channel: "app", direction, text, files: [], at: at.toISOString() });

test("generating answers 202 with the run's id, records a run of kind ideas, and marks the generation in the store", async () => {
  const s = stack();
  const hold = held();
  const t = start(s, { turn: hold.turn });

  const reply = t.handler.generateIdeas("requested");

  assert.ok(reply.ok);
  assert.deepEqual(IdeaGenerationAcceptedSchema.parse(reply.body), { runId: reply.body.runId });
  const runId = reply.body.runId;
  assert.deepEqual(
    t.ideasRuns().map((r) => [r.id, r.kind, r.title, r.status, r.model]),
    [[runId, "ideas", "想法", "running", MODELS.sonnet]],
  );
  assert.equal(s.ideas.generatingRunId(), runId);
  assert.equal(IdeaListSchema.parse(JSON.parse(fs.readFileSync(path.join(s.dir, "ideas.json"), "utf8"))).generatingRunId, runId);
  await until("the call", () => hold.waiting === 1);
  assert.equal(t.agent.ideasCalls.length, 1);
  hold.release(answers([]));
  await until("the run to end", () => t.ended(runId));
});

test("the run ends done with the ideas added under its id, the cost on its record and charged to the day and total, and nothing said to the owner", async () => {
  const s = stack();
  const t = start(s, { turn: () => answers([idea(), onceIdea()], 0.083) });

  const runId = t.generate();
  await until("the run to end", () => t.ended(runId));

  const run = t.run(runId);
  assert.equal(run?.status, "done");
  assert.equal(run?.costUsd, 0.083);
  assert.equal(readRunFile(runId)?.costUsd, 0.083);
  assert.equal(readRunFile(runId)?.status, "done");
  assert.deepEqual(
    s.ideas.list().map((i) => [i.title, i.kind, i.state, i.runId]),
    [
      ["每周追踪 VPS 价格", "recurring", "open", runId],
      ["对比带宽", "once", "open", runId],
    ],
  );
  assert.equal(s.ideas.generatingRunId(), undefined, "the generation is cleared");
  const state = t.state();
  assert.equal(state.totalCostUsd, 0.083);
  assert.equal(state.spendDay, localDate());
  assert.equal(state.spendDayUsd, 0.083, "it counts toward the daily cap");
  assert.ok(!state.sessionCostUsd, "and not toward the chat session");
  assert.equal(state.sessionId, undefined, "which it does not touch");
  assert.equal(state.lastRunAt, undefined, "nor the idle clock");
  await sleep(50);
  assert.deepEqual(t.messages(), [], "no message, in either direction");
  assert.deepEqual(t.app.texts, []);
  const updates = s.events.readSince(0).filter((e) => e.type === "idea.updated");
  assert.equal(updates.length, 2, "one idea.updated for each idea");
});

test("a generation with no ideas is done, and adds none", async () => {
  const s = stack();
  const t = start(s, { turn: () => answers([], 0.04) });
  const runId = t.generate();
  await until("the run to end", () => t.ended(runId));
  assert.equal(t.run(runId)?.status, "done");
  assert.deepEqual(s.ideas.list(), []);
  assert.equal(s.ideas.generatingRunId(), undefined);
  assert.equal(t.state().spendDayUsd, 0.04);
});

test("an idea that does not map onto a draft is left out and the others are added", async () => {
  const s = stack();
  const t = start(s, { turn: () => answers([idea({ title: "t".repeat(81) }), onceIdea(), idea({ schedule: null, title: "没有时间表" })]) });
  const runId = t.generate();
  await until("the run to end", () => t.ended(runId));
  assert.equal(t.run(runId)?.status, "done");
  assert.deepEqual(
    s.ideas.list().map((i) => i.title),
    ["对比带宽"],
  );
});

test("the call is given the inputs: the conversation of the event log, memory, and the earlier ideas, as data in one message", async () => {
  const s = stack();
  fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "memory", "coffee.md"), `---\nname: "咖啡偏好"\ndescription: "喜欢浅烘"\ntype: preference\nupdated: 2026-10-20\n---\n\n正文\n`);
  say(s, "in", "我最近在研究 VPS 的价格");
  say(s, "out", "好的，我整理了三家的价格。");
  const [rejected] = s.ideas.add([{ title: "老想法", why: "w", brief: "b", kind: "once", model: "haiku", estimateUsd: 0.1 }], "k7m2qa");
  if (!rejected) throw new Error("the idea was not added");
  s.ideas.reject(rejected.id, { reason: "too-expensive", note: "太贵" });
  const lines = logged();
  const t = start(s, { turn: () => answers([]) });

  const runId = t.generate();
  await until("the run to end", () => t.ended(runId));

  const [call] = t.agent.ideasCalls;
  assert.ok(call);
  assert.match(call.prompt, /\[\d{4}-\d{2}-\d{2} owner\] 我最近在研究 VPS 的价格/);
  assert.match(call.prompt, /\[\d{4}-\d{2}-\d{2} alfred\] 好的，我整理了三家的价格。/);
  assert.match(call.prompt, /咖啡偏好/);
  assert.match(call.prompt, /"title":"老想法","reason":"too-expensive","note":"太贵"/);
  assert.equal(call.options.model, MODELS.sonnet);
  assert.deepEqual(call.options.tools, []);
  assert.deepEqual(call.options.settingSources, []);
  assert.equal(call.options.persistSession, false);
  assert.equal(call.options.maxTurns, 3);
  assert.equal(call.options.maxBudgetUsd, IDEAS_BUDGET_USD);
  assert.ok(call.options.abortController);
  assert.equal(
    lines().find((line) => line.includes(`ideas inputs run=${runId}`))?.replace(/^\S+\s+INFO\s+/, ""),
    `ideas inputs run=${runId} memories=1 messages=2 tasks=0 documents=0 open=0 rejected=[${rejected.id}] accepted=0 archived=0`,
  );
});

test("the log has the inputs line, one line per idea added with its id, title and provenance, and the end line with the cost, how many were added and the note", async () => {
  const s = stack();
  const lines = logged();
  const t = start(s, { turn: () => answers([idea(), onceIdea(), idea({ title: "t".repeat(81) })], 0.0831) });

  const runId = t.generate();
  await until("the run to end", () => t.ended(runId));

  const all = lines().map((line) => line.replace(/^\S+\s+(INFO|WARN|ERROR)\s+/, ""));
  const mine = all.filter((line) => line.includes(runId) || line.includes("ideas added"));
  const [added1, added2] = s.ideas.list();
  assert.ok(added1 && added2);
  assert.ok(mine.some((line) => line.startsWith(`ideas inputs run=${runId} memories=`)));
  assert.ok(mine.includes(`ideas added run=${runId} idea=${added1.id} title="每周追踪 VPS 价格" provenance="记忆「VPS 项目」；10-25 的对话"`), mine.join("\n"));
  assert.ok(mine.includes(`ideas added run=${runId} idea=${added2.id} title="对比带宽" provenance="文档「价格报告」"`));
  assert.ok(mine.includes(`ideas done run=${runId} cost=$0.083 added=2 note="${NOTE}"`), mine.join("\n"));
  assert.ok(mine.some((line) => /dropping idea 3/.test(line)), "the idea that was left out is logged");
});

test("a result that is not a success ends the run failed, charges the cost so far, adds nothing and clears the generation", async () => {
  const s = stack();
  const lines = logged();
  const t = start(s, { turn: () => ({ subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 0.21, errors: [] }) });

  const runId = t.generate();
  await until("the run to end", () => t.ended(runId));

  const run = t.run(runId);
  assert.equal(run?.status, "failed");
  assert.match(run?.error ?? "", /error_max_budget_usd/);
  assert.equal(run?.costUsd, 0.21);
  assert.equal(t.state().spendDayUsd, 0.21);
  assert.equal(t.state().totalCostUsd, 0.21);
  assert.deepEqual(s.ideas.list(), []);
  assert.equal(s.ideas.generatingRunId(), undefined);
  assert.ok(lines().some((line) => line.includes(`ideas failed run=${runId} cost=$0.210`)));
  await sleep(50);
  assert.deepEqual(t.messages(), [], "a failure posts nothing either");
  assert.deepEqual(outcomeOf(s, runId), { status: "failed", trigger: "requested", added: 0 }, "and records that it failed, with no note");
});

test("an answer that is not an answer, a call without a result and a call that throws all end the run failed", async () => {
  const s = stack();
  const turns: IdeasTurn[] = [
    () => ({ structured_output: { items: [] }, total_cost_usd: 0.05 }),
    () => undefined,
    () => Promise.reject(new Error("socket hang up")),
    () => answers([onceIdea()], 0.07, "  "),
  ];
  let n = 0;
  const t = start(s, { turn: (...args) => (turns[n++] ?? turns[0] ?? (() => undefined))(...args) });
  const expected = [
    [0.05, /malformed/],
    [0, /without a result/],
    [0, /socket hang up/],
    [0.07, /malformed answer: note /],
  ] as const;
  for (const [cost, pattern] of expected) {
    const runId = t.generate();
    await until("the run to end", () => t.ended(runId));
    assert.equal(t.run(runId)?.status, "failed");
    assert.equal(t.run(runId)?.costUsd, cost);
    assert.match(t.run(runId)?.error ?? "", pattern);
    assert.equal(s.ideas.generatingRunId(), undefined, "cleared, so the next can start");
    assert.deepEqual(outcomeOf(s, runId), { status: "failed", trigger: "requested", added: 0 }, "each records that it failed, with no note");
  }
  assert.deepEqual(s.ideas.list(), []);
  assert.equal(t.state().spendDayUsd, 0.05 + 0.07, "a malformed answer is charged what it cost, the idea in it is not added");
});

test("the generation is cleared and its outcome recorded in the store before the run is recorded as ended", async () => {
  const s = stack();
  const t = start(s, { turn: () => answers([onceIdea()]) });
  const seen: [string | undefined, string | undefined][] = [];
  const stop = s.events.subscribe((event) => {
    if (event.type === "run.updated" && event.data.kind === "ideas" && event.data.status === "done") seen.push([s.ideas.generatingRunId(), s.ideas.lastGeneration()?.runId]);
  });
  cleanups.push(async () => stop());

  const runId = t.generate();
  await until("the run to end", () => t.ended(runId));

  assert.deepEqual(seen, [[undefined, runId]], "a client told the run is done finds no generation, and reads the outcome of this one");
});

test("a done run records its outcome: how many ideas the store added, the note, what started it and when, with no event", async () => {
  const s = stack();
  const t = start(s, { turn: () => answers([idea(), onceIdea(), idea({ title: "t".repeat(81) })], 0.083, "  这次想到两个，\n还有一个没成形。 ") });
  const before = s.events.readSince(0).length;

  const runId = t.generate("requested");
  await until("the run to end", () => t.ended(runId));

  assert.equal(s.ideas.list().length, 2, "the third was dropped");
  assert.deepEqual(outcomeOf(s, runId), { status: "done", trigger: "requested", added: 2, note: "这次想到两个， 还有一个没成形。" }, "added counts the ideas in the store, not the proposals");
  const saved = IdeaListSchema.parse(JSON.parse(fs.readFileSync(path.join(s.dir, "ideas.json"), "utf8")));
  assert.deepEqual(saved.lastGeneration, s.ideas.lastGeneration());
  assert.equal(saved.generatingRunId, undefined);
  const types = s.events.readSince(before).map((event) => event.type);
  assert.equal(types.filter((type) => type !== "run.updated" && type !== "idea.updated").length, 0, "nothing but the run and the ideas");
  assert.equal(types.filter((type) => type === "idea.updated").length, 2, "and the outcome is no event of its own");
});

test("a generation that adds none is done, and records added 0 with the model's reason", async () => {
  const s = stack();
  const t = start(s, { turn: () => answers([], 0.04, "最近的对话多是在测试功能，暂时没有值得提的。") });

  const runId = t.generate("daily");
  await until("the run to end", () => t.ended(runId));

  assert.equal(t.run(runId)?.status, "done");
  assert.deepEqual(outcomeOf(s, runId), { status: "done", trigger: "daily", added: 0, note: "最近的对话多是在测试功能，暂时没有值得提的。" });
});

test("a long note is cut to the contract's length, so the outcome is still recorded", async () => {
  const s = stack();
  const t = start(s, { turn: () => answers([onceIdea()], 0.05, "理".repeat(400)) });

  const runId = t.generate();
  await until("the run to end", () => t.ended(runId));

  assert.equal(t.run(runId)?.status, "done");
  assert.equal(s.ideas.generatingRunId(), undefined);
  assert.equal(Array.from(s.ideas.lastGeneration()?.note ?? "").length, 300);
});

test("each end replaces the last outcome: the latest generation that ended is the one recorded", async () => {
  const s = stack();
  const turns: IdeasTurn[] = [() => answers([], 0.01, "第一次没有。"), () => ({ subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 0.2, errors: [] }), () => answers([onceIdea()], 0.05, "第三次有一个。")];
  let n = 0;
  const t = start(s, { turn: (...args) => (turns[n++] ?? (() => undefined))(...args) });

  const first = t.generate("daily");
  await until("the first run to end", () => t.ended(first));
  assert.deepEqual(outcomeOf(s, first), { status: "done", trigger: "daily", added: 0, note: "第一次没有。" });
  const second = t.generate("requested");
  await until("the second run to end", () => t.ended(second));
  assert.deepEqual(outcomeOf(s, second), { status: "failed", trigger: "requested", added: 0 });
  const third = t.generate("requested");
  await until("the third run to end", () => t.ended(third));
  assert.deepEqual(outcomeOf(s, third), { status: "done", trigger: "requested", added: 1, note: "第三次有一个。" });
});

test("a generation that is refused records nothing", async () => {
  const s = stack();
  const hold = held();
  const t = start(s, { turn: hold.turn });
  const first = t.generate();
  await until("the call", () => hold.waiting === 1);

  assert.equal(t.handler.generateIdeas("daily").ok, false, "refused while one runs");
  hold.release(answers([]));
  await until("the run to end", () => t.ended(first));

  assert.equal(s.ideas.lastGeneration()?.runId, first);
  assert.equal(s.ideas.lastGeneration()?.trigger, "requested");
});

test("the trigger reaches the call: a requested generation is asked for at least one idea, a daily one may give none", async () => {
  const s = stack();
  const t = start(s, { turn: () => answers([onceIdea()]) });

  const requested = t.generate("requested");
  await until("the requested run to end", () => t.ended(requested));
  const daily = t.generate("daily");
  await until("the daily run to end", () => t.ended(daily));

  const [first, second] = t.agent.ideasCalls;
  assert.ok(first && second);
  const minItems = (options: Options) => (options.outputFormat?.schema as { properties: { ideas: { minItems?: number } } }).properties.ideas.minItems;
  assert.match(first.prompt, /The owner asked for ideas just now\. Suggest one to three ideas/);
  assert.match(String(first.options.systemPrompt), /at least one/);
  assert.equal(minItems(first.options), 1);
  assert.match(second.prompt, /Suggest up to three ideas, or none\.$/);
  assert.match(String(second.options.systemPrompt), /Zero ideas is a good answer/);
  assert.equal(minItems(second.options), undefined);
  assert.equal(outcomeOf(s, requested), undefined, "the daily one replaced the requested one");
  assert.equal(s.ideas.lastGeneration()?.trigger, "daily");
});

test("a second generation is refused with 409 while one is running, and a new one starts once it is over", async () => {
  const s = stack();
  const hold = held();
  const t = start(s, { turn: hold.turn });
  const first = t.generate();

  assert.deepEqual(t.handler.generateIdeas("requested"), { ok: false, status: 409, error: "ideas are being generated" });
  await until("the call", () => hold.waiting === 1);
  assert.deepEqual(t.handler.generateIdeas("requested"), { ok: false, status: 409, error: "ideas are being generated" });
  assert.equal(t.ideasRuns().length, 1, "a refusal leaves no run behind");

  hold.release(answers([]));
  await until("the run to end", () => t.ended(first));
  const second = t.generate();
  await until("the second call", () => hold.waiting === 1);
  hold.release(answers([]));
  await until("the second run to end", () => t.ended(second));
  assert.notEqual(first, second);
});

test("over the daily cap a generation is refused with 409, and nothing is recorded", async () => {
  const s = stack();
  fs.mkdirSync(path.dirname(s.stateFile), { recursive: true });
  fs.writeFileSync(s.stateFile, JSON.stringify({ owner: { model: "sonnet", sessionCostUsd: 0, totalCostUsd: 5, spendDay: localDate(), spendDayUsd: 5 } }));
  const t = start(s);

  assert.deepEqual(t.handler.generateIdeas("requested"), { ok: false, status: 409, error: "today's spend cap is reached" });
  assert.deepEqual(t.ideasRuns(), []);
  assert.equal(s.ideas.generatingRunId(), undefined);
  await sleep(50);
  assert.equal(t.agent.ideasCalls.length, 0);
});

test("a generation's own cost counts toward the cap: once it has spent the day's budget, the next is refused", async () => {
  const s = stack();
  const t = start(s, { turn: () => answers([], 5) });
  const runId = t.generate();
  await until("the run to end", () => t.ended(runId));
  assert.deepEqual(t.handler.generateIdeas("requested"), { ok: false, status: 409, error: "today's spend cap is reached" });
});

test("without an idea store a generation is refused with 503", () => {
  const s = stack();
  const t = start(s, { ideas: false });
  assert.deepEqual(t.handler.generateIdeas("requested"), { ok: false, status: 503, error: "idea generation is not available" });
  assert.deepEqual(t.ideasRuns(), []);
});

test("once Alfred is shutting down a generation is refused with 409", async () => {
  const s = stack();
  const t = start(s);
  await t.handler.shutdown();
  assert.deepEqual(t.handler.generateIdeas("requested"), { ok: false, status: 409, error: "Alfred is shutting down" });
  assert.deepEqual(t.ideasRuns(), []);
});

test("a shutdown aborts a live generation: it ends lost, the generation is cleared, nothing is posted and the owner's next message does not name it", async () => {
  const s = stack();
  const hold = held();
  const lines = logged();
  const t = start(s, { turn: hold.turn });
  const runId = t.generate();
  await until("the call", () => hold.waiting === 1);
  const signal = t.agent.ideasCalls[0]?.options.abortController?.signal;
  assert.equal(signal?.aborted, false);

  await t.handler.shutdown();

  assert.equal(signal?.aborted, true, "the call was aborted");
  await until("the run to end", () => t.ended(runId));
  assert.equal(t.run(runId)?.status, "lost");
  assert.match(t.run(runId)?.error ?? "", /重启/);
  assert.equal(s.ideas.generatingRunId(), undefined);
  assert.deepEqual(s.ideas.list(), []);
  assert.equal(t.state().lostRuns, undefined, "a lost generation is not named, as a memory scan is not");
  assert.deepEqual(t.messages(), []);
  assert.ok(lines().some((line) => line.includes(`ideas lost run=${runId}`)));
  assert.equal(s.ideas.lastGeneration(), undefined, "a lost run records no outcome");
});

test("a lost run leaves the outcome of the generation before it as it was", async () => {
  const s = stack();
  const hold = held();
  const turns: IdeasTurn[] = [() => answers([], 0.01, "上一次没有。"), hold.turn];
  let n = 0;
  const t = start(s, { turn: (...args) => (turns[n++] ?? (() => undefined))(...args) });
  const first = t.generate("daily");
  await until("the first run to end", () => t.ended(first));
  const before = s.ideas.lastGeneration();
  assert.ok(before);
  const second = t.generate("requested");
  await until("the call", () => hold.waiting === 1);

  await t.handler.shutdown();

  await until("the second run to end", () => t.ended(second));
  assert.equal(t.run(second)?.status, "lost");
  assert.equal(s.ideas.generatingRunId(), undefined);
  assert.deepEqual(s.ideas.lastGeneration(), before);
});

test("a generation whose call answers anyway after the shutdown began adds nothing and is lost", async () => {
  const s = stack();
  let called = false;
  const t = start(s, {
    turn: async () => {
      called = true;
      await sleep(100);
      return answers([onceIdea()], 0.06);
    },
  });
  const runId = t.generate();
  await until("the call", () => called);

  await t.handler.shutdown();

  await until("the run to end", () => t.ended(runId));
  assert.equal(t.run(runId)?.status, "lost");
  assert.deepEqual(s.ideas.list(), []);
  assert.equal(s.ideas.generatingRunId(), undefined);
  assert.equal(s.ideas.lastGeneration(), undefined, "its answer is not recorded either");
});

test("a start finds a generation a crash left running: it is marked lost, and the owner is not told", async () => {
  const s = stack();
  const crashed = new RunRecorder({ kind: "ideas", title: "想法", model: MODELS.sonnet, events: s.events });
  const task = new RunRecorder({ kind: "task", title: "晨报", model: MODELS.sonnet, events: s.events });
  const t = start(s);

  assert.equal(readRunFile(crashed.id)?.status, "lost");
  assert.equal(readRunFile(task.id)?.status, "lost");
  const named = ((t.state().lostRuns ?? []) as { id: string }[]).map((r) => r.id);
  assert.deepEqual(named, [task.id], "the task run is named, the generation is not");
});

test("a generation runs beside a task run and without the memory lock: a scan that holds it does not stop it", async () => {
  const s = stack();
  const hold = held();
  const t = start(s, { turn: hold.turn });
  const lock = new MemoryLock(MEMORY_LOCK_FILE);
  assert.ok(lock.tryAcquire("scan"), "a memory scan holds the lock");
  try {
    const runId = t.generate();
    await until("the call", () => hold.waiting === 1);
    assert.equal(lock.current()?.holder, "scan", "the lock is still the scan's");

    const task = s.tasks.create({ title: "晨报", brief: "总结", schedule: { kind: "daily", time: "08:00" } }, "manual");
    assert.ok(t.handler.runTask(task.id));
    await until("the task run", () => t.lastRuns().some((r) => r.kind === "task" && r.taskId === task.id && r.status === "done"));
    assert.equal(t.run(runId)?.status, "running", "the generation goes on");

    hold.release(answers([onceIdea()]));
    await until("the generation to end", () => t.ended(runId));
    assert.equal(t.run(runId)?.status, "done");
    assert.equal(lock.current()?.holder, "scan", "and the lock is still the scan's");
  } finally {
    lock.release();
  }
  assert.equal(s.ideas.list().length, 1);
});

test("the chat goes on while a generation is live", async () => {
  const s = stack();
  const hold = held();
  const t = start(s, { turn: hold.turn });
  const runId = t.generate();
  await until("the call", () => hold.waiting === 1);

  await t.handler.submit({ text: "你好", files: [] });
  await until("the chat reply", () => t.messages().some((m) => m.direction === "out" && m.text === "echo: 你好"));
  assert.equal(t.run(runId)?.status, "running", "the generation is still live");

  hold.release(answers([]));
  await until("the generation to end", () => t.ended(runId));
});

test("a generation does not touch the workspace and starts no run of the lane: its files are as they were", async () => {
  const s = stack();
  const t = start(s, { turn: () => answers([onceIdea()]) });
  const snapshot = () =>
    fs
      .readdirSync(workspace, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = path.join(entry.parentPath, entry.name);
        return [path.relative(workspace, file), fs.readFileSync(file, "utf8"), fs.statSync(file).mtimeMs] as const;
      })
      .sort((a, b) => a[0].localeCompare(b[0]));
  const before = snapshot();

  const runId = t.generate();
  await until("the run to end", () => t.ended(runId));

  assert.deepEqual(snapshot(), before);
  assert.equal(readRunFile(runId)?.files.length, 0);
  assert.equal(t.agent.chatQueries.length, 0, "and no agent run of the lane was started");
});

test("the idea commands hand idea.generate to the handler, and the answers are the handler's", async () => {
  const s = stack();
  const hold = held();
  const t = start(s, { turn: hold.turn });
  const commands = ideaCommands(s.ideas, s.tasks, { generate: (trigger) => t.handler.generateIdeas(trigger) });

  const first = await commands.generate({ type: "idea.generate" });
  assert.ok(first.ok);
  assert.equal(IdeaGenerationAcceptedSchema.safeParse(first.body).success, true);
  assert.deepEqual(await commands.generate({ type: "idea.generate" }), { ok: false, status: 409, error: "ideas are being generated" });
  await until("the call", () => hold.waiting === 1);
  hold.release(answers([]));
  await until("the run to end", () => t.ended(first.body.runId));
});
