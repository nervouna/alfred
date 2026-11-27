import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { Outbound } from "./channels.ts";
import type { RunRecord } from "./runs.ts";

// store.ts reads these at import time, so set them before loading the modules under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-spend-")));
process.env.ALFRED_WORKSPACE = path.join(tmp, "workspace");
process.env.ALFRED_STATE_DIR = path.join(tmp, "state");
process.env.ALFRED_ANTHROPIC_API_KEY = "sk-test";
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const spend = await import("./spend.ts");
const { RUNS_LOG } = await import("./runs.ts");
const { alfredToolDefinitions } = await import("./agent/tools.ts");

const at = (month: number, day: number): string => new Date(2026, month - 1, day, 12).toISOString();

function run(id: string, patch: Partial<RunRecord>): RunRecord {
  return { id, kind: "task", title: id, status: "done", startedAt: at(11, 25), costUsd: 0, toolCalls: 0, files: [], ...patch };
}

/** A fixture log: a chat run with a subagent of its own, a scheduled task's run, idea generation, and a run in the month before. */
const RUNS: RunRecord[] = [
  run("chat1", { costUsd: 1, modelCostUsd: { opus: 0.8, haiku: 0.2 }, model: "opus" }),
  run("sub1", { kind: "subagent", parentRunId: "chat1", role: "researcher", costUsd: 0.3 }),
  run("task1", { taskId: "t1", startedAt: at(11, 26), costUsd: 0.5, modelCostUsd: { sonnet: 0.5 } }),
  run("ideas1", { kind: "ideas", startedAt: at(11, 26), costUsd: 0.2, model: "sonnet" }),
  run("old1", { startedAt: at(10, 30), costUsd: 9 }),
];

const entry = (runId: string, server: string, tool: string, usd: number, when: string) => ({ at: when, runId, server, tool, units: 1, usd, estimated: true as const });
const EXTERNAL = [
  entry("chat1", "img", "generate", 0.04, at(11, 25)),
  entry("task1", "img", "generate", 0.04, at(11, 26)),
  entry("chat1", "xapi", "post", 0.01, at(11, 26)),
  entry("old1", "img", "generate", 5, at(10, 30)),
];

const NOVEMBER = { from: "2026-11-01", to: "2026-11-30" };
const rowsOf = (rows: { key: string; usd: number }[]) => Object.fromEntries(rows.map((r) => [r.key, Math.round(r.usd * 1e6) / 1e6]));

test("each grouping sums the run records, and the external spend stays a figure of its own", () => {
  const by = (groupBy: (typeof spend.SPEND_GROUPS)[number]) => spend.querySpend({ ...NOVEMBER, groupBy }, RUNS, EXTERNAL);

  const day = by("day");
  assert.deepEqual(rowsOf(day.runRecords.rows), { "2026-11-25": 1, "2026-11-26": 0.7 });
  assert.deepEqual(rowsOf(day.external.rows), { "2026-11-25": 0.04, "2026-11-26": 0.05 });
  // The subagent's cost is inside its parent's, so it is not added, and the month before is outside the period.
  assert.equal(Math.round(day.runRecords.totalUsd * 1e6) / 1e6, 1.7);
  assert.equal(day.runRecords.runs, 3);
  assert.equal(Math.round(day.external.totalUsd * 1e6) / 1e6, 0.09);
  assert.equal(day.external.calls, 3);

  assert.deepEqual(rowsOf(by("kind").runRecords.rows), { chat: 1, task: 0.5, ideas: 0.2 });
  assert.deepEqual(rowsOf(by("kind").external.rows), { chat: 0.05, task: 0.04 });
  assert.deepEqual(rowsOf(by("model").runRecords.rows), { opus: 0.8, sonnet: 0.7, haiku: 0.2 });
  assert.deepEqual(rowsOf(by("task").runRecords.rows), { "(none)": 1.2, t1: 0.5 });
  assert.deepEqual(rowsOf(by("task").external.rows), { "(none)": 0.05, t1: 0.04 });
  assert.deepEqual(rowsOf(by("role").runRecords.rows), { "(main thread)": 1.4, researcher: 0.3 });

  const server = by("server");
  assert.deepEqual(rowsOf(server.external.rows), { img: 0.08, xapi: 0.01 });
  assert.deepEqual(server.runRecords.rows, []);
  assert.equal(Math.round(server.runRecords.totalUsd * 1e6) / 1e6, 1.7, "the run records' total does not depend on the grouping");
});

test("a day is a local day, and a period with nothing in it is zero", () => {
  const one = spend.querySpend({ from: "2026-11-26", to: "2026-11-26", groupBy: "day" }, RUNS, EXTERNAL);
  assert.equal(Math.round(one.runRecords.totalUsd * 1e6) / 1e6, 0.7);
  assert.equal(Math.round(one.external.totalUsd * 1e6) / 1e6, 0.05);
  const none = spend.querySpend({ from: "2026-12-01", to: "2026-12-31", groupBy: "kind" }, RUNS, EXTERNAL);
  assert.deepEqual([none.runRecords.totalUsd, none.external.totalUsd, none.runRecords.rows, none.external.rows], [0, 0, [], []]);
});

