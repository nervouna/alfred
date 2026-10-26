// Scheduled task runs on a fake channel and a fake agent: no model is called, nothing is sent anywhere.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import type { Message, Run } from "../api/schema.ts";
import type { Outbound } from "../channels.ts";
import type { TaskInput } from "../tasks/store.ts";

// Schedules are local times: pin the zone before any date is made, so the result does not depend on the machine.
process.env.TZ = "Asia/Taipei";
// store.ts and config.ts read these at import time, so set them before loading the modules under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-task-runs-")));
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
const { readRunFile } = await import("../runs.ts");
const { localDate } = await import("../files.ts");
const { TASK_TOOL_NAMES } = await import("./task-tools.ts");

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

/** What a turn ends with: the reply of a successful result, or the fields of a result of another kind. */
type Ended = string | Record<string, unknown>;
type TurnFn = (prompt: string, signal: AbortSignal, options: Options) => Promise<Ended>;

interface Query {
  options: Options;
  prompts: string[];
}

/** Stands in for the SDK's query(): answers every message of the input with one result, in a turn of its own. */
function fakeAgent(turn: TurnFn = async (prompt) => `echo: ${prompt}`) {
  const queries: Query[] = [];
  const runQuery = ((params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => {
    const options = params.options ?? {};
    const signal = options.abortController?.signal ?? new AbortController().signal;
    const record: Query = { options, prompts: [] };
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
      stopTask: async () => {},
      setModel: async () => {},
      interrupt: async () => ({ still_queued: [] }),
    });
  }) as unknown as typeof query;
  return {
    runQuery,
    queries,
    /** The queries of scheduled runs: those that do not keep their session. */
    get taskQueries(): Query[] {
      return queries.filter((q) => q.options.persistSession === false);
    },
    get chatQueries(): Query[] {
      return queries.filter((q) => q.options.persistSession !== false);
    },
  };
}

/** A turn that ends when the test says so, or when the run is aborted. */
function held() {
  const waiting: ((ended: Ended) => void)[] = [];
  return {
    turn: (_prompt: string, signal: AbortSignal) =>
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

const isScheduled = (options: Options) => options.persistSession === false;

/** A channel that records what it is asked to send. */
function fakeApp() {
  const texts: string[] = [];
  const files: string[] = [];
  const state = { waiting: false, hold: undefined as Promise<void> | undefined };
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
      texts.push(text);
    },
    async file(absPath, caption) {
      if (caption) texts.push(caption);
      files.push(absPath);
      return "file";
    },
  };
  return { out, texts, files, state };
}

// Tuesday 09:00 in Taipei.
const T0 = new Date("2026-10-27T01:00:00Z");
/** The clock the task stores read. */
let clock = T0;
const minutesAfterStart = (n: number) => new Date(T0.getTime() + n * 60_000);

let stacks = 0;

/** A task store and an event log of their own, both reading the clock. */
function stack() {
  clock = T0;
  const dir = path.join(tmp, `stack-${stacks++}`);
  const events = new EventLog(path.join(dir, "events.jsonl"));
  const store = new TaskStore({ file: path.join(dir, "tasks.json"), events, now: () => clock });
  return { dir, events, store, stateFile: path.join(dir, "agent-state.json") };
}

/** A one-time task whose time comes `after` minutes after the start; with the clock moved past it, the task is due. */
function oneTime(s: ReturnType<typeof stack>, title: string, extra: Partial<TaskInput> = {}, after = 1) {
  return s.store.create(
    { title, brief: `Brief of ${title}: list the changes.`, schedule: { kind: "once", at: minutesAfterStart(after).toISOString() }, ...extra },
    "manual",
  );
}

/** A daily task whose next run is this evening. */
function evening(s: ReturnType<typeof stack>, title: string) {
  return s.store.create({ title, brief: `Brief of ${title}`, schedule: { kind: "daily", time: "23:00" } }, "manual");
}

/** A handler on the stack's task store, a fake channel and a fake agent. It reads the stack's files, so tasks made before it starts are polled at once. */
function start(s: ReturnType<typeof stack>, options: { turn?: TurnFn; taskPollMs?: number; tasks?: boolean } = {}) {
  const app = fakeApp();
  const agent = fakeAgent(options.turn);
  const handler = createAgentHandler({
    out: app.out,
    events: s.events,
    stateFile: s.stateFile,
    runQuery: agent.runQuery,
    ...(options.tasks === false ? {} : { tasks: s.store }),
    taskPollMs: options.taskPollMs,
  });
  cleanups.push(() => handler.shutdown());
  const messages = (): Message[] => s.events.readSince(0).flatMap((e) => (e.type === "message.created" ? [e.data] : []));
  const runs = (): Run[] => s.events.readSince(0).flatMap((e) => (e.type === "run.updated" ? [e.data] : []));
  /** The last state of every run, oldest first. */
  const lastRuns = (): Run[] => [...new Map(runs().map((r) => [r.id, r])).values()];
  const taskRuns = (taskId?: string): Run[] => lastRuns().filter((r) => r.taskId !== undefined && (taskId === undefined || r.taskId === taskId));
  const finished = (taskId: string) => taskRuns(taskId).some((r) => r.status !== "running");
  /** The runs the owner's messages started, which belong to no task. */
  const chatRuns = (): Run[] => lastRuns().filter((r) => r.kind === "task" && r.taskId === undefined);
  const chatDone = (n: number) => chatRuns().filter((r) => r.status === "done").length >= n;
  /** The owner's record in the state file; empty until something is kept. */
  const state = (): Record<string, unknown> => {
    try {
      return (JSON.parse(fs.readFileSync(s.stateFile, "utf8")) as Record<string, Record<string, unknown>>).owner ?? {};
    } catch {
      return {};
    }
  };
  const send = (text: string) => handler.submit({ text, files: [] });
  return { handler, app, agent, messages, runs, lastRuns, taskRuns, chatRuns, chatDone, finished, state, send };
}

