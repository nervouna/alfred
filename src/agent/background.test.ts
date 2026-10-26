import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// store.ts reads this at import time, so set it before loading the modules under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-background-")));
process.env.ALFRED_STATE_DIR = path.join(tmp, "state");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { BackgroundRuns } = await import("./background.ts");
const { readRunFile, readRunLog } = await import("../runs.ts");
type Brief = import("./background.ts").QueuedBrief;

function setup(opts: { overBudget?: () => boolean } = {}) {
  const released: Brief[] = [];
  const bg = new BackgroundRuns({
    parentRunId: "k7m2qa",
    max: 2,
    overBudget: opts.overBudget ?? (() => false),
    release: (b) => released.push(b),
    transcriptOf: (agentId) => path.join(tmp, "transcripts", `agent-${agentId}.jsonl`),
  });
  const call = (n: number, background = true) => ({ toolUseId: `tu${n}`, role: "collector" as const, description: `job ${n}`, prompt: `brief ${n}`, background });
  return { bg, released, call };
}

test("two background subagents start; a third is queued and handed back when a slot frees", () => {
  const { bg, released, call } = setup();
  assert.equal(bg.admit(call(1)), undefined);
  assert.equal(bg.admit(call(2)), undefined);
  const refusal = bg.admit(call(3));
  assert.match(refusal ?? "", /queued as run [2-9a-hjkmnp-z]{6}/);
  assert.equal(bg.queued.length, 1);
  assert.equal(readRunFile(bg.queued[0]?.recorder.id ?? "")?.status, "queued", "the queued run has a card");
  assert.equal(bg.idle, false);

  bg.started("tu1", "agent-1");
  bg.started("tu2", "agent-2");
  assert.equal(bg.running.length, 2);
  assert.equal(released.length, 0);

  bg.notified("agent-1", "completed");
  assert.equal(released.length, 1, "the freed slot hands the queued brief back");
  assert.equal(released[0]?.prompt, "brief 3");
  assert.equal(bg.idle, false, "a handed-back brief keeps the task open");

  // The agent starts it: the same run record goes on.
  const queuedId = released[0]?.recorder.id ?? "";
  assert.equal(bg.admit({ ...call(4), description: "job 3, restarted" }), undefined);
  bg.started("tu4", "agent-3");
  assert.equal(readRunFile(queuedId)?.status, "running");
  assert.equal(readRunFile(queuedId)?.title, "job 3, restarted");
  assert.deepEqual(bg.queued, []);
});

test("foreground calls are always admitted and not tracked", () => {
  const { bg, call } = setup();
  bg.admit(call(1));
  bg.admit(call(2));
  assert.equal(bg.admit(call(3, false)), undefined);
  bg.started("tu3", "agent-fg");
  assert.equal(bg.running.length, 2);
});

test("over the daily budget, no background subagent starts", () => {
  const { bg, call } = setup({ overBudget: () => true });
  assert.match(bg.admit(call(1)) ?? "", /daily spend cap/);
  assert.equal(bg.idle, true);
});

/** One response's transcript lines: a partial usage on its first block, the final one on its last. */
function response(id: string, model: string, usage: { input: number; output: number; cacheRead: number; cacheWrite: number }): string {
  const line = (output: number) =>
    JSON.stringify({
      type: "assistant",
      isSidechain: true,
      message: { id, model, usage: { input_tokens: usage.input, output_tokens: output, cache_read_input_tokens: usage.cacheRead, cache_creation_input_tokens: usage.cacheWrite } },
    });
  return `${line(3)}\n${line(usage.output)}\n`;
}

function modelUsage(model: string, costUSD: number, tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }) {
  return {
    [model]: {
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cacheReadInputTokens: tokens.cacheRead,
      cacheCreationInputTokens: tokens.cacheWrite,
      webSearchRequests: 0,
      costUSD,
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
    },
  };
}

