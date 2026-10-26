import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

import type { Schedule } from "../api/schema.ts";

// Schedules are local times: pin the zone before any date is made, so the result does not depend on the machine.
process.env.TZ = "Asia/Taipei";
// store.ts reads this at import time (through runs.ts), so set it before loading the module under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-tasks-")));
process.env.ALFRED_STATE_DIR = path.join(tmp, "state");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { EventLog } = await import("../events.ts");
const { TaskListSchema } = await import("../api/schema.ts");
const { InvalidTask, TaskStore } = await import("./store.ts");

const at = (iso: string) => new Date(iso);
const START = at("2026-10-26T01:00:00Z"); // Monday 09:00 in Taipei
/** The clock the stores read; each test starts at START and may move it. */
let clock = START;
const now = () => clock;
beforeEach(() => {
  clock = START;
});

const morning: Schedule = { kind: "daily", time: "08:00" };

let opened = 0;
/** A store on files of its own, reading the clock. */
function open() {
  const dir = path.join(tmp, `store-${opened++}`);
  const file = path.join(dir, "tasks.json");
  const events = new EventLog(path.join(dir, "events.jsonl"));
  return { file, events, store: new TaskStore({ file, events, now }) };
}

/** The task.updated events of a log, as [task id, status], oldest first. */
function updates(events: InstanceType<typeof EventLog>): [string, string][] {
  return events.readSince(0).flatMap((event) => (event.type === "task.updated" ? [[event.data.id, event.data.status] as [string, string]] : []));
}

test("create applies the defaults, computes the first run and writes the file", () => {
  const { file, events, store } = open();
  const task = store.create({ title: "晨报", brief: "Summarize overnight news", schedule: morning }, "chat");

  assert.match(task.id, /^[2-9a-hjkmnp-z]{6}$/);
  assert.equal(task.status, "active");
  assert.equal(task.model, "sonnet");
  assert.equal(task.budgetUsd, 2);
  assert.equal(task.origin, "chat");
  assert.deepEqual(task.skips, []);
  assert.equal(task.createdAt, "2026-10-26T01:00:00.000Z");
  assert.equal(task.nextRunAt, "2026-10-27T00:00:00.000Z", "08:00 has passed today, so tomorrow at 08:00 Taipei");
  assert.deepEqual(TaskListSchema.parse(JSON.parse(fs.readFileSync(file, "utf8"))), { timeZone: "Asia/Taipei", tasks: [task] });
  assert.deepEqual(updates(events), [[task.id, "active"]]);
});

test("a one-time task whose time has passed is refused, and nothing is written", () => {
  const { file, events, store } = open();
  assert.throws(
    () => store.create({ title: "过期", brief: "x", schedule: { kind: "once", at: "2026-10-26T00:00:00.000Z" } }, "chat"),
    InvalidTask,
  );
  assert.deepEqual(store.list(), []);
  assert.equal(fs.existsSync(file), false);
  assert.equal(events.readSince(0).length, 0);
});

test("pausing drops the next run, and resuming counts from now", () => {
  const { store } = open();
  const task = store.create({ title: "晨报", brief: "x", schedule: morning }, "manual");
  const paused = store.update(task.id, { status: "paused" });
  assert.equal(paused?.status, "paused");
  assert.equal(paused && "nextRunAt" in paused, false);

  clock = at("2026-10-30T01:00:00Z"); // Friday 09:00 in Taipei
  assert.equal(store.update(task.id, { status: "active" })?.nextRunAt, "2026-10-31T00:00:00.000Z", "Saturday 08:00 Taipei");
  assert.equal(store.update("zzzzzz", { status: "paused" }), undefined, "no such task");
});

test("an interval starts over when it is resumed or given a new schedule", () => {
  const { store } = open();
  const task = store.create({ title: "盯盘", brief: "x", schedule: { kind: "interval", hours: 6 } }, "manual");
  assert.equal(task.nextRunAt, "2026-10-26T07:00:00.000Z", "six hours after now");
  assert.equal(store.update(task.id, { schedule: { kind: "interval", hours: 12 } })?.nextRunAt, "2026-10-26T13:00:00.000Z");
  store.update(task.id, { status: "paused" });
  clock = at("2026-10-26T04:00:00Z");
  assert.equal(store.update(task.id, { status: "active" })?.nextRunAt, "2026-10-26T16:00:00.000Z");
});

test("a change to a one-time task whose time has passed is refused, and changes nothing", () => {
  const { events, store } = open();
  const task = store.create({ title: "晨报", brief: "x", schedule: morning }, "manual");
  assert.throws(() => store.update(task.id, { schedule: { kind: "once", at: "2026-10-26T00:00:00.000Z" } }), InvalidTask);
  assert.deepEqual(store.get(task.id), task);
  assert.equal(events.readSince(0).length, 1, "only the create");
});