/** Alfred's tools in these options, by name. */
function registeredTools(options: Options): string[] {
  const server = options.mcpServers?.alfred as unknown as { instance: { _registeredTools: Record<string, unknown> } };
  return Object.keys(server.instance._registeredTools);
}

/** Calls one of Alfred's tools, as the agent of the query with these options would, and returns the text it answers with. */
async function callTool(options: Options, name: string, args: Record<string, unknown>): Promise<string> {
  const server = options.mcpServers?.alfred as unknown as {
    instance: { _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }> };
  };
  const tool = server.instance._registeredTools[name];
  assert.ok(tool, name);
  const result = (await tool.handler(args, {})) as { content: { text: string }[] };
  return result.content.map((c) => c.text).join("\n");
}

/** The reason the query's PreToolUse hooks give for denying a tool call, or undefined when they let it through. */
async function denial(options: Options, tool: string, input: Record<string, unknown>, agent?: { id: string; type: string }): Promise<string | undefined> {
  const hookInput = {
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: input,
    tool_use_id: "toolu_1",
    ...(agent ? { agent_id: agent.id, agent_type: agent.type } : {}),
  };
  for (const matcher of options.hooks?.PreToolUse ?? []) {
    for (const hook of matcher.hooks) {
      const out = (await hook(hookInput as never, "toolu_1", { signal: new AbortController().signal })) as {
        hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
      };
      if (out.hookSpecificOutput?.permissionDecision === "deny") return out.hookSpecificOutput.permissionDecisionReason ?? "";
    }
  }
  return undefined;
}

test("a due task starts a query of its own: a new session that is not kept, the task's model and budget, no questions", async () => {
  const s = stack();
  const task = oneTime(s, "晨报", { model: "haiku", budgetUsd: 0.5 });
  clock = minutesAfterStart(2);
  const t = start(s);
  await until("the task run to start", () => t.agent.queries.length === 1);

  const options = t.agent.queries[0]?.options;
  assert.ok(options);
  assert.equal(options.resume, undefined, "no session to resume");
  assert.equal(options.persistSession, false, "the transcript is never kept, so it is never scanned or resumed");
  assert.equal(options.model, "claude-haiku-5-5");
  assert.equal(options.maxBudgetUsd, 0.5);
  assert.ok(Array.isArray(options.tools) && !options.tools.includes("AskUserQuestion"));
  assert.equal(options.canUseTool, undefined);
  assert.doesNotMatch(String(options.systemPrompt), /AskUserQuestion/);
  await until("the task run to end", () => t.finished(task.id));
});

test("a chat query keeps its session and the chat's budget", async () => {
  const s = stack();
  const t = start(s);
  await t.send("你好");
  await until("the reply", () => t.app.texts.length === 1);

  const options = t.agent.chatQueries[0]?.options;
  assert.equal(options?.persistSession, undefined);
  assert.equal(options?.maxBudgetUsd, 10);
  assert.ok(Array.isArray(options?.tools) && options.tools.includes("AskUserQuestion"));
});

test("the first message holds the brief, the task and when it is due, and where the report goes", async () => {
  const s = stack();
  const task = oneTime(s, "晨报");
  clock = minutesAfterStart(2);
  const t = start(s);
  await until("the task run's first message", () => t.agent.taskQueries[0]?.prompts.length === 1);

  const prompt = t.agent.taskQueries[0]?.prompts[0] ?? "";
  assert.ok(prompt.includes(`Brief of 晨报: list the changes.`), "the brief");
  assert.ok(prompt.includes(`"晨报"`) && prompt.includes(task.id), "the task's title and id");
  assert.match(prompt, /Tuesday 2026-10-27 09:01 \(Asia\/Taipei\)/, "the scheduled time in the owner's zone");
  assert.match(prompt, /not watching/);
  assert.match(prompt, /ask no questions/i);
  assert.match(prompt, /assumptions/);
  assert.ok(prompt.includes(`reports/tasks/${task.id}/`), "where the report is written");
  assert.match(prompt, /no previous report/i);
  assert.ok(prompt.indexOf("[Alfred]") < prompt.indexOf("Brief of 晨报"), "the preamble comes before the brief");
  await until("the task run to end", () => t.finished(task.id));
});

test("the first message names the newest file of the task's report directory as the previous report", async () => {
  const s = stack();
  const task = oneTime(s, "晨报");
  const dir = path.join(workspace, "reports", "tasks", task.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "2026-10-25.md"), "older");
  fs.writeFileSync(path.join(dir, "2026-10-26.md"), "newer");
  fs.utimesSync(path.join(dir, "2026-10-25.md"), new Date("2026-10-25T01:00:00Z"), new Date("2026-10-25T01:00:00Z"));
  fs.utimesSync(path.join(dir, "2026-10-26.md"), new Date("2026-10-26T01:00:00Z"), new Date("2026-10-26T01:00:00Z"));
  clock = minutesAfterStart(2);
  const t = start(s);
  await until("the task run's first message", () => t.agent.taskQueries[0]?.prompts.length === 1);

  const prompt = t.agent.taskQueries[0]?.prompts[0] ?? "";
  assert.ok(prompt.includes(`reports/tasks/${task.id}/2026-10-26.md`), "the newest report");
  assert.ok(!prompt.includes("2026-10-25.md"));
  assert.doesNotMatch(prompt, /no previous report/i);
  await until("the task run to end", () => t.finished(task.id));
});

