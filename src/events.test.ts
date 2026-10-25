import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { Run } from "./api/schema.ts";

// store.ts reads this at import time, so set it before loading the module under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-events-")));
process.env.ALFRED_STATE_DIR = path.join(tmp, "state");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { EVENTS_LOG, EventLog, sharedEventLog } = await import("./events.ts");

const run: Run = {
  id: "k7m2qa",
  kind: "task",
  title: "调研 VPS 价格",
  status: "running",
  startedAt: "2026-10-25T08:30:05.000Z",
  costUsd: 0,
  files: [],
};

/** A log file of its own; its directory does not exist yet. */
function logFile(name: string): string {
  return path.join(tmp, name, "events", "events.jsonl");
}

test("the shared log is events/events.jsonl in the state dir, and one instance", () => {
  assert.equal(EVENTS_LOG, path.join(tmp, "state", "events", "events.jsonl"));
  assert.equal(sharedEventLog(), sharedEventLog());
});

test("ids start at 1, grow by one and continue across instances on the same file", () => {
  const file = logFile("continue");
  const first = new EventLog(file);
  assert.equal(first.lastId(), 0, "an empty log has no events");
  assert.equal(first.append("run.updated", run)?.id, 1);
  assert.equal(first.append("run.updated", run)?.id, 2);

  const second = new EventLog(file);
  assert.equal(second.lastId(), 2);
  assert.equal(second.append("run.updated", run)?.id, 3);
  assert.equal(first.append("run.updated", run)?.id, 4, "an instance that wrote earlier picks up the other's events");
  assert.deepEqual(second.readSince(0).map((e) => e.id), [1, 2, 3, 4]);
});

test("an appended event has a UTC timestamp and the data without the fields the schema does not know", () => {
  const file = logFile("shape");
  const log = new EventLog(file);
  const extra = { ...run, toolCalls: 3 };
  const event = log.append("run.updated", extra);

  assert.match(event?.at ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(event?.type, "run.updated");
  assert.equal(event && "toolCalls" in event.data, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8").trim()), event, "one JSON line per event");
});

test("an invalid event is not written, does not use up an id and returns undefined", () => {
  const file = logFile("invalid");
  const log = new EventLog(file);
  assert.equal(log.append("run.updated", run)?.id, 1);

  // @ts-expect-error "paused" is not a run status
  assert.equal(log.append("run.updated", { ...run, status: "paused" }), undefined);

  assert.equal(log.lastId(), 1);
  assert.equal(fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length, 1);
  assert.equal(log.append("run.updated", run)?.id, 2, "the next valid event takes the id");
});

test("readSince returns the events after an id, in order, up to the limit", () => {
  const log = new EventLog(logFile("read"));
  for (let i = 0; i < 5; i++) log.append("run.updated", run);

  assert.deepEqual(log.readSince(0).map((e) => e.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(log.readSince(2).map((e) => e.id), [3, 4, 5]);
  assert.deepEqual(log.readSince(0, 2).map((e) => e.id), [1, 2]);
  assert.deepEqual(log.readSince(3, 1).map((e) => e.id), [4]);
  assert.deepEqual(log.readSince(5), []);
  assert.deepEqual(new EventLog(logFile("missing")).readSince(0), [], "a missing file is an empty log");
});

test("readSince returns at most 1000 events unless told otherwise", () => {
  const log = new EventLog(logFile("many"));
  for (let i = 0; i < 1001; i++) log.append("run.updated", run);

  assert.equal(log.readSince(0).length, 1000);
  assert.deepEqual(log.readSince(1000).map((e) => e.id), [1001]);
});

test("listeners hear each appended event until they unsubscribe", () => {
  const log = new EventLog(logFile("subscribe"));
  const heard: number[] = [];
  const stop = log.subscribe((event) => heard.push(event.id));

  log.append("run.updated", run);
  stop();
  log.append("run.updated", run);

  assert.deepEqual(heard, [1]);
});

test("a listener that throws does not stop the others or the append", () => {
  const log = new EventLog(logFile("throwing"));
  const heard: number[] = [];
  log.subscribe(() => {
    throw new Error("listener failed");
  });
  log.subscribe((event) => heard.push(event.id));

  assert.equal(log.append("run.updated", run)?.id, 1);
  assert.deepEqual(heard, [1]);
  assert.equal(log.readSince(0).length, 1);
});

test("a truncated last line is skipped, and the next id follows the last whole event", () => {
  const file = logFile("truncated");
  const log = new EventLog(file);
  log.append("run.updated", run);
  log.append("run.updated", run);
  // What a crash in the middle of a write leaves behind: a line cut short, with no newline.
  fs.appendFileSync(file, '{"id":3,"at":"2026-10-25T08:3');

  const restarted = new EventLog(file);
  assert.equal(restarted.lastId(), 2);
  assert.equal(restarted.append("run.updated", run)?.id, 3);
  assert.deepEqual(restarted.readSince(0).map((e) => e.id), [1, 2, 3], "the new event is not glued to the cut line");
});

test("the log directory is created with mode 0700 and the file with mode 0600", () => {
  const file = logFile("modes");
  assert.ok(new EventLog(file).append("run.updated", run));

  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
