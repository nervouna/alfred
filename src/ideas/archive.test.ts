import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, mock, test } from "node:test";

import type { IdeaDraft } from "./store.ts";

// store.ts reads this at import time (through runs.ts), so set it before loading the modules under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-idea-archive-")));
process.env.ALFRED_STATE_DIR = path.join(tmp, "state");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { EventLog } = await import("../events.ts");
const { startArchiving } = await import("./archive.ts");
const { IdeaStore } = await import("./store.ts");

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

const draft: IdeaDraft = {
  title: "对比三家 VPS 的带宽配额",
  why: "上一份价格报告没有写带宽，你在对话里问过这件事。",
  brief: "查三家供应商官网的带宽政策，整理成一张表。",
  kind: "once",
  model: "sonnet",
  estimateUsd: 0.35,
};

/** Only archiveStale matters to startArchiving, so a fake store with that method stands in for the real one. */
function fakeStore(archiveStale: () => unknown[]): InstanceType<typeof IdeaStore> {
  return { archiveStale } as unknown as InstanceType<typeof IdeaStore>;
}

test("archives at once, again after each interval, and not after it is stopped", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  const archiveStale = mock.fn((): unknown[] => []);
  const stop = startArchiving(fakeStore(archiveStale), 1000);
  assert.equal(archiveStale.mock.callCount(), 1, "at once");

  mock.timers.tick(999);
  assert.equal(archiveStale.mock.callCount(), 1);
  mock.timers.tick(1);
  assert.equal(archiveStale.mock.callCount(), 2, "after one interval");

  stop();
  mock.timers.tick(10_000);
  assert.equal(archiveStale.mock.callCount(), 2, "stopped");
});

test("logs one line naming the ideas it archived, and says nothing when none is stale", () => {
  const dir = path.join(tmp, "archived");
  const events = new EventLog(path.join(dir, "events.jsonl"));
  let clock = new Date("2026-10-19T00:00:00Z");
  const store = new IdeaStore({ file: path.join(dir, "ideas.json"), events, now: () => clock });
  const [stale] = store.add([draft], "k7m2qa");
  if (!stale) throw new Error("the idea was not added");
  clock = new Date("2026-10-27T00:00:00Z");

  const lines = mock.method(console, "log", () => {});
  startArchiving(store, 3_600_000)();
  const archiving = lines.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.includes("archived"));
  assert.equal(archiving.length, 1);
  assert.ok(archiving[0]?.includes(stale.id), "the line names the idea");
  assert.equal(store.get(stale.id)?.state, "archived");

  lines.mock.resetCalls();
  startArchiving(store, 3_600_000)();
  assert.equal(lines.mock.calls.filter((call) => String(call.arguments[0]).includes("archived")).length, 0, "nothing more to archive");
});

test("a store that throws is logged, and the archiving goes on at the next interval", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  const errors = mock.method(console, "error", () => {});
  let calls = 0;
  const archiveStale = (): unknown[] => {
    calls++;
    if (calls === 1) throw new Error("disk full");
    return [];
  };
  let stop: (() => void) | undefined;
  assert.doesNotThrow(() => {
    stop = startArchiving(fakeStore(archiveStale), 1000);
  });
  assert.ok(errors.mock.calls.some((call) => String(call.arguments[0]).includes("disk full")), "the failure is logged");

  assert.doesNotThrow(() => mock.timers.tick(1000));
  assert.equal(calls, 2, "the next interval archives again");
  stop?.();
});