test("a new store reads the same tasks, newest created first; a file that is not a task list is an error", () => {
  const { file, events, store } = open();
  const first = store.create({ title: "一", brief: "x", schedule: morning }, "manual");
  clock = at("2026-10-26T02:00:00Z");
  const second = store.create({ title: "二", brief: "x", schedule: { kind: "interval", hours: 2 } }, "chat");

  const reopened = new TaskStore({ file, events, now });
  assert.deepEqual(reopened.list(), [second, first]);
  assert.deepEqual(reopened.get(first.id), first);

  fs.writeFileSync(file, JSON.stringify({ tasks: "nope" }));
  assert.throws(() => new TaskStore({ file, events, now }), (err: unknown) => err instanceof Error && err.message.includes(file));
  fs.writeFileSync(file, "{ not json");
  assert.throws(() => new TaskStore({ file, events, now }), (err: unknown) => err instanceof Error && err.message.includes(file));
});

test("a missing file is an empty list", () => {
  const { store } = open();
  assert.deepEqual(store.list(), []);
});

test("recordRun and recordSkip add to the task", () => {
  const { store } = open();
  const task = store.create({ title: "晨报", brief: "x", schedule: morning }, "manual");
  const ran = store.recordRun(task.id, "k7m2qa", at("2026-10-26T00:00:00Z"));
  assert.equal(ran?.lastRunId, "k7m2qa");
  assert.equal(ran?.lastRunAt, "2026-10-26T00:00:00.000Z");
  assert.deepEqual(store.recordSkip(task.id, at("2026-10-25T00:00:00Z"), "daily-cap")?.skips, [{ at: "2026-10-25T00:00:00.000Z", reason: "daily-cap" }]);
  assert.equal(store.recordRun("zzzzzz", "k7m2qa", START), undefined);
});

test("a run two hours late is due, and the task moves on", () => {
  const { events, store } = open();
  clock = at("2026-10-25T23:00:00Z"); // Monday 07:00 in Taipei
  const task = store.create({ title: "晨报", brief: "x", schedule: morning }, "manual");
  assert.equal(task.nextRunAt, "2026-10-26T00:00:00.000Z");

  clock = at("2026-10-26T02:00:00Z"); // 10:00 in Taipei
  const due = store.takeDue();
  assert.deepEqual(due.map((d) => [d.task.id, d.scheduledAt.toISOString()]), [[task.id, "2026-10-26T00:00:00.000Z"]]);
  assert.equal(due[0]?.task.nextRunAt, "2026-10-27T00:00:00.000Z");
  assert.deepEqual(store.get(task.id)?.skips, []);
  assert.equal(store.takeDue().length, 0, "nothing is due again");
  assert.equal(updates(events).length, 2, "the create and the move");
});

test("a run seven hours late is skipped as missed, and the next run is tomorrow", () => {
  const { store } = open();
  clock = at("2026-10-25T23:00:00Z");
  const task = store.create({ title: "晨报", brief: "x", schedule: morning }, "manual");
  clock = at("2026-10-26T07:00:00Z"); // 15:00 in Taipei
  assert.deepEqual(store.takeDue(), []);
  assert.deepEqual(store.get(task.id)?.skips, [{ at: "2026-10-26T00:00:00.000Z", reason: "missed" }]);
  assert.equal(store.get(task.id)?.nextRunAt, "2026-10-27T00:00:00.000Z");
});

test("after three days down, the latest run is due and the three missed days are skipped", () => {
  const { store } = open();
  const task = store.create({ title: "晨报", brief: "x", schedule: morning }, "manual"); // Monday 09:00, next Tuesday 08:00
  clock = at("2026-10-30T02:00:00Z"); // Friday 10:00 in Taipei: Friday's run is two hours old
  const due = store.takeDue();
  assert.deepEqual(due.map((d) => d.scheduledAt.toISOString()), ["2026-10-30T00:00:00.000Z"]);
  assert.deepEqual(store.get(task.id)?.skips, [
    { at: "2026-10-29T00:00:00.000Z", reason: "missed" },
    { at: "2026-10-28T00:00:00.000Z", reason: "missed" },
    { at: "2026-10-27T00:00:00.000Z", reason: "missed" },
  ]);
  assert.equal(store.get(task.id)?.nextRunAt, "2026-10-31T00:00:00.000Z");
  assert.equal(store.takeDue().length, 0);
});

