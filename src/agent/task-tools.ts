// The agent's tools for the owner's tasks (see tasks/store.ts): list them, create one, change one. A new task,
// and a change that decides what runs or what it costs (the brief, the schedule, the model, the per-run cap, or
// resuming a task), wait for the owner's tap on a question card, so nothing the agent reads on the web or in a
// file can plant or change a recurring task by itself. Pausing and ending, and a new title, ask nothing: they spend
// nothing. The confirmation is an ordinary structured question (see questions.ts), described by these tools from
// the arguments the agent gave, not in words the agent chose. Only the main thread of a chat run gets these tools
// (agentOptions), and a subagent's call is denied (subagents.ts).

import { isDeepStrictEqual } from "node:util";

import { tool } from "@anthropic-ai/claude-agent-sdk";

import { DEFAULT_TASK_BUDGET_USD, DEFAULT_TASK_MODEL, TaskCreateSchema, TaskUpdateSchema } from "../api/schema.ts";
import type { Question, Schedule, Task } from "../api/schema.ts";
import { firstLine, localStamp } from "../files.ts";
import { describeError, log } from "../log.ts";
import { InvalidTask } from "../tasks/store.ts";
import type { TaskChanges, TaskStore } from "../tasks/store.ts";
import type { AskOwner } from "./questions.ts";
import { anySignal, callSignal, fail, ok } from "./tools.ts";

export const TASK_TOOL_NAMES = ["mcp__alfred__task_list", "mcp__alfred__task_create", "mcp__alfred__task_update"];

/** The two answers of a confirmation; only the first changes anything. */
const CONFIRM = "确认";
const DECLINE = "不要";
/** How much of the old brief a change's confirmation shows: the new brief is shown in full. */
const BRIEF_CHARS = 300;
/** How much of a brief a listing shows: its first line, cut here. */
const LIST_BRIEF_CHARS = 100;
const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
const STATUS_NAMES: Record<Task["status"], string> = { active: "运行中", paused: "已暂停", done: "已结束" };

/** The owner's time zone: the process's (see src/tasks/schedule.ts). */
function ownerZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** A schedule in words, without the zone. */
export function describeSchedule(schedule: Schedule): string {
  switch (schedule.kind) {
    case "once":
      return `仅一次，${localStamp(new Date(schedule.at))}`;
    case "daily":
      return `每天 ${schedule.time}`;
    case "weekly":
      return `每周${schedule.days.map((day) => WEEKDAYS[day - 1] ?? "").join("、")} ${schedule.time}`;
    case "interval":
      return schedule.hours === 1 ? "每小时" : `每 ${schedule.hours} 小时`;
  }
}

/** A schedule in words, with the zone its times are in. */
function scheduleText(schedule: Schedule): string {
  return `${describeSchedule(schedule)}（${ownerZone()}）`;
}

/** A moment in the owner's zone with its weekday, such as "2026-10-28 08:00 (周三)". */
function when(date: Date): string {
  return `${localStamp(date)} (周${WEEKDAYS[(date.getDay() + 6) % 7] ?? ""})`;
}

function nextRun(task: Task): string {
  return task.nextRunAt ? when(new Date(task.nextRunAt)) : "none";
}

/** A sum in dollars with at least cents: $0.50, $2.00, $0.125. */
function money(usd: number): string {
  const decimals = String(usd).split(".")[1]?.length ?? 0;
  return `$${usd.toFixed(Math.min(Math.max(2, decimals), 6))}`;
}

/** The old brief of a change as the owner sees it: cut to BRIEF_CHARS characters, with how long it is when it was cut. */
function cut(brief: string): string {
  const chars = Array.from(brief.trim());
  return chars.length > BRIEF_CHARS ? `${chars.slice(0, BRIEF_CHARS).join("")}…（共 ${chars.length} 字）` : chars.join("");
}

/** The confirmation: one single-select question with the two answers and the text that says what will happen. */
function confirmation(header: "新任务" | "改任务", lines: string[]): Question {
  return {
    header,
    question: lines.join("\n"),
    options: [
      { label: CONFIRM, description: "" },
      { label: DECLINE, description: "" },
    ],
    multiSelect: false,
  };
}

