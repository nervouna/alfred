// The owner's tasks, in $STATE_DIR/workbench/tasks.json, which only this store writes. Every change is written at
// once and appended to the event log as task.updated with the whole task. Nothing here runs a task: takeDue says
// which runs are due and moves each task on to its next time.

import {
  DEFAULT_TASK_BUDGET_USD,
  DEFAULT_TASK_MODEL,
  MAX_TASK_SKIPS,
  type Schedule,
  type Task,
  TaskListSchema,
  TaskSchema,
} from "../api/schema.ts";
import { type EventLog, sharedEventLog } from "../events.ts";
import { TASKS_FILE, newRunId } from "../runs.ts";
import { readJson, writeJson } from "../store.ts";
import { MISSED_RUN_MS, nextOccurrence, occurrencesBetween } from "./schedule.ts";

const HOUR_MS = 3_600_000;
const ONCE_PASSED = "A one-time task's time has already passed; choose a later time.";

/** A change the schema allows but the moment does not, such as a one-time task whose time has passed. Its message is for the owner. */
export class InvalidTask extends Error {}

export interface TaskStoreOptions {
  /** The tasks file. By default workbench/tasks.json under the state directory. */
  file?: string;
  events?: EventLog;
  now?: () => Date;
}

export interface TaskInput {
  title: string;
  brief: string;
  schedule: Schedule;
  model?: Task["model"];
  budgetUsd?: number;
}

/** What a change sets. A field left out keeps its value. */
export type TaskChanges = Partial<Pick<Task, "title" | "brief" | "schedule" | "model" | "budgetUsd" | "status">>;

/** A run that is due: the task, already moved on to its next time, and the time the run was due. */
export interface DueTask {
  task: Task;
  scheduledAt: Date;
}

export class TaskStore {
  private readonly file: string;
  private readonly events: EventLog;
  private readonly now: () => Date;
  private readonly timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  /** Newest created first. A change replaces a task's object, so a task returned earlier does not change. */
  private tasks: Task[];

  constructor({ file = TASKS_FILE, events = sharedEventLog(), now = () => new Date() }: TaskStoreOptions = {}) {
    this.file = file;
    this.events = events;
    this.now = now;
    this.tasks = loadTasks(file);
  }

  list(): Task[] {
    return [...this.tasks];
  }

  get(id: string): Task | undefined {
    return this.tasks.find((task) => task.id === id);
  }

  /** A new active task. Its first run is the first scheduled time after now. */
  create(input: TaskInput, origin: Task["origin"]): Task {
    const now = this.now();
    const nextRunAt = nextOccurrence(input.schedule, now);
    if (!nextRunAt) throw new InvalidTask(ONCE_PASSED);
    const id = newRunId((candidate) => this.tasks.some((task) => task.id === candidate));
    const stamp = now.toISOString();
    return this.save(
      {
        id,
        title: input.title,
        brief: input.brief,
        origin,
        schedule: input.schedule,
        status: "active",
        model: input.model ?? DEFAULT_TASK_MODEL,
        budgetUsd: input.budgetUsd ?? DEFAULT_TASK_BUDGET_USD,
        createdAt: stamp,
        updatedAt: stamp,
        nextRunAt: nextRunAt.toISOString(),
        skips: [],
      },
      true,
    );
  }