test("an interval keeps its cadence after a late run", () => {
  const { store } = open();
  const task = store.create({ title: "盯盘", brief: "x", schedule: { kind: "interval", hours: 2 } }, "manual");
  assert.equal(task.nextRunAt, "2026-10-26T03:00:00.000Z");
  clock = at("2026-10-26T09:30:00Z");
  const due = store.takeDue();
  assert.deepEqual(due.map((d) => d.scheduledAt.toISOString()), ["2026-10-26T09:00:00.000Z"]);
  assert.deepEqual(store.get(task.id)?.skips.map((s) => s.at), ["2026-10-26T07:00:00.000Z", "2026-10-26T05:00:00.000Z", "2026-10-26T03:00:00.000Z"]);
  assert.equal(store.get(task.id)?.nextRunAt, "2026-10-26T11:00:00.000Z", "on the two-hour cadence, not 2 hours after the late run");
});

test("a one-time task ends when its run is due, and when its run is missed", () => {
  const { store } = open();
  clock = at("2026-10-26T03:00:00Z");
  const soon = store.create({ title: "一次", brief: "x", schedule: { kind: "once", at: "2026-10-26T04:00:00.000Z" } }, "chat");
  clock = at("2026-10-26T04:30:00Z");
  const due = store.takeDue();
  assert.deepEqual(due.map((d) => d.task.id), [soon.id]);
  assert.equal(due[0]?.task.status, "done");
  assert.equal(due[0] && "nextRunAt" in due[0].task, false);

  const late = store.create({ title: "过期", brief: "x", schedule: { kind: "once", at: "2026-10-26T06:00:00.000Z" } }, "chat");
  clock = at("2026-10-26T13:00:00Z");
  assert.deepEqual(store.takeDue(), []);
  assert.equal(store.get(late.id)?.status, "done");
  assert.deepEqual(store.get(late.id)?.skips, [{ at: "2026-10-26T06:00:00.000Z", reason: "missed" }]);
});

test("skips are capped at ten, newest first", () => {
  const { store } = open();
  clock = at("2026-10-25T23:00:00Z");
  const task = store.create({ title: "晨报", brief: "x", schedule: morning }, "manual"); // first run 26 October 08:00
  clock = at("2026-11-10T01:00:00Z"); // 09:00 on 10 November; that day's 08:00 run is an hour old
  assert.equal(store.takeDue().length, 1);
  const skips = store.get(task.id)?.skips ?? [];
  assert.equal(skips.length, 10);
  assert.equal(skips[0]?.at, "2026-11-09T00:00:00.000Z");
  assert.equal(skips[9]?.at, "2026-10-31T00:00:00.000Z");
});

test("onStatusChange hears a status change made through update, and nothing else", () => {
  const { store } = open();
  const heard: [string, string, string][] = [];
  store.onStatusChange((task, previous) => heard.push([task.id, previous, task.status]));
  const task = store.create({ title: "晨报", brief: "x", schedule: morning }, "manual");
  const once = store.create({ title: "一次", brief: "x", schedule: { kind: "once", at: "2026-10-26T02:00:00.000Z" } }, "manual");
  assert.deepEqual(heard, [], "a new task is no change");

  store.update(task.id, { title: "早报", schedule: { kind: "daily", time: "09:00" }, status: "active" });
  store.update(task.id, { status: "paused" });
  store.update(task.id, { status: "paused", title: "还是暂停" });
  store.update(task.id, { status: "active" });
  store.update(task.id, { status: "done" });
  store.update("zzzzzz", { status: "done" });
  store.recordRun(task.id, "k7m2qa", clock);
  store.recordSkip(task.id, clock, "missed");
  assert.deepEqual(heard, [
    [task.id, "active", "paused"],
    [task.id, "paused", "active"],
    [task.id, "active", "done"],
  ]);

  clock = at("2026-10-26T03:00:00Z");
  assert.equal(store.takeDue().length, 1);
  assert.equal(store.get(once.id)?.status, "done", "the store ended the one-time task as its run was taken");
  assert.equal(heard.length, 3, "and that is not a change of the owner's");
});

test("a listener is told after the change is saved and logged, may stop listening, and cannot fail the update", () => {
  const { file, events, store } = open();
  const task = store.create({ title: "晨报", brief: "x", schedule: morning }, "manual");
  const seen: string[] = [];
  const stop = store.onStatusChange((changed) => {
    const saved = (JSON.parse(fs.readFileSync(file, "utf8")) as { tasks: { status: string }[] }).tasks[0]?.status;
    seen.push(`${store.get(changed.id)?.status} ${saved} ${updates(events).length}`);
    throw new Error("listener broke");
  });
  const second = store.onStatusChange((changed) => seen.push(`second ${changed.status}`));

  const paused = store.update(task.id, { status: "paused" });
  assert.equal(paused?.status, "paused", "the update went through");
  assert.deepEqual(seen, ["paused paused 2", "second paused"], "the first listener's error did not keep the second from hearing");

  stop();
  store.update(task.id, { status: "done" });
  assert.deepEqual(seen, ["paused paused 2", "second paused", "second done"]);
  second();
  store.update(task.id, { status: "paused" });
  assert.equal(seen.length, 3);
});