test("a run's record carries the task and its title, its messages carry the run and the task, and the store records the run", async () => {
  const s = stack();
  const task = oneTime(s, "晨报", { model: "haiku" });
  clock = minutesAfterStart(2);
  const t = start(s, { turn: async () => "三条变化。\n细节在报告里。" });
  await until("the task run to end", () => t.finished(task.id));

  const [run] = t.taskRuns(task.id);
  assert.ok(run);
  assert.deepEqual([run.kind, run.title, run.status, run.model, run.taskId], ["task", "晨报", "done", "claude-haiku-5-5", task.id]);
  assert.equal(readRunFile(run.id)?.taskId, task.id);
  const out = t.messages().filter((m) => m.direction === "out");
  assert.equal(out.length, 1);
  assert.deepEqual([out[0]?.text, out[0]?.runId, out[0]?.taskId, out[0]?.channel], ["三条变化。\n细节在报告里。", run.id, task.id, "app"]);
  const recorded = s.store.get(task.id);
  assert.equal(recorded?.lastRunId, run.id, "recordRun was called with the run");
  assert.equal(recorded?.lastRunAt, run.startedAt);
});

test("files the run sends are messages of the run and the task", async () => {
  const s = stack();
  const task = oneTime(s, "晨报");
  const report = `reports/tasks/${task.id}/2026-10-27.md`;
  clock = minutesAfterStart(2);
  const t = start(s, {
    turn: async (_prompt, _signal, options) => {
      fs.mkdirSync(path.dirname(path.join(workspace, report)), { recursive: true });
      fs.writeFileSync(path.join(workspace, report), "# 晨报\n");
      await callTool(options, "send_file", { path: report, caption: "报告在这里" });
      return "完成了。";
    },
  });
  await until("the task run to end", () => t.finished(task.id));

  const out = t.messages().filter((m) => m.direction === "out");
  assert.deepEqual(
    out.map((m) => [m.text, m.files.map((f) => f.path), m.taskId]),
    [
      ["报告在这里", [], task.id],
      ["", [report], task.id],
      ["完成了。", [], task.id],
    ],
  );
  assert.ok(out.every((m) => m.runId === t.taskRuns(task.id)[0]?.id));
});

test("a task run's spend counts toward the owner's day and total, and not toward the chat session", async () => {
  const s = stack();
  const task = oneTime(s, "晨报");
  clock = minutesAfterStart(2);
  const t = start(s, {
    turn: async () => ({ result: "好了", total_cost_usd: 0.25, modelUsage: { "claude-sonnet-5-5": { costUSD: 0.25 } } }),
  });
  await until("the task run to end", () => t.finished(task.id));

  const state = t.state();
  assert.equal(state.totalCostUsd, 0.25);
  assert.equal(state.spendDay, localDate());
  assert.equal(state.spendDayUsd, 0.25);
  assert.ok(!state.sessionCostUsd, "the chat session's figure is untouched");
  assert.equal(state.sessionId, undefined, "so is its session");
  assert.equal(state.lastRunAt, undefined, "and its idle clock");
  assert.equal(readRunFile(t.taskRuns(task.id)[0]?.id ?? "")?.costUsd, 0.25, "it is on the run's record");
});

test("the chat goes on while a task run is live: a message gets a run of its own", async () => {
  const s = stack();
  const hold = held();
  const task = oneTime(s, "晨报");
  clock = minutesAfterStart(2);
  const t = start(s, { turn: (prompt, signal, options) => (isScheduled(options) ? hold.turn(prompt, signal) : Promise.resolve(`echo: ${prompt}`)) });
  await until("the task run to start", () => hold.waiting === 1);

  await t.send("你好");
  await until("the chat reply", () => t.app.texts.includes("echo: 你好"));
  const chat = t.lastRuns().find((r) => r.taskId === undefined && r.kind === "task");
  assert.ok(chat, "the message got a run");
  assert.equal(chat.status, "done");
  assert.equal(t.taskRuns(task.id)[0]?.status, "running", "the task run is still live");

  hold.release("好了");
  await until("the task run to end", () => t.finished(task.id));
  assert.deepEqual(t.agent.chatQueries.map((q) => q.prompts), [["你好"]], "the chat's query never saw the task run's message");
});

test("two due tasks run one after the other, the one due first first", async () => {
  const s = stack();
  const hold = held();
  const later = oneTime(s, "后到的", {}, 3);
  const first = oneTime(s, "先到的", {}, 1);
  clock = minutesAfterStart(5);
  const t = start(s, { turn: hold.turn });
  await until("the first task run to start", () => hold.waiting === 1);
  await sleep(100);
  assert.equal(t.agent.taskQueries.length, 1, "the second waits for its turn");
  assert.match(t.agent.taskQueries[0]?.prompts[0] ?? "", /Brief of 先到的/);

  hold.release("第一份");
  await until("the second task run to start", () => t.agent.taskQueries.length === 2);
  assert.match(t.agent.taskQueries[1]?.prompts[0] ?? "", /Brief of 后到的/);
  assert.equal(t.finished(first.id), true);
  assert.equal(t.finished(later.id), false);
  hold.release("第二份");
  await until("the second task run to end", () => t.finished(later.id));
});

test("tasks that fall due while Alfred runs start at the next poll", async () => {
  const s = stack();
  const task = oneTime(s, "晨报", {}, 10);
  const t = start(s, { taskPollMs: 20 });
  await sleep(100);
  assert.equal(t.agent.queries.length, 0, "not due yet");

  clock = minutesAfterStart(11);
  await until("the task run to start", () => t.agent.taskQueries.length === 1);
  await until("the task run to end", () => t.finished(task.id));
});

