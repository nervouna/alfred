import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// store.ts reads this at import time, so set it before loading the module under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-runs-")));
process.env.ALFRED_STATE_DIR = path.join(tmp, "state");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { EVENTS_LOG, EventLog } = await import("./events.ts");
const { RUNS_LOG, RUN_FILES_DIR, RunRecorder, findRun, markLostRuns, newRunId, pruneRunFiles, readRunFile, readRunLog, runIdCandidates, stepDetail } =
  await import("./runs.ts");

/** The run.updated events in a log, oldest first, as run id and status. */
function runUpdates(log: InstanceType<typeof EventLog>): { id: string; status: string }[] {
  return log.readSince(0).flatMap((e) => (e.type === "run.updated" ? [{ id: e.data.id, status: e.data.status }] : []));
}

test("run ids are six easy-to-type characters with a digit and a letter", () => {
  for (let i = 0; i < 200; i++) {
    const id = newRunId(() => false);
    assert.match(id, /^[2-9a-hjkmnp-z]{6}$/);
    assert.match(id, /[2-9]/);
    assert.match(id, /[a-z]/);
  }
  const taken = new Set(["k7m2qa"]);
  let calls = 0;
  const id = newRunId((candidate) => (calls++ === 0 ? true : taken.has(candidate)));
  assert.ok(calls >= 2 && !taken.has(id), "an id that exists is drawn again");
});

test("runIdCandidates finds ids in Chinese and English text and skips plain words", () => {
  assert.deepEqual(runIdCandidates("看看 k7m2qa 这个的结果"), ["k7m2qa"]);
  assert.deepEqual(runIdCandidates("把k7m2qa改成英文，还有 P3X9ZA"), ["k7m2qa", "p3x9za"]);
  assert.deepEqual(runIdCandidates("the report about pandas"), [], "a word without a digit");
  assert.deepEqual(runIdCandidates("version 222222 of it"), [], "digits only");
  assert.deepEqual(runIdCandidates("k7m2qa7 and xk7m2qa"), [], "longer tokens");
  assert.deepEqual(runIdCandidates("k7m2qa k7m2qa"), ["k7m2qa"]);
  assert.deepEqual(runIdCandidates("l0o1ia"), [], "letters not in the alphabet");
});

test("a recorded run keeps its steps and files in its run file, then lands in runs.jsonl", () => {
  const run = new RunRecorder({ kind: "task", title: "调研", model: "claude-sonnet-5-5" });
  assert.equal(readRunFile(run.id)?.status, "running");
  run.step("WebSearch", "vps pricing");
  run.step("mcp__alfred__render_pdf", "reports/a.md", "writer");
  run.wrote("reports/a.md", "Write");
  run.wrote("reports/a.md", "Edit");
  run.wrote("notes/tmp.md", "Write");
  run.moved("notes/tmp.md", "notes/final.md");
  run.undelivered({ kind: "reply", error: "sendMessage failed: ret=-2" });
  run.update({ costUsd: 0.25, modelCostUsd: { "claude-sonnet-5-5": 0.25 } });
  run.finish("done");

  const file = readRunFile(run.id);
  assert.equal(file?.status, "done");
  assert.ok(file?.endedAt);
  assert.equal(file?.toolCalls, 2);
  assert.deepEqual(file?.steps.map((s) => [s.tool, s.agent]), [["WebSearch", undefined], ["render_pdf", "writer"]]);
  assert.deepEqual(file?.files, [
    { path: "reports/a.md", tool: "Edit" },
    { path: "notes/final.md", tool: "move_file" },
  ]);
  assert.equal(file?.undelivered?.[0]?.kind, "reply");

  const logged = readRunLog().find((r) => r.id === run.id);
  assert.equal(logged?.costUsd, 0.25);
  assert.ok(logged && !("steps" in logged), "the log line leaves out the steps");

  fs.rmSync(path.join(RUN_FILES_DIR, `${run.id}.json`));
  assert.equal(findRun(run.id)?.title, "调研", "a pruned run is still found in runs.jsonl");
  run.finish("failed");
  assert.equal(readRunLog().filter((r) => r.id === run.id).length, 1, "finish runs once");
});

test("runs left running by an earlier process are marked lost at startup", () => {
  const live = new RunRecorder({ kind: "task", title: "被打断的任务" });
  const lost = markLostRuns();
  assert.deepEqual(lost.map((r) => r.id), [live.id]);
  assert.equal(readRunFile(live.id)?.status, "lost");
  assert.equal(readRunLog().findLast((r) => r.id === live.id)?.status, "lost");
  assert.deepEqual(markLostRuns(), [], "only once");
});

