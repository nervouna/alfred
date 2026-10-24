import assert from "node:assert/strict";
import { test } from "node:test";

import { accountModels, accountRun, resumePrevious, retire, rotationDueAt, shouldRotate } from "./session.ts";
import type { AgentUserState } from "./state.ts";

const HOUR = 3_600_000;
const lastRun = Date.parse("2026-10-10T08:00:00.000Z");

function state(patch: Partial<AgentUserState> = {}): AgentUserState {
  return {
    sessionId: "session-a",
    model: "sonnet",
    sessionCostUsd: 0,
    totalCostUsd: 0,
    lastRunAt: new Date(lastRun).toISOString(),
    ...patch,
  };
}

/** Applies a patch the way AgentStateStore.update does. */
function apply(s: AgentUserState, patch: Partial<AgentUserState>): AgentUserState {
  return { ...s, ...patch };
}

test("shouldRotate rotates only when idle time exceeds the threshold", () => {
  assert.equal(shouldRotate(state(), lastRun + 4 * HOUR - 1, 4), false, "below");
  assert.equal(shouldRotate(state(), lastRun + 4 * HOUR, 4), false, "at");
  assert.equal(shouldRotate(state(), lastRun + 4 * HOUR + 1, 4), true, "above");
  assert.equal(shouldRotate(state(), lastRun + 0.5 * HOUR + 1, 0.5), true, "fractional hours");
});

test("shouldRotate never rotates with threshold 0, without a previous run or without a session", () => {
  assert.equal(shouldRotate(state(), lastRun + 1000 * HOUR, 0), false, "threshold 0");
  assert.equal(shouldRotate(state({ lastRunAt: undefined }), lastRun + 1000 * HOUR, 4), false, "no previous run");
  assert.equal(shouldRotate(state({ lastRunAt: "garbage" }), lastRun + 1000 * HOUR, 4), false, "unparsable lastRunAt");
  assert.equal(shouldRotate(state({ sessionId: undefined }), lastRun + 1000 * HOUR, 4), false, "no session");
});

test("rotationDueAt is lastRunAt plus the threshold, or undefined when rotation is off", () => {
  assert.equal(rotationDueAt(state(), 4), lastRun + 4 * HOUR);
  assert.equal(rotationDueAt(state(), 0), undefined);
  assert.equal(rotationDueAt(state({ sessionId: undefined }), 4), undefined);
});

test("retire keeps the session for /resume and resets session spend only", () => {
  const sessionModelCostUsd = { "claude-sonnet-5-5": 1.2, "claude-haiku-5-5": 0.3 };
  const before = state({ sessionCostUsd: 1.5, sessionModelCostUsd, totalCostUsd: 7, sessionStartedAt: "2026-10-10T07:00:00.000Z" });
  const after = apply(before, retire(before));
  assert.equal(after.sessionId, undefined);
  assert.equal(after.sessionStartedAt, undefined);
  assert.equal(after.sessionCostUsd, 0);
  assert.equal(after.sessionModelCostUsd, undefined);
  assert.equal(after.totalCostUsd, 7);
  assert.deepEqual(after.previousSession, {
    sessionId: "session-a",
    sessionCostUsd: 1.5,
    sessionModelCostUsd,
    sessionStartedAt: "2026-10-10T07:00:00.000Z",
  });
  assert.deepEqual(retire(state({ sessionId: undefined })), {});
});

test("resumePrevious swaps sessions, so a second /resume undoes the first, and restarts the idle clock", () => {
  const now = lastRun + 10 * HOUR;
  const first = state({ sessionCostUsd: 1.5, sessionModelCostUsd: { "claude-sonnet-5-5": 1.5 } });
  const retired = apply(first, retire(first));
  const current = apply(retired, { sessionId: "session-b", sessionCostUsd: 0.25, sessionModelCostUsd: { "claude-opus-5-5": 0.25 } });

  const resumed = apply(current, resumePrevious(current, now) ?? {});
  assert.equal(resumed.sessionId, "session-a");
  assert.equal(resumed.sessionCostUsd, 1.5);
  assert.deepEqual(resumed.sessionModelCostUsd, { "claude-sonnet-5-5": 1.5 });
  assert.equal(resumed.previousSession?.sessionId, "session-b");
  assert.equal(resumed.previousSession?.sessionCostUsd, 0.25);
  assert.deepEqual(resumed.previousSession?.sessionModelCostUsd, { "claude-opus-5-5": 0.25 });
  assert.equal(resumed.lastRunAt, new Date(now).toISOString());
  assert.equal(shouldRotate(resumed, now + HOUR, 4), false);

  const back = apply(resumed, resumePrevious(resumed, now) ?? {});
  assert.equal(back.sessionId, "session-b");
  assert.equal(back.previousSession?.sessionId, "session-a");
});

