// The agent's task tools on a temp task store and a fake owner: no model is called. A question the tools ask is
// answered by a script, and a tool is called the way the SDK calls it, with its input and an `extra` argument.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { z } from "zod";

import type { Question, Task } from "../api/schema.ts";
import type { QuestionOutcome } from "./questions.ts";

// Schedules are local times: pin the zone before any date is made, so the result does not depend on the machine.
process.env.TZ = "Asia/Taipei";
// store.ts reads these at import time, so set them before loading the modules under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-task-tools-")));
Object.assign(process.env, {
  ALFRED_WORKSPACE: path.join(tmp, "workspace"),
  ALFRED_STATE_DIR: path.join(tmp, "state"),
  ALFRED_ANTHROPIC_API_KEY: "sk-test",
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { TASK_TOOL_NAMES, taskToolDefinitions } = await import("./task-tools.ts");
const { EventLog } = await import("../events.ts");
const { TaskStore } = await import("../tasks/store.ts");

// Tuesday 09:00 in Taipei.
const T0 = new Date("2026-10-27T01:00:00Z");
let clock = T0;
let stacks = 0;

interface Result {
  content: { type: string; text: string }[];
  isError?: boolean;
}

/** What the fake owner does with the next question: taps an option, writes text, or the question is cancelled. */
type Answer = { tap: string } | { write: string } | "cancel";

/** A temp store, a log, and the task tools with an owner who answers the questions in `answers`, in order. */
function setup(...answers: Answer[]) {
  clock = T0;
  const dir = path.join(tmp, `stack-${stacks++}`);
  const events = new EventLog(path.join(dir, "events.jsonl"));
  const store = new TaskStore({ file: path.join(dir, "tasks.json"), events, now: () => clock });
  const asked: Question[] = [];
  const script = [...answers];
  const tools = taskToolDefinitions(store, async (questions): Promise<QuestionOutcome> => {
    assert.equal(questions.length, 1, "one question at a time");
    const question = questions[0];
    assert.ok(question);
    asked.push(question);
    const answer = script.shift();
    assert.ok(answer, `an unexpected question: ${question.question}`);
    if (answer === "cancel") return { cancelled: true };
    return { answers: { [question.question]: "tap" in answer ? answer.tap : answer.write } };
  });
  /** Calls a tool the way the SDK does, with its input checked against the tool's own schema first. */
  const call = async (name: string, input: Record<string, unknown>, extra: unknown = {}) => {
    const def = tools.find((t) => t.name === name);
    assert.ok(def, name);
    const parsed = z.object(def.inputSchema).parse(input);
    return (await def.handler(parsed as never, extra)) as Result;
  };
  const events_ = () => events.readSince(0).flatMap((e) => (e.type === "task.updated" ? [e.data] : []));
  return { store, tools, asked, call, taskEvents: events_, remaining: () => script.length };
}

const textOf = (result: Result) => result.content.map((c) => c.text).join("\n");

const daily = { kind: "daily", time: "08:00" } as const;
const briefing = { title: "每日 AI 简报", brief: "Summarize the day's AI news in five bullets.", schedule: daily, model: "haiku", budgetUsd: 0.5 } as const;

/** A task made by the owner in the app, as the tools find it. */
function existing(s: ReturnType<typeof setup>, extra: Partial<Parameters<typeof s.store.create>[0]> = {}): Task {
  return s.store.create({ title: "每日 AI 简报", brief: "Summarize the day's AI news.", schedule: daily, ...extra }, "manual");
}

test("the name list says which tools there are, as the agent's server names them", () => {
  const s = setup();
  assert.deepEqual(TASK_TOOL_NAMES, ["mcp__alfred__task_list", "mcp__alfred__task_create", "mcp__alfred__task_update"]);
  assert.deepEqual(
    s.tools.map((t) => `mcp__alfred__${t.name}`),
    TASK_TOOL_NAMES,
  );
});

test("task_create asks once, with one single-select question the owner can confirm or refuse, and creates on 确认 with the origin chat", async () => {
  const s = setup({ tap: "确认" });
  const result = await s.call("task_create", briefing);

  assert.equal(s.asked.length, 1);
  const [question] = s.asked;
  assert.equal(question?.header, "新任务");
  assert.equal(question?.multiSelect, false);
  assert.deepEqual(
    question?.options.map((o) => o.label),
    ["确认", "不要"],
  );
  const text = question?.question ?? "";
  assert.ok(text.includes("每日 AI 简报"), "the title");
  assert.ok(text.includes("每天 08:00（Asia/Taipei）"), "the schedule in words, with the zone");
  assert.ok(text.includes("haiku"), "the model");
  assert.ok(text.includes("$0.50"), "the per-run cap");
  assert.ok(text.includes("Summarize the day's AI news in five bullets."), "the brief");

  const [task] = s.store.list();
  assert.equal(s.store.list().length, 1);
  assert.deepEqual([task?.origin, task?.title, task?.schedule, task?.model, task?.budgetUsd, task?.status], ["chat", "每日 AI 简报", daily, "haiku", 0.5, "active"]);
  assert.equal(task?.nextRunAt, "2026-10-28T00:00:00.000Z", "08:00 in Taipei, tomorrow");
  assert.equal(result.isError, undefined);
  const line = textOf(result);
  assert.ok(line.includes(task?.id ?? "-") && line.includes("每日 AI 简报"), line);
  assert.ok(line.includes("2026-10-28 08:00"), "the next run, in the owner's zone");
  assert.match(line, /The owner confirmed it, so it is active\./, "so the agent does not ask the owner to confirm again");
  assert.ok(!line.includes("\n"), "one line");
  assert.deepEqual(
    s.taskEvents().map((t) => [t.id, t.origin]),
    [[task?.id, "chat"]],
    "the store announced it as chat's",
  );
});

test("a task without a model or a cap is asked about with the defaults, and created with them", async () => {
  const s = setup({ tap: "确认" });
  await s.call("task_create", { title: "周报", brief: "Weekly note.", schedule: { kind: "weekly", days: [1, 3], time: "09:30" } });
  const text = s.asked[0]?.question ?? "";
  assert.ok(text.includes("每周一、三 09:30（Asia/Taipei）"), text);
  assert.ok(text.includes("sonnet") && text.includes("$2.00"), text);
  const [task] = s.store.list();
  assert.deepEqual([task?.model, task?.budgetUsd], ["sonnet", 2]);
});

test("task_create creates nothing on 不要, on free text or on a cancel, and says so in one line", async () => {
  const s = setup({ tap: "不要" }, { write: "先别建，改成每周" }, "cancel");

  const declined = await s.call("task_create", briefing);
  assert.equal(s.store.list().length, 0);
  assert.match(textOf(declined), /declined/);
  assert.ok(!textOf(declined).includes("\n"));

  const written = await s.call("task_create", briefing);
  assert.equal(s.store.list().length, 0);
  assert.ok(textOf(written).includes("先别建，改成每周"), "the owner's words come back to the agent");
  assert.match(textOf(written), /no task was created/i);

  const cancelled = await s.call("task_create", briefing);
  assert.equal(s.store.list().length, 0);
  assert.equal(cancelled.isError, true);
  assert.match(textOf(cancelled), /cancelled/);

  assert.equal(s.asked.length, 3);
  assert.deepEqual(s.taskEvents(), [], "nothing was announced");
  assert.equal(s.remaining(), 0);
});

test("a free-text answer is not a confirmation, however much it sounds like one", async () => {
  const s = setup({ write: "好的" }, { write: "确认。" });
  await s.call("task_create", briefing);
  await s.call("task_create", briefing);
  assert.equal(s.store.list().length, 0);
});

test("the question cuts a long brief to about 300 characters and says how long it was", async () => {
  const s = setup({ tap: "不要" });
  const brief = `${"调研".repeat(200)}ENDMARK`;
  await s.call("task_create", { ...briefing, brief });
  const text = s.asked[0]?.question ?? "";
  assert.ok(!text.includes("ENDMARK"));
  assert.ok(text.includes("调研".repeat(150)), "the first 300 characters");
  assert.ok(!text.includes("调研".repeat(151)));
  assert.ok(text.includes("共 407 字"), text);
  assert.ok(text.length < 600, `${text.length} characters`);
});

test("a one-time task in the past is refused after the tap, in one line, and nothing is created", async () => {
  const s = setup({ tap: "确认" });
  const result = await s.call("task_create", { ...briefing, schedule: { kind: "once", at: "2026-10-27T00:00:00Z" } });
  assert.equal(s.store.list().length, 0);
  assert.equal(result.isError, true);
  assert.match(textOf(result), /already passed/);
  assert.ok(!textOf(result).includes("\n"));
  assert.deepEqual(s.taskEvents(), []);
});

test("a one-time task asks with its time in the owner's zone", async () => {
  const s = setup({ tap: "确认" });
  await s.call("task_create", { ...briefing, schedule: { kind: "once", at: "2026-10-28T06:30:00Z" } });
  assert.ok((s.asked[0]?.question ?? "").includes("仅一次，2026-10-28 14:30（Asia/Taipei）"), s.asked[0]?.question);
  assert.equal(s.store.list()[0]?.status, "active");
});

test("an interval is asked about in hours", async () => {
  const s = setup({ tap: "确认" }, { tap: "确认" });
  await s.call("task_create", { ...briefing, schedule: { kind: "interval", hours: 6 } });
  await s.call("task_create", { ...briefing, schedule: { kind: "interval", hours: 1 } });
  assert.ok((s.asked[0]?.question ?? "").includes("每 6 小时"));
  assert.ok((s.asked[1]?.question ?? "").includes("每小时"));
});

test("the tools take the contract's field rules: a bad time, weekday, model or cap is refused before the tool runs", async () => {
  const s = setup();
  const bad: [string, Record<string, unknown>][] = [
    ["task_create", { ...briefing, schedule: { kind: "daily", time: "25:00" } }],
    ["task_create", { ...briefing, schedule: { kind: "weekly", days: [3, 1], time: "09:00" } }],
    ["task_create", { ...briefing, schedule: { kind: "interval", hours: 500 } }],
    ["task_create", { ...briefing, schedule: { kind: "once", at: "2026-10-28T08:00:00+08:00" } }],
    ["task_create", { ...briefing, model: "gpt" }],
    ["task_create", { ...briefing, budgetUsd: 50 }],
    ["task_create", { ...briefing, title: " " }],
    ["task_create", { ...briefing, brief: "" }],
    ["task_update", { taskId: "abc", status: "gone" }],
    ["task_update", { taskId: "x", status: "paused" }],
  ];
  for (const [name, input] of bad) {
    await assert.rejects(s.call(name, input), `${name} ${JSON.stringify(input)}`);
  }
  assert.equal(s.asked.length, 0);
});

test("task_update pauses and ends a task at once, without asking, and a paused task has no next run", async () => {
  const s = setup();
  const task = existing(s);
  assert.equal(task.status, "active");

  const paused = await s.call("task_update", { taskId: task.id, status: "paused" });
  assert.equal(s.asked.length, 0);
  assert.equal(s.store.get(task.id)?.status, "paused");
  assert.equal(s.store.get(task.id)?.nextRunAt, undefined);
  assert.equal(paused.isError, undefined);
  assert.ok(textOf(paused).includes(task.id) && /paused/.test(textOf(paused)), textOf(paused));
  assert.ok(!textOf(paused).includes("\n"));

  const ended = await s.call("task_update", { taskId: task.id, status: "done" });
  assert.equal(s.asked.length, 0);
  assert.equal(s.store.get(task.id)?.status, "done");
  assert.match(textOf(ended), /done/);
});

test("task_update asks before a change of brief, schedule, model or cap, and shows only what changes, old to new", async () => {
  const s = setup({ tap: "确认" }, { tap: "确认" }, { tap: "确认" }, { tap: "确认" });
  const task = existing(s, { model: "haiku", budgetUsd: 1 });

  await s.call("task_update", { taskId: task.id, schedule: { kind: "daily", time: "09:30" } });
  await s.call("task_update", { taskId: task.id, brief: "Summarize the day's AI news, with links." });
  await s.call("task_update", { taskId: task.id, model: "sonnet" });
  await s.call("task_update", { taskId: task.id, budgetUsd: 3 });

  assert.equal(s.asked.length, 4);
  assert.ok(s.asked.every((q) => q.header === "改任务" && !q.multiSelect && q.options.map((o) => o.label).join() === "确认,不要"));
  const [schedule, brief, model, cap] = s.asked.map((q) => q.question);
  assert.ok(schedule?.includes("每天 08:00 → 每天 09:30（Asia/Taipei）"), schedule);
  assert.ok(schedule?.includes("每日 AI 简报"), "which task");
  assert.ok(!schedule?.includes("模型") && !schedule?.includes("简报："), "only the changed field");
  assert.ok(brief?.includes("Summarize the day's AI news. → Summarize the day's AI news, with links."), brief);
  assert.ok(model?.includes("模型：haiku → sonnet"), model);
  assert.ok(cap?.includes("$1.00 → $3.00"), cap);

  const after = s.store.get(task.id);
  assert.deepEqual([after?.schedule, after?.brief, after?.model, after?.budgetUsd], [{ kind: "daily", time: "09:30" }, "Summarize the day's AI news, with links.", "sonnet", 3]);
  assert.ok(s.taskEvents().every((t) => t.id === task.id));
});

test("a change the owner refuses, answers in words or cancels leaves the task as it was", async () => {
  const s = setup({ tap: "不要" }, { write: "改成晚上" }, "cancel");
  const task = existing(s);
  const before = s.store.get(task.id);

  const refused = await s.call("task_update", { taskId: task.id, schedule: { kind: "daily", time: "09:30" } });
  const written = await s.call("task_update", { taskId: task.id, model: "opus" });
  const cancelled = await s.call("task_update", { taskId: task.id, budgetUsd: 10 });

  assert.deepEqual(s.store.get(task.id), before);
  assert.match(textOf(refused), /declined/);
  assert.ok(textOf(written).includes("改成晚上"));
  assert.equal(cancelled.isError, true);
  assert.equal(s.taskEvents().length, 1, "only the task's creation was announced");
});

test("resuming a task asks first, and the task runs again from now when confirmed", async () => {
  const s = setup({ tap: "不要" }, { tap: "确认" });
  const task = existing(s);
  await s.call("task_update", { taskId: task.id, status: "paused" });

  await s.call("task_update", { taskId: task.id, status: "active" });
  assert.equal(s.asked.length, 1);
  assert.equal(s.asked[0]?.header, "改任务");
  assert.ok((s.asked[0]?.question ?? "").includes("状态：已暂停 → 运行中"), s.asked[0]?.question);
  assert.equal(s.store.get(task.id)?.status, "paused", "refused");

  clock = new Date(T0.getTime() + 3_600_000);
  const resumed = await s.call("task_update", { taskId: task.id, status: "active" });
  assert.equal(s.store.get(task.id)?.status, "active");
  assert.equal(s.store.get(task.id)?.nextRunAt, "2026-10-28T00:00:00.000Z");
  assert.ok(textOf(resumed).includes("2026-10-28 08:00"), textOf(resumed));
  assert.match(textOf(resumed), /The owner confirmed the change\./);
  assert.doesNotMatch(textOf(await s.call("task_update", { taskId: task.id, status: "paused" })), /confirmed/, "a pause was not confirmed by anyone");
});

test("a change of title alone does not ask, and neither does a title with a pause", async () => {
  const s = setup();
  const task = existing(s);

  const renamed = await s.call("task_update", { taskId: task.id, title: "AI 早报" });
  assert.equal(s.asked.length, 0);
  assert.equal(s.store.get(task.id)?.title, "AI 早报");
  assert.equal(s.store.get(task.id)?.nextRunAt, task.nextRunAt, "the schedule is untouched");
  assert.match(textOf(renamed), /title/);

  await s.call("task_update", { taskId: task.id, title: "早报", status: "paused" });
  assert.equal(s.asked.length, 0);
  assert.deepEqual([s.store.get(task.id)?.title, s.store.get(task.id)?.status], ["早报", "paused"]);
});

test("a change that needs the tap carries the title change with it, and shows it", async () => {
  const s = setup({ tap: "确认" });
  const task = existing(s);
  await s.call("task_update", { taskId: task.id, title: "早报", model: "haiku" });
  assert.equal(s.asked.length, 1);
  assert.ok((s.asked[0]?.question ?? "").includes("标题：每日 AI 简报 → 早报"), s.asked[0]?.question);
  assert.deepEqual([s.store.get(task.id)?.title, s.store.get(task.id)?.model], ["早报", "haiku"]);
});

test("a value the task already has is no change: nothing is asked and nothing is written", async () => {
  const s = setup();
  const task = existing(s, { model: "haiku" });
  const events = s.taskEvents().length;

  const same = await s.call("task_update", { taskId: task.id, schedule: { kind: "daily", time: "08:00" }, model: "haiku", status: "active", title: task.title });
  assert.equal(s.asked.length, 0);
  assert.match(textOf(same), /nothing changed/i);
  assert.equal(s.taskEvents().length, events);
  assert.deepEqual(s.store.get(task.id), task);

  const none = await s.call("task_update", { taskId: task.id });
  assert.equal(none.isError, true);
  assert.match(textOf(none), /at least one/i);
});

test("an unknown task id comes back as one line, with no question and no change", async () => {
  const s = setup();
  existing(s);
  const before = s.store.list();
  const result = await s.call("task_update", { taskId: "zzzzzz", schedule: { kind: "daily", time: "09:00" } });
  assert.equal(s.asked.length, 0);
  assert.equal(result.isError, true);
  assert.ok(textOf(result).includes("zzzzzz"));
  assert.ok(!textOf(result).includes("\n"));
  assert.deepEqual(s.store.list(), before);
});

test("a change the moment does not allow is refused after the tap, in one line, and the task is untouched", async () => {
  const s = setup({ tap: "确认" });
  const task = existing(s);
  const result = await s.call("task_update", { taskId: task.id, schedule: { kind: "once", at: "2026-10-26T00:00:00Z" } });
  assert.equal(s.asked.length, 1);
  assert.equal(result.isError, true);
  assert.match(textOf(result), /already passed/);
  assert.ok(!textOf(result).includes("\n"));
  assert.deepEqual(s.store.get(task.id), task);
});

test("the question is held on the run's signal and on the call's: either one aborts it", async () => {
  const dir = path.join(tmp, `stack-${stacks++}`);
  const store = new TaskStore({ file: path.join(dir, "tasks.json"), events: new EventLog(path.join(dir, "events.jsonl")), now: () => clock });
  const seen: AbortSignal[] = [];
  const hold = (_questions: Question[], signal: AbortSignal) =>
    new Promise<QuestionOutcome>((resolve) => {
      seen.push(signal);
      signal.addEventListener("abort", () => resolve({ cancelled: true }), { once: true });
    });
  const run = new AbortController();
  const tools = taskToolDefinitions(store, hold, run.signal);
  const create = tools.find((t) => t.name === "task_create");
  assert.ok(create);

  const call = new AbortController();
  const first = create.handler(briefing as never, { signal: call.signal }) as Promise<Result>;
  call.abort();
  assert.equal((await first).isError, true);
  const second = create.handler(briefing as never, {}) as Promise<Result>;
  run.abort();
  assert.equal((await second).isError, true);
  assert.equal(seen.length, 2);
  assert.equal(store.list().length, 0);
});

test("task_list names the zone and gives every task with its id, status, schedule, next run, model, cap and the brief's first line", async () => {
  const s = setup();
  assert.match(textOf(await s.call("task_list", {})), /Asia\/Taipei.*no tasks/is);

  const a = existing(s, { title: "每日 AI 简报", brief: "\nSummarize the day's AI news.\nSecond line stays out.", model: "haiku", budgetUsd: 0.5 });
  clock = new Date(T0.getTime() + 60_000);
  const b = s.store.create({ title: "周报", brief: "Weekly note.", schedule: { kind: "weekly", days: [5], time: "17:00" } }, "manual");
  s.store.update(b.id, { status: "paused" });
  const c = s.store.create({ title: "已结束的", brief: "Old.", schedule: { kind: "interval", hours: 12 } }, "chat");
  s.store.update(c.id, { status: "done" });

  const text = textOf(await s.call("task_list", {}));
  assert.ok(text.includes("Asia/Taipei"));
  const lines = text.split("\n").filter((l) => l.includes(a.id) || l.includes(b.id) || l.includes(c.id));
  assert.equal(lines.length, 3, text);
  const lineOf = (task: Task) => lines.find((l) => l.includes(task.id)) ?? "";
  for (const word of ["每日 AI 简报", "active", "每天 08:00", "2026-10-28 08:00", "haiku", "$0.50", "Summarize the day's AI news."]) {
    assert.ok(lineOf(a).includes(word), `${word} in ${lineOf(a)}`);
  }
  assert.ok(!text.includes("Second line stays out."));
  for (const word of ["周报", "paused", "每周五 17:00", "sonnet", "$2.00", "Weekly note."]) assert.ok(lineOf(b).includes(word), `${word} in ${lineOf(b)}`);
  assert.ok(/no next run/i.test(lineOf(b)), lineOf(b));
  for (const word of ["已结束的", "done", "每 12 小时"]) assert.ok(lineOf(c).includes(word), `${word} in ${lineOf(c)}`);
  assert.equal(s.asked.length, 0, "listing asks nothing");
});
