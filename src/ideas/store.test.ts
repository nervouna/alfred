import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

import type { IdeaDraft } from "./store.ts";

// store.ts reads this at import time (through runs.ts), so set it before loading the module under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-ideas-")));
process.env.ALFRED_STATE_DIR = path.join(tmp, "state");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { EventLog } = await import("../events.ts");
const { IdeaListSchema } = await import("../api/schema.ts");
const { IDEA_ARCHIVE_MS, IdeaNotOpen, IdeaStore, MAX_CLOSED_IDEAS } = await import("./store.ts");

const START = new Date("2026-10-26T01:00:00Z");
/** The clock the stores read; each test starts at START and may move it. */
let clock = START;
const now = () => clock;
beforeEach(() => {
  clock = START;
});

const RUN = "k7m2qa";
const OTHER_RUN = "x4n8rb";

const once = (title: string): IdeaDraft => ({
  title,
  why: "The owner asked about it twice this week",
  brief: `Research ${title} and summarize it`,
  kind: "once",
  model: "sonnet",
  estimateUsd: 0.5,
});
const recurring = (title: string): IdeaDraft => ({
  ...once(title),
  kind: "recurring",
  schedule: { kind: "daily", time: "08:00" },
});

let opened = 0;
/** A store on files of its own, reading the clock. */
function open() {
  const dir = path.join(tmp, `store-${opened++}`);
  const file = path.join(dir, "ideas.json");
  const events = new EventLog(path.join(dir, "events.jsonl"));
  return { file, events, store: new IdeaStore({ file, events, now }) };
}

/** The idea.updated events of a log, as [idea id, state], oldest first. */
function updates(events: InstanceType<typeof EventLog>): [string, string][] {
  return events.readSince(0).flatMap((event) => (event.type === "idea.updated" ? [[event.data.id, event.data.state] as [string, string]] : []));
}

test("a missing file is an empty list with no generation", () => {
  const { store } = open();
  assert.deepEqual(store.list(), []);
  assert.equal(store.generatingRunId(), undefined);
});

test("add gives each draft an id, the run and the time, and puts the batch in front in the order given", () => {
  const { file, events, store } = open();
  const first = store.add([once("一"), recurring("二")], RUN);
  assert.deepEqual(first.map((idea) => idea.title), ["一", "二"]);
  for (const idea of first) {
    assert.match(idea.id, /^[2-9a-hjkmnp-z]{6}$/);
    assert.equal(idea.state, "open");
    assert.equal(idea.runId, RUN);
    assert.equal(idea.createdAt, "2026-10-26T01:00:00.000Z");
    assert.equal(idea.updatedAt, "2026-10-26T01:00:00.000Z");
  }
  assert.notEqual(first[0]?.id, first[1]?.id);
  assert.deepEqual(first[1]?.schedule, { kind: "daily", time: "08:00" });
  assert.equal(first[0] && "schedule" in first[0], false, "a once idea has no schedule");

  clock = new Date("2026-10-26T02:00:00Z");
  const second = store.add([once("三")], OTHER_RUN);
  assert.deepEqual(store.list(), [...second, ...first]);
  assert.equal(second[0]?.runId, OTHER_RUN);
  assert.deepEqual(IdeaListSchema.parse(JSON.parse(fs.readFileSync(file, "utf8"))), { ideas: [...second, ...first] });
  assert.deepEqual(updates(events), [
    [first[0]?.id, "open"],
    [first[1]?.id, "open"],
    [second[0]?.id, "open"],
  ]);
});

test("add leaves out a draft the schema refuses and adds the rest", () => {
  const { events, store } = open();
  const added = store.add(
    [
      recurring("有计划"),
      { ...recurring("没有计划"), schedule: undefined },
      { ...recurring("一次计划"), schedule: { kind: "once", at: "2026-10-27T00:00:00.000Z" } },
      once("好"),
    ],
    RUN,
  );
  assert.deepEqual(added.map((idea) => idea.title), ["有计划", "好"]);
  assert.deepEqual(store.list().map((idea) => idea.title), ["有计划", "好"]);
  assert.equal(updates(events).length, 2);
});

test("accept takes an open idea to accepted with its task, and reject to rejected with the reason", () => {
  const { events, store } = open();
  const [taken, declined] = store.add([once("采纳"), once("拒绝")], RUN);
  if (!taken || !declined) throw new Error("two ideas were added");

  clock = new Date("2026-10-26T03:00:00Z");
  const accepted = store.accept(taken.id, "b2c3d4");
  assert.deepEqual(accepted, { ...taken, state: "accepted", taskId: "b2c3d4", updatedAt: "2026-10-26T03:00:00.000Z" });
  const rejection = { reason: "too-expensive" as const, note: "太贵了" };
  const rejected = store.reject(declined.id, rejection);
  assert.deepEqual(rejected, { ...declined, state: "rejected", rejection, updatedAt: "2026-10-26T03:00:00.000Z" });
  assert.deepEqual(store.get(taken.id), accepted);
  assert.deepEqual(store.get(declined.id), rejected);
  assert.deepEqual(updates(events), [
    [taken.id, "open"],
    [declined.id, "open"],
    [taken.id, "accepted"],
    [declined.id, "rejected"],
  ]);
});