  /**
   * Changes the task and returns it, or returns undefined when there is no such task. A paused or done task has
   * no next run. An active task that starts, or gets a new schedule, counts from now; one that keeps its schedule
   * keeps its next run.
   */
  update(id: string, changes: TaskChanges): Task | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const now = this.now();
    const status = changes.status ?? current.status;
    const schedule = changes.schedule ?? current.schedule;
    let nextRunAt: string | undefined;
    if (status === "active") {
      if (current.status === "active" && changes.schedule === undefined) {
        nextRunAt = current.nextRunAt;
      } else {
        const at = nextOccurrence(schedule, now);
        if (!at) throw new InvalidTask(ONCE_PASSED);
        nextRunAt = at.toISOString();
      }
    }
    const { nextRunAt: _previousRun, ...base } = current;
    return this.save({
      ...base,
      title: changes.title ?? current.title,
      brief: changes.brief ?? current.brief,
      schedule,
      model: changes.model ?? current.model,
      budgetUsd: changes.budgetUsd ?? current.budgetUsd,
      status,
      updatedAt: now.toISOString(),
      ...(nextRunAt ? { nextRunAt } : {}),
    });
  }

  /**
   * The runs due now, oldest first, with each task moved on. An active task whose next run has come has every
   * occurrence up to now counted. The latest one is due if it is at most MISSED_RUN_MS old; the others are recorded
   * as missed, and so are all of them when the latest is older. A one-time task is done after this.
   */
  takeDue(): DueTask[] {
    const now = this.now();
    const due: DueTask[] = [];
    for (const task of this.list()) {
      if (task.status !== "active" || task.nextRunAt === undefined) continue;
      const first = new Date(task.nextRunAt);
      if (first > now) continue;
      // An interval counts its cadence from the occurrence before its next run.
      const previous = task.schedule.kind === "interval" ? new Date(first.getTime() - task.schedule.hours * HOUR_MS) : undefined;
      // occurrencesBetween returns a bounded batch, so keep asking from where the last batch ended.
      const occurrences = [first];
      let batch = occurrencesBetween(task.schedule, first, now, previous);
      while (batch.length > 0) {
        occurrences.push(...batch);
        batch = occurrencesBetween(task.schedule, batch[batch.length - 1] ?? now, now, previous);
      }
      const latest = occurrences[occurrences.length - 1] ?? first;
      const isDue = now.getTime() - latest.getTime() <= MISSED_RUN_MS;
      const missed = isDue ? occurrences.slice(0, -1) : occurrences;
      const skips: Task["skips"] = [
        ...missed
          .slice(-MAX_TASK_SKIPS)
          .reverse()
          .map((at) => ({ at: at.toISOString(), reason: "missed" as const })),
        ...task.skips,
      ].slice(0, MAX_TASK_SKIPS);
      const next = nextOccurrence(task.schedule, now, latest);
      const { nextRunAt: _ranFrom, ...base } = task;
      const moved = this.save({
        ...base,
        status: next ? "active" : "done",
        skips,
        updatedAt: now.toISOString(),
        ...(next ? { nextRunAt: next.toISOString() } : {}),
      });
      if (isDue) due.push({ task: moved, scheduledAt: latest });
    }
    return due.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
  }

  /** Records the last run of the task: its run id and the time it is recorded at. Undefined when there is no such task. */
  recordRun(id: string, runId: string, at: Date): Task | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    return this.save({ ...current, lastRunId: runId, lastRunAt: at.toISOString(), updatedAt: this.now().toISOString() });
  }

  /** Records a run of the task that did not happen: the time it was due and why. Undefined when there is no such task. */
  recordSkip(id: string, at: Date, reason: Task["skips"][number]["reason"]): Task | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const skips = [{ at: at.toISOString(), reason }, ...current.skips].slice(0, MAX_TASK_SKIPS);
    return this.save({ ...current, skips, updatedAt: this.now().toISOString() });
  }

  /** Checks the task, writes the whole list with it in place (first, when it is new), then tells the log. */
  private save(task: Task, isNew = false): Task {
    TaskSchema.parse(task);
    const tasks = isNew ? [task, ...this.tasks] : this.tasks.map((other) => (other.id === task.id ? task : other));
    writeJson(this.file, { timeZone: this.timeZone, tasks });
    this.tasks = tasks;
    this.events.append("task.updated", task);
    return task;
  }
}

/**
 * The tasks in the file, newest created first. A missing file holds none. A file that is not a task list is an
 * error: starting over would lose the tasks.
 */
function loadTasks(file: string): Task[] {
  let raw: unknown;
  try {
    raw = readJson<unknown>(file);
  } catch (err) {
    if (err instanceof SyntaxError) throw new Error(`${file} is not valid JSON: ${err.message}`);
    throw err;
  }
  if (raw === undefined) return [];
  const parsed = TaskListSchema.safeParse(raw);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    throw new Error(`${file} is not a task list: ${issue?.path.map(String).join(".") ?? ""} ${issue?.message ?? ""}`.trim());
  }
  return parsed.data.tasks.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