test("over the daily cap a scheduled run does not start: it is skipped, and one message says so", async () => {
  const s = stack();
  const task = oneTime(s, "晨报");
  fs.mkdirSync(path.dirname(s.stateFile), { recursive: true });
  fs.writeFileSync(s.stateFile, JSON.stringify({ owner: { model: "sonnet", sessionCostUsd: 0, totalCostUsd: 5.5, spendDay: localDate(), spendDayUsd: 5.5 } }));
  clock = minutesAfterStart(2);
  const t = start(s);
  await until("the message", () => t.messages().some((m) => m.direction === "out"));
  await sleep(100);

  assert.equal(t.agent.queries.length, 0, "no query");
  assert.deepEqual(s.store.get(task.id)?.skips[0], { at: minutesAfterStart(1).toISOString(), reason: "daily-cap" });
  assert.equal(s.store.get(task.id)?.lastRunId, undefined);
  const out = t.messages().filter((m) => m.direction === "out");
  assert.equal(out.length, 1);
  assert.equal(out[0]?.taskId, task.id);
  assert.equal(out[0]?.runId, undefined, "there is no run");
  assert.match(out[0]?.text ?? "", /晨报/);
  assert.match(out[0]?.text ?? "", /每日上限 \$5\.00/);
  assert.match(out[0]?.text ?? "", /已花 \$5\.50/);
  assert.equal(t.taskRuns().length, 0);
});

test("over the daily cap a run now does not start either: no skip, and one message says so", async () => {
  const s = stack();
  const task = evening(s, "晚报");
  fs.mkdirSync(path.dirname(s.stateFile), { recursive: true });
  fs.writeFileSync(s.stateFile, JSON.stringify({ owner: { model: "sonnet", sessionCostUsd: 0, totalCostUsd: 5, spendDay: localDate(), spendDayUsd: 5 } }));
  const t = start(s);

  assert.equal(t.handler.runTask(task.id), true);
  await until("the message", () => t.messages().some((m) => m.direction === "out"));
  await sleep(100);

  assert.equal(t.agent.queries.length, 0);
  assert.deepEqual(s.store.get(task.id)?.skips, []);
  const out = t.messages().filter((m) => m.direction === "out");
  assert.equal(out.length, 1);
  assert.equal(out[0]?.taskId, task.id);
  assert.match(out[0]?.text ?? "", /每日上限 \$5\.00/);
});

test("a run now joins the queue and leaves the task's next run alone; an unknown task is refused", async () => {
  const s = stack();
  const task = evening(s, "晚报");
  const next = task.nextRunAt;
  assert.equal(next, "2026-10-27T15:00:00.000Z");
  const t = start(s);

  assert.equal(t.handler.runTask("zzzzzz"), false);
  assert.equal(t.handler.runTask(task.id), true);
  await until("the task run to end", () => t.finished(task.id));
  assert.equal(t.agent.taskQueries.length, 1);
  assert.match(t.agent.taskQueries[0]?.prompts[0] ?? "", /Brief of 晚报/);
  const after = s.store.get(task.id);
  assert.equal(after?.nextRunAt, next);
  assert.equal(after?.status, "active");
  assert.equal(after?.lastRunId, t.taskRuns(task.id)[0]?.id);
});

test("a handler without a task store has no tasks to run", () => {
  const s = stack();
  const task = evening(s, "晚报");
  const t = start(s, { tasks: false });
  assert.equal(t.handler.runTask(task.id), false);
});

test("run.stop stops a task run: it ends stopped and nothing more is posted", async () => {
  const s = stack();
  const hold = held();
  const task = oneTime(s, "晨报");
  clock = minutesAfterStart(2);
  const t = start(s, { turn: hold.turn });
  await until("the task run to start", () => hold.waiting === 1);
  const runId = t.taskRuns(task.id)[0]?.id ?? "";

  assert.equal(await t.handler.stopRun("zzzzzz"), false);
  assert.equal(await t.handler.stopRun(runId), true);
  await until("the task run to end", () => t.finished(task.id));

  assert.equal(t.taskRuns(task.id)[0]?.status, "stopped");
  assert.deepEqual(t.messages(), [], "no failure message, no report");
  assert.deepEqual(t.app.texts, []);
  assert.equal(await t.handler.stopRun(runId), false, "a run that has ended cannot be stopped again");
});

test("a task run's id stops it from the chat as well", async () => {
  const s = stack();
  const hold = held();
  const task = oneTime(s, "晨报");
  clock = minutesAfterStart(2);
  const t = start(s, { turn: hold.turn });
  await until("the task run to start", () => hold.waiting === 1);
  const runId = t.taskRuns(task.id)[0]?.id ?? "";

  await t.send(`/stop ${runId}`);
  await until("the task run to end", () => t.finished(task.id));
  assert.equal(t.taskRuns(task.id)[0]?.status, "stopped");
  assert.match(t.app.texts[0] ?? "", new RegExp(runId));
});