test("pruneRunFiles removes run files that ended more than 30 days ago", () => {
  const old = new RunRecorder({ kind: "task", title: "old" });
  old.finish("done");
  const recent = new RunRecorder({ kind: "task", title: "recent" });
  recent.finish("done");
  const running = new RunRecorder({ kind: "task", title: "running" });
  const later = Date.parse(readRunFile(old.id)?.endedAt ?? "") + 31 * 86_400_000;
  // Only `old` is old enough: back-date the others' end.
  const recentFile = readRunFile(recent.id);
  assert.ok(recentFile);
  fs.writeFileSync(path.join(RUN_FILES_DIR, `${recent.id}.json`), JSON.stringify({ ...recentFile, endedAt: new Date(later - 86_400_000).toISOString() }));
  assert.ok(pruneRunFiles(later) >= 1);
  assert.equal(readRunFile(old.id), undefined);
  assert.ok(readRunFile(recent.id));
  assert.ok(readRunFile(running.id));
  assert.ok(fs.existsSync(RUNS_LOG));
});

test("stepDetail summarizes tool inputs with workspace-relative paths", () => {
  const ws = "/workspace";
  assert.equal(stepDetail("Read", { file_path: "/workspace/notes/a.md" }, ws), "notes/a.md");
  assert.equal(stepDetail("WebFetch", { url: "https://example.com/x", prompt: "..." }, ws), "https://example.com/x");
  assert.equal(stepDetail("Agent", { subagent_type: "researcher", description: "线程一" }, ws), "researcher「线程一」");
  assert.equal(stepDetail("Skill", { skill: "alfred:html-report" }, ws), "alfred:html-report");
  assert.equal(stepDetail("mcp__alfred__move_file", { from: "a.md", to: "b/a.md" }, ws), "a.md → b/a.md");
  assert.equal(stepDetail("WebSearch", { query: "x".repeat(300) }, ws).length, 160);
});

test("a queued run appends run.updated when it is queued, started and finished, and only then", () => {
  const events = new EventLog(path.join(tmp, "lifecycle.jsonl"));
  const run = new RunRecorder({ kind: "subagent", title: "核对带宽", queued: true, events });
  run.start();
  run.start();
  run.finish("done");
  run.finish("failed");
  assert.deepEqual(runUpdates(events).filter((u) => u.id === run.id).map((u) => u.status), ["queued", "running", "done"]);
});

test("steps, file writes and cost updates append no events", () => {
  const events = new EventLog(path.join(tmp, "steps.jsonl"));
  const run = new RunRecorder({ kind: "task", title: "调研", events });
  run.step("WebSearch", "vps pricing");
  run.wrote("reports/a.md", "Write");
  run.moved("reports/a.md", "reports/b.md");
  run.undelivered({ kind: "reply", error: "sendMessage failed: ret=-2" });
  run.update({ costUsd: 0.25 });
  assert.equal(runUpdates(events).filter((u) => u.id === run.id).length, 1, "the construction event only");
  run.finish("done");
  assert.equal(runUpdates(events).filter((u) => u.id === run.id).length, 2);
});

test("run.updated carries the run record without its steps", () => {
  const events = new EventLog(path.join(tmp, "shape.jsonl"));
  const run = new RunRecorder({ kind: "task", title: "形状", model: "claude-sonnet-5-5", events });
  run.step("Read", "notes/a.md");
  const event = events.readSince(0)[0];
  assert.equal(event?.type, "run.updated");
  assert.equal(event?.data.id, run.id);
  assert.equal(event && "steps" in event.data, false);
  run.finish("done");
});

test("markLostRuns appends one lost run.updated for each run it marks", () => {
  const events = new EventLog(path.join(tmp, "lost.jsonl"));
  const live = new RunRecorder({ kind: "task", title: "仍在运行", events });
  const queued = new RunRecorder({ kind: "subagent", title: "排队中", queued: true, events });
  const lost = markLostRuns(RUN_FILES_DIR, RUNS_LOG, events);

  assert.ok(lost.some((r) => r.id === live.id) && lost.some((r) => r.id === queued.id));
  assert.deepEqual(runUpdates(events).filter((u) => u.status === "lost").map((u) => u.id), lost.map((r) => r.id));
  assert.deepEqual(markLostRuns(RUN_FILES_DIR, RUNS_LOG, events), [], "only once");
});

test("a recorder without an events option writes to the shared log in the state dir", () => {
  const run = new RunRecorder({ kind: "task", title: "默认日志" });
  run.finish("done");
  assert.ok(runUpdates(new EventLog(EVENTS_LOG)).some((u) => u.id === run.id && u.status === "done"));
});