test("the report names the two figures apart and says which is which", () => {
  const text = spend.formatSpendReport(spend.querySpend({ ...NOVEMBER, groupBy: "kind" }, RUNS, EXTERNAL));
  assert.match(text, /Run records \(Anthropic usage, what the daily and monthly caps count[^)]*\): \$1\.70 over 3 runs/);
  assert.match(text, /External tools \(the owner's price estimates per call, not in the caps\): \$0\.090 over 3 calls/);
  assert.match(text, /\n {2}chat: \$1\.00 \(1 runs\)/);
});

test("a period is a day, a month or two dates, and a request that does not fit says so", () => {
  const now = new Date(2026, 10, 27, 9);
  assert.deepEqual(spend.spendPeriod({}, now), { from: "2026-11-27", to: "2026-11-27" });
  assert.deepEqual(spend.spendPeriod({ period: "day", date: "2026-11-03" }, now), { from: "2026-11-03", to: "2026-11-03" });
  assert.deepEqual(spend.spendPeriod({ period: "month" }, now), { from: "2026-11-01", to: "2026-11-30" });
  assert.deepEqual(spend.spendPeriod({ period: "month", date: "2028-02" }, now), { from: "2028-02-01", to: "2028-02-29" });
  assert.deepEqual(spend.spendPeriod({ from: "2026-11-01", to: "2026-11-10", period: "day" }, now), { from: "2026-11-01", to: "2026-11-10" });
  for (const bad of [{ from: "2026-11-01" }, { from: "2026-11-10", to: "2026-11-01" }, { from: "x", to: "y" }, { date: "2026-02-30" }, { period: "month" as const, date: "2026-13" }]) {
    assert.equal(typeof spend.spendPeriod(bad, now), "string", JSON.stringify(bad));
  }
});

test("an entry is appended as a line with the fixed fields, and one cut short is skipped on reading", () => {
  const file = path.join(tmp, "log", "external-spend.jsonl");
  assert.deepEqual(spend.readExternalSpend(file), [], "no file is no spend");
  spend.appendExternalSpend(entry("r1", "img", "generate", 0.04, at(11, 25)), file);
  fs.appendFileSync(file, '{"at":"2026-11-2\n');
  spend.appendExternalSpend(entry("r2", "img", "generate", 0.06, at(11, 26)), file);
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.deepEqual(Object.keys(JSON.parse(lines[0] ?? "")), ["at", "runId", "server", "tool", "units", "usd", "estimated"]);
  assert.deepEqual(spend.readExternalSpend(file).map((e) => e.runId), ["r1", "r2"]);
  assert.ok(Math.abs(spend.externalSpendOfMonth("2026-11", file) - 0.1) < 1e-12);
  assert.equal(spend.externalSpendOfMonth("2026-12", file), 0);
});

test("a run's calls of a tool are limited by reserve, and a failed call is given back", () => {
  assert.equal(spend.reserveCall("limit-run", "ext__t", 2), true);
  assert.equal(spend.reserveCall("limit-run", "ext__t", 2), true);
  assert.equal(spend.reserveCall("limit-run", "ext__t", 2), false);
  assert.equal(spend.reserveCall("other-run", "ext__t", 2), true, "another run has its own count");
  assert.equal(spend.reserveCall("limit-run", "ext__u", 2), true, "and another tool its own");
  spend.releaseCall("limit-run", "ext__t");
  assert.equal(spend.reserveCall("limit-run", "ext__t", 2), true);
});

const out = {} as Outbound;
interface Result {
  content: { text: string }[];
  isError?: boolean;
}

function spendQuery() {
  const def = alfredToolDefinitions(out, undefined, undefined, undefined, false, true).find((d) => d.name === "spend_query");
  assert.ok(def, "a chat run has spend_query");
  return def.handler as unknown as (args: Record<string, unknown>, extra: unknown) => Promise<Result>;
}

test("spend_query reads the run log and the external log and answers with the two figures apart", async () => {
  fs.mkdirSync(path.dirname(RUNS_LOG), { recursive: true });
  fs.writeFileSync(RUNS_LOG, `${RUNS.map((r) => JSON.stringify(r)).join("\n")}\n`);
  fs.writeFileSync(spend.EXTERNAL_SPEND_LOG, `${EXTERNAL.map((e) => JSON.stringify(e)).join("\n")}\n`);

  const month = await spendQuery()({ period: "month", date: "2026-11", group_by: "server" }, {});
  assert.equal(month.isError, undefined);
  const text = month.content.map((c) => c.text).join("\n");
  assert.match(text, /Run records .*\$1\.70 over 3 runs/);
  assert.match(text, /External tools .*\$0\.090 over 3 calls/);
  assert.match(text, /img: \$0\.080 \(2 calls\)/);
  assert.match(text, /xapi: \$0\.010 \(1 calls\)/);

  const range = await spendQuery()({ from: "2026-11-26", to: "2026-11-26", group_by: "kind" }, {});
  assert.match(range.content.map((c) => c.text).join("\n"), /\$0\.700 over 2 runs/);
});

test("spend_query refuses a period that does not fit, and is only in the tools of a chat run", async () => {
  const bad = await spendQuery()({ from: "2026-11-30", to: "2026-11-01", group_by: "day" }, {});
  assert.equal(bad.isError, true);
  assert.match(bad.content[0]?.text ?? "", /from is after to/);
  assert.ok(!alfredToolDefinitions(out).some((d) => d.name === "spend_query"), "a run that is not a chat run does not get it");
  assert.ok(!alfredToolDefinitions(out, undefined, undefined, undefined, true).some((d) => d.name === "spend_query"), "nor does a revision run");
});