test("a subagent's cost comes from its transcript, live and once more when its record closes", () => {
  const { bg, call } = setup();
  bg.admit(call(1));
  bg.started("tu1", "agent-cost");
  const run = bg.running[0];
  assert.ok(run);
  const transcript = path.join(tmp, "transcripts", "agent-agent-cost.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const model = "claude-cost-test";
  fs.writeFileSync(transcript, response("msg_1", model, { input: 2, output: 1000, cacheRead: 0, cacheWrite: 10_000 }));

  bg.progressed(run);
  assert.equal(run.recorder.record.costUsd, 0, "no price for the model before a result reports it");

  // $2 per million input tokens: 2 + 5×1000 + 2×10000 = 25002 input-token equivalents, the writes being 1-hour.
  bg.settleEnded(modelUsage(model, 0.050004, { input: 2, output: 1000, cacheRead: 0, cacheWrite: 10_000 }));
  assert.ok(Math.abs(run.recorder.record.costUsd - 0.050004) < 1e-9, "the result reprices a running subagent");

  fs.appendFileSync(transcript, response("msg_2", model, { input: 2, output: 500, cacheRead: 11_000, cacheWrite: 600 }));
  bg.progressed(run);
  // 2 + 2500 + 1100 + 1200 = 4802 more.
  const live = 0.050004 + 0.009604;
  assert.ok(Math.abs(run.recorder.record.costUsd - live) < 1e-9);
  assert.equal(run.recorder.record.costEstimated, true);

  bg.notified("agent-cost", "completed");
  assert.equal(readRunFile(run.recorder.id)?.status, "running", "still open until the next result");
  const { dispatched, reported } = bg.takeForReply();
  assert.deepEqual(dispatched.map((r) => r.id), [run.recorder.id]);
  assert.deepEqual(reported.map((r) => r.id), [run.recorder.id]);
  assert.deepEqual(bg.takeForReply(), { dispatched: [], reported: [] });

  fs.appendFileSync(transcript, response("msg_3", model, { input: 1, output: 100, cacheRead: 11_600, cacheWrite: 0 }));
  bg.settleEnded({});
  const file = readRunFile(run.recorder.id);
  assert.equal(file?.status, "done");
  // 1 + 500 + 1160 = 1661 more, at the price learned earlier.
  assert.ok(Math.abs((file?.costUsd ?? 0) - (live + 0.003322)) < 1e-9);
  assert.equal(readRunLog().find((r) => r.id === run.recorder.id)?.parentRunId, "k7m2qa");
});

test("stopped and failed notifications keep their status", () => {
  const { bg, call } = setup();
  bg.admit(call(1));
  bg.admit(call(2));
  bg.started("tu1", "a1");
  bg.started("tu2", "a2");
  const [one, two] = bg.running.map((r) => r.recorder.id);
  bg.notified("a1", "stopped");
  bg.notified("a2", "failed");
  bg.settleEnded({});
  assert.equal(readRunFile(one ?? "")?.status, "stopped");
  assert.equal(readRunFile(two ?? "")?.status, "failed");
});

test("agentIdOf finds a running subagent by run id; dropQueued cancels a queued one", () => {
  const { bg, call } = setup();
  bg.admit(call(1));
  bg.admit(call(2));
  bg.admit(call(3));
  bg.started("tu1", "a1");
  const running = bg.running.find((r) => r.agentId === "a1")?.recorder.id ?? "";
  assert.equal(bg.agentIdOf(running), "a1");
  const queued = bg.queued[0]?.recorder.id ?? "";
  assert.equal(bg.dropQueued(queued), true);
  assert.equal(readRunFile(queued)?.status, "stopped");
  assert.equal(bg.dropQueued("zzzz22"), false);
});

test("a handed-back brief the agent does not start is dropped and frees the queue", () => {
  const { bg, released, call } = setup();
  bg.admit(call(1));
  bg.admit(call(2));
  bg.admit(call(3));
  bg.admit(call(4));
  bg.started("tu1", "a1");
  bg.started("tu2", "a2");
  bg.notified("a1", "completed");
  assert.equal(released.length, 1);
  bg.abandonReleased();
  assert.equal(readRunFile(released[0]?.recorder.id ?? "")?.status, "stopped");
  assert.equal(released.length, 2, "the next queued brief comes back");
});

test("endAll ends every live and queued run, keeping the status of ones that already ended", () => {
  const { bg, call } = setup();
  bg.admit(call(1));
  bg.admit(call(2));
  bg.admit(call(3));
  bg.started("tu1", "a1");
  bg.started("tu2", "a2");
  bg.notified("a2", "completed");
  const ids = { live: bg.agentIdOf(bg.running[0]?.recorder.id ?? "") };
  assert.ok(ids.live);
  const lost = bg.endAll("lost", "Alfred 重启，任务中断");
  assert.equal(lost.length, 2, "the running one and the queued one");
  for (const r of lost) assert.equal(readRunFile(r.id)?.status, "lost");
  assert.equal(bg.idle, true);
});

test("any agent type runs in the background, with the model its call asks for, and its slot counts toward the cap", () => {
  const { bg, released } = setup();
  const call = (n: number, extra: { role: string; model?: string }) => ({ toolUseId: `tu${n}`, description: `job ${n}`, prompt: `brief ${n}`, background: true, ...extra });
  assert.equal(bg.admit(call(1, { role: "general-purpose", model: "opus" })), undefined);
  assert.equal(bg.admit(call(2, { role: "general-purpose" })), undefined);
  const [first, second] = bg.running.map((r) => r.recorder.record);
  assert.equal(first?.model, "claude-opus-5-5");
  assert.equal(first?.role, "general-purpose");
  assert.equal(second?.model, undefined, "a built-in type's model is learned from its first message");

  bg.started("tu2", "agent-2", "Explore");
  assert.equal(bg.recorderOf("agent-2")?.record.role, "Explore", "the type task_started reports wins");

  assert.match(bg.admit(call(3, { role: "researcher", model: "haiku" })) ?? "", /queued/, "a third call, nested or not, waits for a slot");
  bg.started("tu1", "agent-1");
  bg.notified("agent-1", "completed");
  assert.equal(released[0]?.role, "researcher");
  assert.equal(released[0]?.model, "haiku", "the handed-back brief keeps the model it asked for");
});