test("shutdown stops the live task run, empties the queue and stops the timer", async () => {
  const s = stack();
  const hold = held();
  const first = oneTime(s, "先到的", {}, 1);
  const second = oneTime(s, "后到的", {}, 2);
  clock = minutesAfterStart(5);
  const t = start(s, { turn: hold.turn, taskPollMs: 20 });
  await until("the first task run to start", () => hold.waiting === 1);

  await t.handler.shutdown();
  await until("the first task run to end", () => t.finished(first.id));
  assert.equal(t.taskRuns(first.id)[0]?.status, "lost", "a run the shutdown cut short is lost, as a chat run is");
  await sleep(100);
  assert.equal(t.agent.queries.length, 1, "the queued run never started");
  assert.equal(t.taskRuns(second.id).length, 0);

  oneTime(s, "更晚的", {}, 6);
  clock = minutesAfterStart(8);
  await sleep(150);
  assert.equal(t.agent.queries.length, 1, "the timer is stopped: a task that falls due afterwards is not taken");
  assert.equal(t.handler.runTask(first.id), false, "and a run now is refused");
});

test("a run a restart cut short is lost, and its occurrence is not run again", async () => {
  const s = stack();
  const hold = held();
  const task = oneTime(s, "晨报");
  clock = minutesAfterStart(2);
  const first = start(s, { turn: hold.turn });
  await until("the task run to start", () => hold.waiting === 1);
  await first.handler.shutdown();
  await until("the task run to end", () => first.finished(task.id));
  const runId = first.taskRuns(task.id)[0]?.id ?? "";

  // The same files, a new process.
  clock = minutesAfterStart(20);
  const store = new TaskStore({ file: path.join(s.dir, "tasks.json"), events: s.events, now: () => clock });
  const second = start({ ...s, store });
  await sleep(150);
  assert.equal(second.agent.queries.length, 0, "the occurrence was taken before the restart");
  await second.send("/help");
  assert.match(second.app.texts[0] ?? "", new RegExp(`^Alfred 重启时中断了 1 个任务：「晨报」（${runId}）`), "the owner's next message names it");
});

test("a chat message queued behind the live chat run starts no run during a shutdown", async () => {
  const s = stack();
  const t = start(s, { tasks: false });
  let release = () => {};
  t.app.state.hold = new Promise<void>((resolve) => (release = resolve));
  await t.send("第一条");
  await until("the final reply to be on its way", () => t.app.state.waiting);
  await t.send("之后的一条");
  assert.match(t.app.texts.at(-1) ?? "", /排在当前任务之后/, "the message is queued behind the run");

  const down = t.handler.shutdown();
  release();
  await down;
  await sleep(150);
  assert.equal(t.agent.queries.length, 1, "the queued message did not start a run");
  assert.deepEqual(t.agent.queries[0]?.prompts, ["第一条"]);
});

test("a run that ends in an error result is failed and posts one message saying so", async () => {
  const s = stack();
  const task = oneTime(s, "晨报");
  clock = minutesAfterStart(2);
  const t = start(s, { turn: async () => ({ subtype: "error_during_execution", is_error: true, errors: ["the model failed"], total_cost_usd: 0.1 }) });
  await until("the task run to end", () => t.finished(task.id));
  await sleep(50);

  const [run] = t.taskRuns(task.id);
  assert.equal(run?.status, "failed");
  const out = t.messages().filter((m) => m.direction === "out");
  assert.equal(out.length, 1);
  assert.deepEqual([out[0]?.taskId, out[0]?.runId], [task.id, run?.id]);
  assert.match(out[0]?.text ?? "", /晨报/);
  assert.match(out[0]?.text ?? "", /运行失败/);
  assert.match(out[0]?.text ?? "", /the model failed/);
  assert.equal(t.state().taskDeliveries, undefined, "a failure is not a delivery");
});

test("a run that reaches its budget is failed and posts one message that names the cap", async () => {
  const s = stack();
  const task = oneTime(s, "晨报", { budgetUsd: 0.5 });
  clock = minutesAfterStart(2);
  const t = start(s, { turn: async () => ({ subtype: "error_max_budget_usd", is_error: true, errors: [], total_cost_usd: 0.52 }) });
  await until("the task run to end", () => t.finished(task.id));
  await sleep(50);

  const [run] = t.taskRuns(task.id);
  assert.equal(run?.status, "failed");
  assert.match(run?.error ?? "", /\$0\.500/);
  const out = t.messages().filter((m) => m.direction === "out");
  assert.equal(out.length, 1);
  assert.equal(out[0]?.taskId, task.id);
  assert.match(out[0]?.text ?? "", /花费.*上限 \$0\.500/);
  assert.equal(t.state().spendDayUsd, 0.52, "what it spent counts");
});

test("a run that throws is failed and posts one message saying so", async () => {
  const s = stack();
  const task = oneTime(s, "晨报");
  clock = minutesAfterStart(2);
  const t = start(s, {
    turn: async () => {
      throw new Error("the process died");
    },
  });
  await until("the task run to end", () => t.finished(task.id));
  await sleep(50);

  assert.equal(t.taskRuns(task.id)[0]?.status, "failed");
  const out = t.messages().filter((m) => m.direction === "out");
  assert.equal(out.length, 1);
  assert.equal(out[0]?.taskId, task.id);
  assert.match(out[0]?.text ?? "", /the process died/);
});

