import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { IdeaAccept } from "../api/schema.ts";
import type { IdeaCommandsOptions } from "./commands.ts";
import type { IdeaDraft } from "./store.ts";

// Schedules are local times: pin the zone before any date is made, so the result does not depend on the machine.
process.env.TZ = "Asia/Taipei";
// store.ts reads this at import time (through runs.ts), so set it before loading the modules under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-idea-commands-")));
process.env.ALFRED_STATE_DIR = path.join(tmp, "state");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { EventLog } = await import("../events.ts");
const { TaskStore } = await import("../tasks/store.ts");
const { IdeaStore } = await import("./store.ts");
const { ideaCommands } = await import("./commands.ts");

const NOW = new Date("2026-10-27T01:00:00Z"); // Tuesday 09:00 in Taipei
const DAY_MS = 86_400_000;
const RUN = "k7m2qa";
const OTHER_RUN = "x4n8rb";

const once: IdeaDraft = {
  title: "对比三家 VPS 的带宽配额",
  why: "上一份价格报告没有写带宽，你在对话里问过这件事。",
  brief: "查三家供应商官网的带宽政策，整理成一张表。",
  kind: "once",
  model: "sonnet",
  estimateUsd: 0.35,
};
const recurring: IdeaDraft = {
  ...once,
  title: "每周追踪 VPS 价格变化",
  kind: "recurring",
  schedule: { kind: "weekly", days: [1], time: "09:00" },
};

/** An accept as the owner confirmed it in the app's task form. */
function accept(ideaId: string, extra: Partial<IdeaAccept> = {}): IdeaAccept {
  return { type: "idea.accept", ideaId, title: "带宽对比", brief: "查三家供应商官网的带宽政策。", model: "sonnet", budgetUsd: 1, ...extra };
}

let opened = 0;
/** Both stores on files of their own, and the commands over them, all reading one clock. */
function open(options: IdeaCommandsOptions = {}) {
  const dir = path.join(tmp, `store-${opened++}`);
  const events = new EventLog(path.join(dir, "events.jsonl"));
  const clock = { now: NOW };
  const now = () => clock.now;
  const ideas = new IdeaStore({ file: path.join(dir, "ideas.json"), events, now });
  const tasks = new TaskStore({ file: path.join(dir, "tasks.json"), events, now });
  const commands = ideaCommands(ideas, tasks, { now, ...options });
  return { ideas, tasks, events, commands, clock };
}

test("accept with a schedule makes a task on it with origin idea, and marks the idea accepted with the task's id", async () => {
  const { ideas, tasks, events, commands } = open();
  const [idea] = ideas.add([once], RUN);
  if (!idea) throw new Error("the idea was not added");
  const before = events.lastId();

  const schedule = { kind: "daily", time: "09:30" } as const;
  const reply = await commands.accept(accept(idea.id, { schedule }));

  assert.ok(reply.ok);
  assert.equal(reply.body.task.origin, "idea");
  assert.deepEqual(reply.body.task.schedule, schedule);
  assert.equal(reply.body.task.nextRunAt, "2026-10-27T01:30:00.000Z");
  assert.equal(reply.body.idea.state, "accepted");
  assert.equal(reply.body.idea.taskId, reply.body.task.id);
  assert.deepEqual(ideas.get(idea.id), reply.body.idea);
  assert.deepEqual(tasks.list(), [reply.body.task]);
  const logged = events
    .readSince(before)
    .map((event) => event.type)
    .sort();
  assert.deepEqual(logged, ["idea.updated", "task.updated"]);
});

test("accept without a schedule makes a one-time task due 60 seconds from now", async () => {
  const { ideas, commands } = open();
  const [idea] = ideas.add([once], RUN);
  if (!idea) throw new Error("the idea was not added");

  const reply = await commands.accept(accept(idea.id));

  assert.ok(reply.ok);
  assert.deepEqual(reply.body.task.schedule, { kind: "once", at: "2026-10-27T01:01:00.000Z" });
  assert.equal(reply.body.task.nextRunAt, "2026-10-27T01:01:00.000Z");
  assert.equal(reply.body.task.origin, "idea");
});

test("accept of an unknown idea answers 404, and of an idea that is not open answers 409 with no task made", async () => {
  const { ideas, tasks, clock, commands } = open();
  assert.deepEqual(await commands.accept(accept("zzzzzz")), { ok: false, status: 404, error: "no idea zzzzzz" });

  const [taken, declined] = ideas.add([once, recurring], RUN);
  if (!taken || !declined) throw new Error("two ideas were added");
  assert.ok((await commands.accept(accept(taken.id))).ok);
  assert.deepEqual(await commands.accept(accept(taken.id)), { ok: false, status: 409, error: "the idea is accepted" });
  ideas.reject(declined.id, { reason: "not-now" });
  assert.deepEqual(await commands.accept(accept(declined.id)), { ok: false, status: 409, error: "the idea is rejected" });

  // An idea of eight days ago, which the archive takes unanswered.
  clock.now = new Date(NOW.getTime() - 8 * DAY_MS);
  const [stale] = ideas.add([once], OTHER_RUN);
  clock.now = NOW;
  if (!stale) throw new Error("the stale idea was not added");
  assert.equal(ideas.archiveStale().length, 1);
  assert.deepEqual(await commands.accept(accept(stale.id)), { ok: false, status: 409, error: "the idea is archived" });

  assert.equal(tasks.list().length, 1, "only the accepted idea made a task");
});