test("resumePrevious after /new with no new session yet leaves nothing to swap back", () => {
  const retired = apply(state(), retire(state()));
  const resumed = apply(retired, resumePrevious(retired, lastRun) ?? {});
  assert.equal(resumed.sessionId, "session-a");
  assert.equal(resumed.previousSession, undefined);
  assert.equal(resumePrevious(state(), lastRun), undefined);
});

test("spend: sessionCostUsd resets across a rotation and totalCostUsd keeps accumulating", () => {
  let s = state({ sessionCostUsd: 1, totalCostUsd: 5 });
  // The SDK reports the session's running total: 1 earlier + 0.5 this run.
  let run = accountRun(s, 1.5);
  assert.deepEqual(run, { sessionCostUsd: 1.5, totalCostUsd: 5.5, deltaUsd: 0.5 });
  s = apply(s, { sessionCostUsd: run.sessionCostUsd, totalCostUsd: run.totalCostUsd });

  s = apply(s, retire(s));
  assert.equal(s.sessionCostUsd, 0);
  assert.equal(s.totalCostUsd, 5.5);

  s = apply(s, { sessionId: "session-b" });
  run = accountRun(s, 0.25);
  assert.deepEqual(run, { sessionCostUsd: 0.25, totalCostUsd: 5.75, deltaUsd: 0.25 });
  s = apply(s, { sessionCostUsd: run.sessionCostUsd, totalCostUsd: run.totalCostUsd });

  // /resume restores session A's running total, so its next run is charged only the increment.
  s = apply(s, resumePrevious(s, lastRun) ?? {});
  assert.equal(s.sessionCostUsd, 1.5);
  run = accountRun(s, 2);
  assert.deepEqual(run, { sessionCostUsd: 2, totalCostUsd: 6.25, deltaUsd: 0.5 });
});

test("spend: a resumed session whose transcript saved no total is charged the whole reported cost", () => {
  assert.deepEqual(accountRun(state({ sessionCostUsd: 1.5, totalCostUsd: 3 }), 0.25), {
    sessionCostUsd: 0.25,
    totalCostUsd: 3.25,
    deltaUsd: 0.25,
  });
});

test("accountModels charges each model its increment since the last result", () => {
  const first = accountModels(state(), { "claude-sonnet-5-5": 0.4, "claude-haiku-5-5": 0.05 });
  assert.deepEqual(first.deltaUsd, { "claude-sonnet-5-5": 0.4, "claude-haiku-5-5": 0.05 });

  const s1 = state({ sessionModelCostUsd: first.sessionModelCostUsd });
  const second = accountModels(s1, { "claude-sonnet-5-5": 0.5, "claude-haiku-5-5": 0.05, "claude-opus-5-5": 1 });
  assert.deepEqual(second.deltaUsd, { "claude-sonnet-5-5": 0.5 - 0.4, "claude-opus-5-5": 1 }, "unchanged models are left out");
  assert.deepEqual(second.sessionModelCostUsd, { "claude-sonnet-5-5": 0.5, "claude-haiku-5-5": 0.05, "claude-opus-5-5": 1 });
});

test("accountModels charges the whole reported total when a model's total went down", () => {
  const s = state({ sessionModelCostUsd: { "claude-sonnet-5-5": 2 } });
  assert.deepEqual(accountModels(s, { "claude-sonnet-5-5": 0.3 }).deltaUsd, { "claude-sonnet-5-5": 0.3 });
});
