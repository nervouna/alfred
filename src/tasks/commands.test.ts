import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Schedules are local times: pin the zone before any date is made, so the result does not depend on the machine.
process.env.TZ = "Asia/Taipei";
// store.ts reads this at import time (through runs.ts), so set it before loading the modules under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-task-commands-")));
process.env.ALFRED_STATE_DIR = path.join(tmp, "state");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { EventLog } = await import("../events.ts");
const { taskCommands } = await import("./commands.ts");
const { TaskStore } = await import("./store.ts");

const NOW = new Date("2026-10-27T01:00:00Z"); // Tuesday 09:00 in Taipei
const daily = { kind: "daily", time: "09:30" } as const;

let opened = 0;
/** A store on files of its own, and the commands over it with a runner that remembers what it was asked to run. */
function open(runs = true) {
  const dir = path.join(tmp, `store-${opened++}`);
  const events = new EventLog(path.join(dir, "events.jsonl"));
  const store = new TaskStore({ file: path.join(dir, "tasks.json"), events, now: () => NOW });
  const asked: string[] = [];
  const commands = taskCommands(store, {
    runTask(taskId) {
      asked.push(taskId);
      return runs;
    },
  });
  return { store, events, commands, asked };
}

test("create makes a manual task with the store's defaults and answers it", async () => {
  const { store, events, commands } = open();
  const reply = await commands.create({ type: "task.create", title: "晨报", brief: "Summarize the news", schedule: daily });

  assert.ok(reply.ok);
  assert.equal(reply.task.origin, "manual");
  assert.equal(reply.task.model, "sonnet");
  assert.equal(reply.task.budgetUsd, 2);
  assert.equal(reply.task.nextRunAt, "2026-10-27T01:30:00.000Z");
  assert.deepEqual(store.list(), [reply.task]);
  assert.equal(events.readSince(0).filter((e) => e.type === "task.updated").length, 1);
});

test("create passes the model and the budget on", async () => {
  const { commands } = open();
  const reply = await commands.create({ type: "task.create", title: "便宜的", brief: "x", schedule: daily, model: "haiku", budgetUsd: 0.25 });
  assert.ok(reply.ok);
  assert.deepEqual([reply.task.model, reply.task.budgetUsd], ["haiku", 0.25]);
});

test("a create the store refuses is answered 400 with its message, and nothing is stored", async () => {
  const { store, commands } = open();
  const reply = await commands.create({ type: "task.create", title: "过期", brief: "x", schedule: { kind: "once", at: "2026-10-27T00:00:00.000Z" } });

  assert.ok(!reply.ok);
  assert.equal(reply.status, 400);
  assert.match(reply.error, /already passed/);
  assert.deepEqual(store.list(), []);
});

test("update changes the task and answers it", async () => {
  const { store, commands } = open();
  const created = await commands.create({ type: "task.create", title: "晨报", brief: "x", schedule: daily });
  assert.ok(created.ok);

  const paused = await commands.update({ type: "task.update", taskId: created.task.id, status: "paused", title: "晚报" });
  assert.ok(paused.ok);
  assert.deepEqual([paused.task.status, paused.task.title, paused.task.nextRunAt], ["paused", "晚报", undefined]);
  assert.deepEqual(store.get(created.task.id), paused.task);
});

test("an update for an id no task has is answered 404", async () => {
  const { commands } = open();
  const reply = await commands.update({ type: "task.update", taskId: "k7m2qa", status: "paused" });
  assert.deepEqual(reply, { ok: false, status: 404, error: "no task k7m2qa" });
});

test("an update the store refuses is answered 400 with its message, and the task is unchanged", async () => {
  const { store, commands } = open();
  const created = await commands.create({ type: "task.create", title: "晨报", brief: "x", schedule: daily });
  assert.ok(created.ok);

  const reply = await commands.update({ type: "task.update", taskId: created.task.id, schedule: { kind: "once", at: "2026-10-27T00:00:00.000Z" } });
  assert.ok(!reply.ok);
  assert.equal(reply.status, 400);
  assert.match(reply.error, /already passed/);
  assert.deepEqual(store.get(created.task.id), created.task);
});

test("an error that is not the store's refusal is not turned into an answer", async () => {
  const broken = {
    create() {
      throw new Error("disk full");
    },
    update() {
      throw new Error("disk full");
    },
  } as unknown as InstanceType<typeof TaskStore>;
  const commands = taskCommands(broken, { runTask: () => true });
  assert.throws(() => commands.create({ type: "task.create", title: "x", brief: "x", schedule: daily }), /disk full/);
  assert.throws(() => commands.update({ type: "task.update", taskId: "k7m2qa", title: "y" }), /disk full/);
});

test("run asks the runner to run the task, and answers what it answers", async () => {
  const yes = open(true);
  assert.equal(await yes.commands.run("k7m2qa"), true);
  assert.deepEqual(yes.asked, ["k7m2qa"]);

  const no = open(false);
  assert.equal(await no.commands.run("k7m2qa"), false);
});