test("the next chat message lists the delivery once, and the one after it does not", async () => {
  const s = stack();
  const task = oneTime(s, "晨报");
  const report = `reports/tasks/${task.id}/2026-10-27.md`;
  clock = minutesAfterStart(2);
  const t = start(s, {
    turn: async (prompt, _signal, options) => {
      if (!isScheduled(options)) return `echo: ${prompt}`;
      fs.mkdirSync(path.dirname(path.join(workspace, report)), { recursive: true });
      fs.writeFileSync(path.join(workspace, report), "# 晨报\n");
      await callTool(options, "send_file", { path: report });
      return "三条变化。\n第二行不会进摘要。";
    },
  });
  await until("the task run to end", () => t.finished(task.id));
  await until("the delivery to be kept", () => Array.isArray(t.state().taskDeliveries));
  const runId = t.taskRuns(task.id)[0]?.id ?? "";

  await t.send("摘要里第二条是什么意思？");
  await until("the first chat run to end", () => t.chatDone(1));
  const first = t.agent.chatQueries[0]?.prompts[0] ?? "";
  assert.ok(first.endsWith("\n\n摘要里第二条是什么意思？"), "the message comes last");
  assert.ok(first.includes(`"晨报"`) && first.includes(task.id) && first.includes(runId), "which task and run");
  assert.ok(first.includes("三条变化。") && !first.includes("第二行不会进摘要"), "the first line of the reply");
  assert.ok(first.includes(report), "the files it sent");
  assert.equal(t.state().taskDeliveries, undefined, "the list is cleared");

  await t.send("谢谢");
  await until("the second chat run to end", () => t.chatDone(2));
  assert.equal(t.agent.chatQueries[1]?.prompts[0], "谢谢", "without a delivery the prompt is unchanged");
});

test("a command leaves the delivery for the next message, which starts a run with it", async () => {
  const s = stack();
  const hold = held();
  const task = oneTime(s, "晨报");
  clock = minutesAfterStart(2);
  const t = start(s, { turn: (prompt, signal, options) => (isScheduled(options) ? Promise.resolve("摘要") : hold.turn(prompt, signal)) });
  await until("the delivery to be kept", () => Array.isArray(t.state().taskDeliveries));

  await t.send("/status");
  assert.ok(Array.isArray(t.state().taskDeliveries), "a command leaves the list for the next message");
  await t.send("先开始");
  await until("the chat run to start", () => hold.waiting === 1);
  assert.ok((t.agent.chatQueries[0]?.prompts[0] ?? "").includes(task.id), "the message that starts the run has the section");
  assert.equal(t.state().taskDeliveries, undefined);
  hold.release("好");
  await until("the chat run to end", () => t.chatDone(1));
});

test("a task run may not write memory/, any ALFRED.md or skills/, and may elsewhere; chat may anywhere", async () => {
  const s = stack();
  const task = oneTime(s, "晨报");
  clock = minutesAfterStart(2);
  const t = start(s);
  await until("the task run to end", () => t.finished(task.id));
  await t.send("你好");
  await until("the chat reply", () => t.agent.chatQueries.length === 1);
  const scheduled = t.agent.taskQueries[0]?.options;
  const chat = t.agent.chatQueries[0]?.options;
  assert.ok(scheduled && chat);

  const protectedWrites: [string, Record<string, unknown>][] = [
    ["Write", { file_path: "memory/x.md" }],
    ["Write", { file_path: path.join(workspace, "memory", "x.md") }],
    ["Edit", { file_path: "ALFRED.md" }],
    ["Edit", { file_path: "reports/ALFRED.md" }],
    ["MultiEdit", { file_path: "notes/alfred.md" }],
    ["Write", { file_path: "skills/weekly/SKILL.md" }],
    ["mcp__alfred__move_file", { from: "notes/a.md", to: "skills/a.md" }],
    ["mcp__alfred__move_file", { from: "memory/user.md", to: ".trash/user.md" }],
    ["mcp__alfred__render_pdf", { source: "notes/a.md", output: "memory/a.pdf" }],
    ["mcp__alfred__render_pdf", { source: "memory/a.md" }],
    ["mcp__alfred__generate_image", { prompt: "x", aspect_ratio: "1:1", output: "skills/x.jpg" }],
  ];
  for (const [tool, input] of protectedWrites) {
    const reason = await denial(scheduled, tool, input);
    assert.match(reason ?? "", /read-only/, `${tool} ${JSON.stringify(input)} in a task run`);
    const sub = await denial(scheduled, tool, input, { id: "agent-1", type: "researcher" });
    assert.ok(sub, `${tool} ${JSON.stringify(input)} in a subagent of a task run`);
    assert.equal(await denial(chat, tool, input), undefined, `${tool} ${JSON.stringify(input)} in chat`);
  }
  // The same name in another case is the same file on a case-insensitive disk.
  assert.ok(await denial(scheduled, "Edit", { file_path: "notes/alfred.MD" }));

  const allowed: [string, Record<string, unknown>][] = [
    ["Write", { file_path: `reports/tasks/${task.id}/2026-10-27.md` }],
    ["Write", { file_path: "notes/memory.md" }],
    ["Read", { file_path: "memory/user.md" }],
    ["Read", { file_path: "ALFRED.md" }],
    ["Glob", { pattern: "skills/**" }],
    ["mcp__alfred__move_file", { from: "notes/a.md", to: "reports/a.md" }],
    ["mcp__alfred__render_pdf", { source: "reports/a.md" }],
  ];
  for (const [tool, input] of allowed) {
    assert.equal(await denial(scheduled, tool, input), undefined, `${tool} ${JSON.stringify(input)} in a task run`);
  }
  assert.match((await denial(scheduled, "Write", { file_path: "/tmp/x" })) ?? "", /outside the workspace/, "the workspace stays the boundary");
});