test("accept answers 400 with the store's message for a task the store refuses, and the idea stays open", async () => {
  const { ideas, tasks, commands } = open();
  const [idea] = ideas.add([once], RUN);
  if (!idea) throw new Error("the idea was not added");

  const reply = await commands.accept(accept(idea.id, { schedule: { kind: "once", at: "2026-10-27T00:00:00.000Z" } }));

  assert.ok(!reply.ok);
  assert.equal(reply.status, 400);
  assert.match(reply.error, /already passed/);
  assert.equal(ideas.get(idea.id)?.state, "open");
  assert.deepEqual(tasks.list(), []);
});

test("two accepts of one idea in a row make one task, and the second is answered 409", async () => {
  const { ideas, tasks, commands } = open();
  const [idea] = ideas.add([once], RUN);
  if (!idea) throw new Error("the idea was not added");

  // Both are called before either is awaited: nothing is left between the check and the acceptance.
  const replies = await Promise.all([commands.accept(accept(idea.id)), commands.accept(accept(idea.id))]);

  assert.equal(replies.filter((reply) => reply.ok).length, 1);
  assert.deepEqual(
    replies.filter((reply) => !reply.ok),
    [{ ok: false, status: 409, error: "the idea is accepted" }],
  );
  assert.equal(tasks.list().length, 1);
});

test("an error that is not the store's refusal is not turned into an answer", () => {
  const { ideas } = open();
  const [idea] = ideas.add([once], RUN);
  if (!idea) throw new Error("the idea was not added");
  const broken = ideaCommands(
    ideas,
    {
      create() {
        throw new Error("disk full");
      },
    } as unknown as InstanceType<typeof TaskStore>,
    { now: () => NOW },
  );
  assert.throws(() => broken.accept(accept(idea.id)), /disk full/);
  assert.equal(ideas.get(idea.id)?.state, "open");
});

test("reject records the reason, with the note when there is one, and answers 404 and 409 as accept does", async () => {
  const { ideas, events, commands } = open();
  const [noted, plain, taken] = ideas.add([once, recurring, once], RUN);
  if (!noted || !plain || !taken) throw new Error("three ideas were added");
  assert.ok((await commands.accept(accept(taken.id))).ok);
  const before = events.lastId();

  const withNote = await commands.reject({ type: "idea.reject", ideaId: noted.id, reason: "too-expensive", note: "太贵了" });
  assert.ok(withNote.ok);
  assert.equal(withNote.body.idea.state, "rejected");
  assert.deepEqual(withNote.body.idea.rejection, { reason: "too-expensive", note: "太贵了" });

  const withoutNote = await commands.reject({ type: "idea.reject", ideaId: plain.id, reason: "not-now" });
  assert.ok(withoutNote.ok);
  assert.deepEqual(withoutNote.body.idea.rejection, { reason: "not-now" });
  assert.equal("note" in (withoutNote.body.idea.rejection ?? {}), false, "no note key when the command has none");
  assert.deepEqual(ideas.get(plain.id), withoutNote.body.idea);

  assert.deepEqual(await commands.reject({ type: "idea.reject", ideaId: "zzzzzz", reason: "not-now" }), { ok: false, status: 404, error: "no idea zzzzzz" });
  assert.deepEqual(await commands.reject({ type: "idea.reject", ideaId: noted.id, reason: "not-now" }), { ok: false, status: 409, error: "the idea is rejected" });
  assert.deepEqual(await commands.reject({ type: "idea.reject", ideaId: taken.id, reason: "not-now" }), { ok: false, status: 409, error: "the idea is accepted" });

  const updates = events.readSince(before).filter((event) => event.type === "idea.updated");
  assert.equal(updates.length, 2, "one idea.updated for each of the two rejections, and none for the refused ones");
});

test("generate answers 503 while no generation is wired in, and the generation's answer when one is", async () => {
  const unwired = open();
  assert.deepEqual(await unwired.commands.generate({ type: "idea.generate" }), { ok: false, status: 503, error: "idea generation is not available" });

  const seen: string[] = [];
  const wired = open({
    generate(command) {
      seen.push(command.type);
      return { ok: true, body: { runId: "c9t5hq" } };
    },
  });
  assert.deepEqual(await wired.commands.generate({ type: "idea.generate" }), { ok: true, body: { runId: "c9t5hq" } });
  assert.deepEqual(seen, ["idea.generate"]);
});