/** The changed fields of a task, old → new, one line each. */
function changeLines(current: Task, changes: TaskChanges): string[] {
  const lines: string[] = [];
  if (changes.title !== undefined) lines.push(`标题：${current.title} → ${changes.title}`);
  if (changes.schedule !== undefined) lines.push(`时间：${describeSchedule(current.schedule)} → ${scheduleText(changes.schedule)}`);
  if (changes.model !== undefined) lines.push(`模型：${current.model} → ${changes.model}`);
  if (changes.budgetUsd !== undefined) lines.push(`每次运行上限：${money(current.budgetUsd)} → ${money(changes.budgetUsd)}`);
  if (changes.brief !== undefined) lines.push(`简报：${cut(current.brief)} → ${changes.brief}`);
  if (changes.status !== undefined) lines.push(`状态：${STATUS_NAMES[current.status]} → ${STATUS_NAMES[changes.status]}`);
  return lines;
}

/** What the call changes: the fields it gives that differ from the task's. A value the task already has is no change. */
function realChanges(current: Task, given: TaskChanges): TaskChanges {
  const changes: TaskChanges = {};
  if (given.title !== undefined && given.title !== current.title) changes.title = given.title;
  if (given.brief !== undefined && given.brief !== current.brief) changes.brief = given.brief;
  if (given.schedule !== undefined && !isDeepStrictEqual(given.schedule, current.schedule)) changes.schedule = given.schedule;
  if (given.model !== undefined && given.model !== current.model) changes.model = given.model;
  if (given.budgetUsd !== undefined && given.budgetUsd !== current.budgetUsd) changes.budgetUsd = given.budgetUsd;
  if (given.status !== undefined && given.status !== current.status) changes.status = given.status;
  return changes;
}

/** Whether the owner must tap before this change applies: it sets what a run does or costs, or starts the runs again. */
function needsTap(changes: TaskChanges): boolean {
  return (
    changes.brief !== undefined ||
    changes.schedule !== undefined ||
    changes.model !== undefined ||
    changes.budgetUsd !== undefined ||
    changes.status === "active"
  );
}

// The fields are the contract's (src/api/schema.ts), so a tool refuses what a task.create or task.update would.
const createFields = TaskCreateSchema.shape;
const { type: _type, ...updateFields } = TaskUpdateSchema.shape;

/**
 * The task tools, over the owner's task store. `ask` holds a question for the owner (the handler's askOwner) and
 * `signal` is the run's: a stop or the run's end cancels a question that is open, and the tool then changes nothing.
 */