test("a change to an idea that is not open is refused and changes nothing; an unknown id is undefined", () => {
  const { events, store } = open();
  const [taken, declined] = store.add([once("采纳"), once("拒绝")], RUN);
  if (!taken || !declined) throw new Error("two ideas were added");
  const accepted = store.accept(taken.id, "b2c3d4");
  const rejection = { reason: "not-now" as const };
  store.reject(declined.id, rejection);
  const before = store.list();

  assert.throws(() => store.reject(taken.id, rejection), (err: unknown) => err instanceof IdeaNotOpen && err.message === "the idea is accepted");
  assert.throws(() => store.accept(declined.id, "c3d4e5"), (err: unknown) => err instanceof IdeaNotOpen && err.message === "the idea is rejected");
  assert.deepEqual(store.list(), before);
  assert.deepEqual(store.get(taken.id), accepted);
  assert.equal(updates(events).length, 4, "only the two adds and the two changes");

  assert.equal(store.accept("zzzzzz", "b2c3d4"), undefined, "no such idea");
  assert.equal(store.reject("zzzzzz", rejection), undefined, "no such idea");
});

test("archiveStale archives an open idea 7 days old, not one a minute younger, and leaves closed ideas alone", () => {
  const { events, store } = open();
  const [stale, declined] = store.add([once("旧的"), once("拒绝的")], RUN);
  if (!stale || !declined) throw new Error("two ideas were added");
  store.reject(declined.id, { reason: "wrong-direction" });

  clock = new Date(START.getTime() + IDEA_ARCHIVE_MS - 60_000);
  const young = store.add([once("新的")], OTHER_RUN)[0];
  assert.deepEqual(store.archiveStale(), [], "one minute short of 7 days");

  clock = new Date(START.getTime() + IDEA_ARCHIVE_MS);
  const archived = store.archiveStale();
  assert.deepEqual(archived, [{ ...stale, state: "archived", updatedAt: clock.toISOString() }]);
  assert.deepEqual(store.list().map((idea) => idea.state), ["open", "archived", "rejected"]);
  assert.equal(store.get(young?.id ?? "")?.state, "open", "six days and 23 hours old is not stale yet");
  assert.equal(store.get(declined.id)?.state, "rejected", "a closed idea is not archived");
  assert.deepEqual(updates(events).slice(-1), [[stale.id, "archived"]]);
  assert.deepEqual(store.archiveStale(), [], "nothing is archived twice");
});

test("startGeneration records the run, finishGeneration clears it only for that run, and neither logs an event", () => {
  const { file, events, store } = open();
  store.startGeneration(RUN);
  assert.equal(store.generatingRunId(), RUN);
  assert.deepEqual(IdeaListSchema.parse(JSON.parse(fs.readFileSync(file, "utf8"))), { ideas: [], generatingRunId: RUN });

  store.finishGeneration(OTHER_RUN);
  assert.equal(store.generatingRunId(), RUN, "another run's generation is not finished");
  store.finishGeneration(RUN);
  assert.equal(store.generatingRunId(), undefined);
  assert.deepEqual(IdeaListSchema.parse(JSON.parse(fs.readFileSync(file, "utf8"))), { ideas: [] });
  assert.equal(events.readSince(0).length, 0);
});

test("a generation left in the file by a restart is dropped when the store opens", () => {
  const { file, events, store } = open();
  const added = store.add([once("一")], RUN);
  store.startGeneration(OTHER_RUN);

  const reopened = new IdeaStore({ file, events, now });
  assert.equal(reopened.generatingRunId(), undefined);
  const saved = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  assert.equal("generatingRunId" in saved, false, "the file is written without it");
  assert.deepEqual(reopened.list(), added);
  assert.equal(events.readSince(0).length, 1, "only the add");
});

test("a new store reads the same ideas, newest created first; a file that is not an idea list is an error", () => {
  const { file, events, store } = open();
  const first = store.add([once("一")], RUN);
  clock = new Date("2026-10-26T02:00:00Z");
  const second = store.add([recurring("二")], OTHER_RUN);

  const reopened = new IdeaStore({ file, events, now });
  assert.deepEqual(reopened.list(), [...second, ...first]);
  assert.deepEqual(reopened.get(first[0]?.id ?? ""), first[0]);

  fs.writeFileSync(file, JSON.stringify({ ideas: "nope" }));
  assert.throws(() => new IdeaStore({ file, events, now }), (err: unknown) => err instanceof Error && err.message.includes(file));
  fs.writeFileSync(file, "{ not json");
  assert.throws(() => new IdeaStore({ file, events, now }), (err: unknown) => err instanceof Error && err.message.includes(file));
});

test("every write keeps the open ideas and the 200 closed ones updated last, and drops the rest with no event", () => {
  const { file, events, store } = open();
  const openIdeas = store.add([once("开一"), once("开二"), once("开三")], RUN);
  const batch = store.add(Array.from({ length: MAX_CLOSED_IDEAS + 2 }, (_, i) => once(`拒${i}`)), RUN);
  assert.equal(new Set(batch.map((idea) => idea.id)).size, batch.length, "every id is distinct");

  // Reject all but the first, then the first last: it was created first but is updated last, so it is kept.
  const order = [...batch.slice(1), ...batch.slice(0, 1)];
  order.forEach((idea, i) => {
    clock = new Date(START.getTime() + (i + 1) * 1000);
    store.reject(idea.id, { reason: "not-now" });
  });

  const dropped = batch.slice(1, 3).map((idea) => store.get(idea.id));
  assert.deepEqual(dropped, [undefined, undefined], "the two rejected earliest are dropped");
  assert.equal(store.get(batch[0]?.id ?? "")?.state, "rejected", "the first created, rejected last, is kept");
  assert.deepEqual(store.list().filter((idea) => idea.state === "open"), openIdeas);
  assert.equal(store.list().filter((idea) => idea.state !== "open").length, MAX_CLOSED_IDEAS);

  const reopened = new IdeaStore({ file, events, now });
  assert.deepEqual(reopened.list(), store.list());
  assert.equal(updates(events).length, openIdeas.length + batch.length + batch.length, "the adds and the rejections, and no event for a prune");
});
