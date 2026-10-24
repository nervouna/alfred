import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// store.ts reads this at import time, so set it before loading the module under test.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alfred-data-"));
process.env.ALFRED_STATE_DIR = path.join(tmp, "state");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { spendByDay } = await import("./data.ts");
type RunRecord = import("../runs.ts").RunRecord;

test("daily spend leaves subagent runs out: their cost is part of their task's", () => {
  const run = (id: string, kind: RunRecord["kind"], costUsd: number, modelCostUsd?: Record<string, number>): RunRecord => ({
    id,
    kind,
    title: id,
    status: "done",
    startedAt: "2026-10-25T01:00:00Z",
    costUsd,
    modelCostUsd,
    toolCalls: 0,
    files: [],
  });
  const [day] = spendByDay([
    run("task22", "task", 1.5, { opus: 0.5, sonnet: 1 }),
    run("sub222", "subagent", 0.6),
    run("sub223", "subagent", 0.4),
    run("scan22", "scan", 0.01),
  ]);
  assert.equal(day?.runs, 2);
  assert.ok(Math.abs((day?.costUsd ?? 0) - 1.51) < 1e-9);
  assert.deepEqual(day?.byModel, { opus: 0.5, sonnet: 1 });
});