test("a task run's background Agent calls are denied with a reason it can act on; foreground ones go through", async () => {
  const s = stack();
  const task = oneTime(s, "晨报");
  clock = minutesAfterStart(2);
  const t = start(s);
  await until("the task run to end", () => t.finished(task.id));
  await t.send("你好");
  await until("the chat reply", () => t.agent.chatQueries.length === 1);
  const scheduled = t.agent.taskQueries[0]?.options;
  const chat = t.agent.chatQueries[0]?.options;
  assert.ok(scheduled && chat);

  const call = { subagent_type: "collector", description: "读一页", prompt: "read it" };
  for (const input of [{ ...call, run_in_background: true }, call]) {
    const reason = await denial(scheduled, "Agent", input);
    assert.match(reason ?? "", /run_in_background: false/, JSON.stringify(input));
    assert.match(reason ?? "", /unattended/);
  }
  assert.equal(await denial(scheduled, "Agent", { ...call, run_in_background: false }), undefined, "a foreground subagent works as in chat");
  assert.equal(await denial(chat, "Agent", { ...call, run_in_background: true }), undefined, "chat still starts background subagents");
});

test("/status lists the active tasks with their next run, and the task run in progress", async () => {
  const s = stack();
  const hold = held();
  const running = oneTime(s, "检查", {}, 1);
  const waiting = evening(s, "晚报");
  const paused = evening(s, "停了的");
  s.store.update(paused.id, { status: "paused" });
  clock = minutesAfterStart(2);
  const t = start(s, { turn: hold.turn });
  await until("the task run to start", () => hold.waiting === 1);

  await t.send("/status");
  const status = t.app.texts.at(-1) ?? "";
  assert.ok(status.includes(`定时任务 ${waiting.id}「晚报」：下次 2026-10-27 23:00`), status);
  assert.ok(!status.includes("停了的"), "a paused task is not listed");
  assert.ok(!status.includes(`定时任务 ${running.id}`), "a task that is done is not listed");
  const runId = t.taskRuns(running.id)[0]?.id ?? "";
  assert.match(status, new RegExp(`定时任务运行 ${runId}「检查」，进行中`));
  assert.match(status, /任务：空闲/, "the chat is idle");
  await t.handler.shutdown();
});

const askedQuestions = (s: ReturnType<typeof stack>) => s.events.readSince(0).flatMap((e) => (e.type === "question.asked" ? [e.data] : []));
const answeredQuestions = (s: ReturnType<typeof stack>) => s.events.readSince(0).flatMap((e) => (e.type === "question.answered" ? [e.data] : []));

const briefing = { title: "每日 AI 简报", brief: "Summarize the day's AI news.", schedule: { kind: "daily", time: "08:00" }, model: "haiku", budgetUsd: 0.5 };