export function taskToolDefinitions(store: TaskStore, ask: AskOwner, signal?: AbortSignal) {
  const scheduleHelp = `{kind: "daily", time: "HH:MM"}, {kind: "weekly", days: [1 to 7, Monday is 1, ascending], time: "HH:MM"}, {kind: "interval", hours: 1 to 168} or {kind: "once", at: an ISO time in UTC ending in Z}. A time of day is in the owner's time zone, ${ownerZone()}.`;

  /** Asks the owner to confirm. Undefined when they did; otherwise what the agent is told, and nothing was changed. */
  async function tapped(question: Question, extra: unknown, unchanged: string) {
    const outcome = await ask([question], anySignal(signal, callSignal(extra)) ?? new AbortController().signal);
    if ("cancelled" in outcome) return fail(`The question was cancelled (the run was stopped or ended), so ${unchanged}.`);
    const answer = outcome.answers[question.question];
    if (answer === CONFIRM) return undefined;
    if (answer === DECLINE) return ok(`The owner declined (${DECLINE}), so ${unchanged}.`);
    return ok(`The owner did not tap ${CONFIRM}, so ${unchanged}. They wrote this instead: ${JSON.stringify(answer ?? "")}`);
  }

  const taskList = tool(
    "task_list",
    "List the owner's scheduled tasks: id, title, status, schedule, next run, model, per-run cap and the first line of the brief. Times are in the owner's time zone, which the list names.",
    {},
    async () => {
      const tasks = store.list();
      const header = `Time zone: ${ownerZone()}. ${tasks.length ? `${tasks.length} task${tasks.length === 1 ? "" : "s"}:` : "No tasks."}`;
      const lines = tasks.map(
        (t) =>
          `- ${t.id} ${JSON.stringify(t.title)}: ${t.status}, ${scheduleText(t.schedule)}, ${t.nextRunAt ? `next run ${nextRun(t)}` : "no next run"}, model ${t.model}, cap ${money(t.budgetUsd)} per run. Brief: ${firstLine(t.brief, LIST_BRIEF_CHARS)}`,
      );
      return ok([header, ...lines].join("\n"));
    },
  );

  const taskCreate = tool(
    "task_create",
    "Propose a scheduled task: a brief that Alfred runs on a schedule, unattended, sending the owner a report each time. The owner is asked in the app to confirm it, and the task exists only if they tap 确认. Call this only when the owner asked for scheduled or recurring work. Write the brief so that a run with no other context can do the work.",
    {
      title: createFields.title.describe("Short name, shown in the app and on each report"),
      brief: createFields.brief.describe("What each run does, written for an agent that sees nothing of this conversation: the topic, where to look, the shape of the report"),
      schedule: createFields.schedule.describe(scheduleHelp),
      model: createFields.model.describe(`Default ${DEFAULT_TASK_MODEL}; haiku is cheapest`),
      budgetUsd: createFields.budgetUsd.describe(`Per-run spend cap in USD; default ${DEFAULT_TASK_BUDGET_USD}, at most 20. A run that reaches it is stopped, so give a realistic one`),
    },
    async ({ title, brief, schedule, model, budgetUsd }, extra) => {
      const question = confirmation("新任务", [
        `创建定时任务「${title}」？`,
        `时间：${scheduleText(schedule)}`,
        `模型：${model ?? DEFAULT_TASK_MODEL}`,
        `每次运行上限：${money(budgetUsd ?? DEFAULT_TASK_BUDGET_USD)}`,
        `简报：${brief}`,
      ]);
      const refused = await tapped(question, extra, "no task was created");
      if (refused) return refused;
      try {
        const task = store.create({ title, brief, schedule, model, budgetUsd }, "chat");
        log.info(`agent created task ${task.id} ${JSON.stringify(task.title)} (confirmed by the owner)`);
        return ok(
          `Created task ${task.id} ${JSON.stringify(task.title)}: ${scheduleText(task.schedule)}, next run ${nextRun(task)}, model ${task.model}, cap ${money(task.budgetUsd)} per run. The owner confirmed it, so it is active.`,
        );
      } catch (err) {
        if (err instanceof InvalidTask) return fail(`No task was created: ${err.message}`);
        log.error(`creating a task failed: ${describeError(err)}`);
        return fail(`No task was created: ${describeError(err)}`);
      }
    },
  );

  const taskUpdate = tool(
    "task_update",
    'Change a task by its id, or pause it (status "paused"), resume it ("active") or end it ("done"). Only the fields you give change. Pausing, ending and a new title apply at once. A new brief, schedule, model or cap, and resuming, are confirmed by the owner in the app first, and apply only if they tap 确认.',
    {
      ...updateFields,
      schedule: updateFields.schedule.describe(scheduleHelp),
      status: updateFields.status.describe("paused and done apply at once; active (resuming) is confirmed by the owner first"),
    },
    async ({ taskId, ...given }, extra) => {
      const current = store.get(taskId);
      if (!current) return fail(`There is no task ${taskId}, so nothing changed. task_list shows the ids.`);
      if (Object.values(given).every((value) => value === undefined)) return fail("Name at least one field to change.");
      const changes = realChanges(current, given);
      if (Object.keys(changes).length === 0) return ok(`Task ${taskId} already has those values, so nothing changed.`);
      if (needsTap(changes)) {
        const question = confirmation("改任务", [`修改定时任务「${current.title}」（${current.id}）？`, ...changeLines(current, changes)]);
        const refused = await tapped(question, extra, `task ${taskId} was not changed`);
        if (refused) return refused;
      }
      try {
        const task = store.update(taskId, changes);
        if (!task) return fail(`There is no task ${taskId}, so nothing changed. task_list shows the ids.`);
        log.info(`agent changed task ${task.id} (${Object.keys(changes).join(", ")})${needsTap(changes) ? " (confirmed by the owner)" : ""}`);
        const now = task.status === "active" ? `next run ${nextRun(task)}.` : `it is ${task.status} and has no next run.`;
        return ok(`Updated task ${task.id} ${JSON.stringify(task.title)} (${Object.keys(changes).join(", ")}): ${now}${needsTap(changes) ? " The owner confirmed the change." : ""}`);
      } catch (err) {
        if (err instanceof InvalidTask) return fail(`Task ${taskId} was not changed: ${err.message}`);
        log.error(`changing task ${taskId} failed: ${describeError(err)}`);
        return fail(`Task ${taskId} was not changed: ${describeError(err)}`);
      }
    },
  );

  return [taskList, taskCreate, taskUpdate];
}