test("a chat run is offered the task tools when the handler has a task store; a task run and a handler without one are not", async () => {
  const s = stack();
  const task = oneTime(s, "晨报");
  clock = minutesAfterStart(2);
  const t = start(s);
  await until("the task run to end", () => t.finished(task.id));
  await t.send("你好");
  await until("the chat query", () => t.agent.chatQueries.length === 1);
  const chat = t.agent.chatQueries[0]?.options;
  const scheduled = t.agent.taskQueries[0]?.options;
  assert.ok(chat && scheduled);

  const names = ["task_list", "task_create", "task_update"];
  for (const name of names) {
    assert.ok(registeredTools(chat).includes(name), `chat has ${name}`);
    assert.ok(chat.allowedTools?.includes(`mcp__alfred__${name}`), `chat may call ${name}`);
    assert.ok(!registeredTools(scheduled).includes(name), `the task run has no ${name}`);
    assert.ok(!scheduled.allowedTools?.includes(`mcp__alfred__${name}`));
  }
  assert.match(String(chat.systemPrompt), /^# Tasks$/m);
  assert.doesNotMatch(String(scheduled.systemPrompt), /^# Tasks$/m);

  // A subagent of the chat run is denied them, and the main thread is not.
  for (const tool of TASK_TOOL_NAMES) {
    assert.match((await denial(chat, tool, {}, { id: "agent-1", type: "general-purpose" })) ?? "", /only Alfred does/, tool);
    assert.equal(await denial(chat, tool, {}), undefined, `the main thread calls ${tool}`);
  }

  const bare = stack();
  const b = start(bare, { tasks: false });
  await b.send("你好");
  await until("the chat query", () => b.agent.chatQueries.length === 1);
  const options = b.agent.chatQueries[0]?.options;
  assert.ok(options);
  assert.deepEqual(registeredTools(options).filter((name) => name.startsWith("task_")), []);
  assert.ok(!options.allowedTools?.some((name) => name.includes("task_")));
  assert.doesNotMatch(String(options.systemPrompt), /^# Tasks$/m);
});

test("a task made from chat waits for the owner's tap on a question: nothing exists until 确认, and then the task is the chat's", async () => {
  const s = stack();
  const results: string[] = [];
  const t = start(s, {
    turn: async (_prompt, _signal, options) => {
      results.push(await callTool(options, "task_create", briefing));
      return "已提交。";
    },
  });
  await t.send("每天早上 8 点给我一份 AI 新闻简报");
  await until("the question", () => askedQuestions(s).length === 1);

  const [asked] = askedQuestions(s);
  const question = asked?.questions[0];
  assert.ok(asked && question);
  assert.equal(asked.runId, t.chatRuns()[0]?.id, "it belongs to the chat run");
  assert.equal(question.header, "新任务");
  assert.equal(s.store.list().length, 0, "nothing exists while the question is open");

  assert.equal(await t.handler.answerQuestion(asked.id, { [question.question]: "确认" }), true);
  await until("the chat run to end", () => t.chatDone(1));
  const [task] = s.store.list();
  assert.deepEqual([s.store.list().length, task?.origin, task?.status, task?.title], [1, "chat", "active", "每日 AI 简报"]);
  assert.deepEqual(answeredQuestions(s).map((a) => [a.id, a.answers, a.cancelled]), [[asked.id, { [question.question]: "确认" }, undefined]]);
  assert.match(results[0] ?? "", /Created task/);
  assert.equal(t.app.texts.at(-1), "已提交。");
});

test("a plain message answers the confirmation as free text, which confirms nothing", async () => {
  const s = stack();
  const results: string[] = [];
  const t = start(s, {
    turn: async (_prompt, _signal, options) => {
      results.push(await callTool(options, "task_create", briefing));
      return "好的。";
    },
  });
  await t.send("每天早上 8 点给我一份 AI 新闻简报");
  await until("the question", () => askedQuestions(s).length === 1);

  await t.send("先别建，周末再说");
  await until("the chat run to end", () => t.chatDone(1));
  assert.equal(s.store.list().length, 0);
  assert.ok((results[0] ?? "").includes("先别建，周末再说"), "the agent gets the owner's words");
  assert.deepEqual(Object.values(answeredQuestions(s)[0]?.answers ?? {}), ["先别建，周末再说"]);
});

test("a stop cancels the confirmation: the question is recorded as cancelled and no task is made", async () => {
  const s = stack();
  const results: string[] = [];
  const t = start(s, {
    turn: async (_prompt, _signal, options) => {
      results.push(await callTool(options, "task_create", briefing));
      return "好的。";
    },
  });
  await t.send("每天早上 8 点给我一份 AI 新闻简报");
  await until("the question", () => askedQuestions(s).length === 1);

  assert.equal(await t.handler.stopRun(askedQuestions(s)[0]?.runId ?? ""), true);
  await until("the chat run to end", () => t.chatRuns().some((r) => r.status !== "running"));
  assert.equal(s.store.list().length, 0);
  assert.deepEqual(answeredQuestions(s).map((a) => [a.cancelled, a.answers]), [[true, {}]]);
  assert.match(results[0] ?? "", /cancelled/);
});

test("pausing a task from chat asks nothing; resuming it asks first", async () => {
  const s = stack();
  const task = evening(s, "晚报");
  const t = start(s, {
    turn: async (prompt, _signal, options) => {
      await callTool(options, "task_update", { taskId: task.id, status: prompt.includes("停") ? "paused" : "active" });
      return "好的。";
    },
  });
  await t.send("先停掉晚报");
  await until("the first chat run to end", () => t.chatDone(1));
  assert.equal(s.store.get(task.id)?.status, "paused");
  assert.equal(askedQuestions(s).length, 0, "no question");

  await t.send("恢复晚报");
  await until("the question", () => askedQuestions(s).length === 1);
  assert.equal(askedQuestions(s)[0]?.questions[0]?.header, "改任务");
  assert.equal(s.store.get(task.id)?.status, "paused", "still paused until the tap");
  const asked = askedQuestions(s)[0];
  await t.handler.answerQuestion(asked?.id ?? "", { [asked?.questions[0]?.question ?? ""]: "确认" });
  await until("the second chat run to end", () => t.chatDone(2));
  assert.equal(s.store.get(task.id)?.status, "active");
});

test("a queued scheduled occurrence is dropped when its task was paused or ended meanwhile; a one-time task, which the store marks done, still runs; a run now on a paused task runs", async () => {
  const s = stack();
  const hold = held();
  // 23:30 in Taipei: the two recurring tasks fell due at 23:00, the one-time ones just before.
  const blocker = oneTime(s, "挡路的", {}, 830);
  const once = oneTime(s, "一次性的", {}, 835);
  const paused = evening(s, "会被暂停的");
  const ended = evening(s, "会被结束的");
  clock = new Date("2026-10-27T15:30:00Z");
  const t = start(s, { turn: hold.turn });
  await until("the first task run to start", () => hold.waiting === 1 && t.agent.taskQueries.length === 1);
  assert.match(t.agent.taskQueries[0]?.prompts[0] ?? "", /Brief of 挡路的/);
  assert.equal(s.store.get(once.id)?.status, "done", "taken, so the store has marked it done");

  s.store.update(paused.id, { status: "paused" });
  s.store.update(ended.id, { status: "done" });
  hold.release("好");
  await until("the one-time task's run to start", () => t.agent.taskQueries.length === 2 && hold.waiting === 1);
  assert.match(t.agent.taskQueries[1]?.prompts[0] ?? "", /Brief of 一次性的/);
  hold.release("好");
  await until("the one-time task's run to end", () => t.finished(once.id));
  assert.ok(t.finished(blocker.id));
  await sleep(150);

  assert.equal(t.agent.taskQueries.length, 2, "the two dropped occurrences never started a query");
  for (const task of [paused, ended]) {
    assert.deepEqual(t.taskRuns(task.id), [], "no run");
    assert.deepEqual(s.store.get(task.id)?.skips, [], "and no skip is recorded");
    assert.deepEqual(t.messages().filter((m) => m.taskId === task.id), [], "and nothing is posted");
  }

  assert.equal(t.handler.runTask(paused.id), true);
  await until("the run now to start", () => t.agent.taskQueries.length === 3 && hold.waiting === 1);
  assert.match(t.agent.taskQueries[2]?.prompts[0] ?? "", /Brief of 会被暂停的/);
  hold.release("好");
  await until("the run now to end", () => t.finished(paused.id));
  assert.equal(s.store.get(paused.id)?.status, "paused", "a run now leaves the status alone");

  assert.equal(t.handler.runTask(ended.id), true, "so does a task that was ended");
  await until("the second run now to start", () => t.agent.taskQueries.length === 4 && hold.waiting === 1);
  hold.release("好");
  await until("the second run now to end", () => t.finished(ended.id));
});
