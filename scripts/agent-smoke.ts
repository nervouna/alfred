// Runs one prompt through the production agent options without WeChat.
// usage: node scripts/agent-smoke.ts [--model sonnet|opus|haiku] [--resume <session>]
//          [--steer-after <seconds> <follow-up>] [--stop-after <seconds>] [--no-subagents] [--skills] <prompt>
// The prompt goes through the same streaming input as in production; --steer-after
// pushes a follow-up into it mid-run, the way a WeChat message sent during a task does.
// --stop-after aborts the run the way /stop does. --no-subagents drops the Agent tool
// and the roles, for comparing a run against one that delegates. --skills prints the
// skills the session lists, from getContextUsage(). Lines from inside a subagent are
// marked with its Agent call's id. The first request's input tokens are printed, to
// compare the prompt prefix across changes.
// The alfred tools are wired to a stub, so send_file fails instead of messaging anyone.
// Like the bot, it seeds the workspace, records the run for the workbench under
// $ALFRED_STATE_DIR/workbench, and prints the ALFRED.md change notice after the run.

import { execFileSync } from "node:child_process";

import { query } from "@anthropic-ai/claude-agent-sdk";

import { agentOptions, prepareWorkspace, runTitle } from "../src/agent/handler.ts";
import { DEFAULT_MODEL, MODELS, WORKBENCH_ON, isModelKey, runIdNote } from "../src/agent/config.ts";
import { TaskInput, answeredBy } from "../src/agent/input.ts";
import { rulesChangeNotice, snapshotRules } from "../src/agent/rules.ts";
import { SubagentTracker } from "../src/agent/subagents.ts";
import { RunRecorder, stepDetail } from "../src/runs.ts";
import type { Outbound } from "../src/channels.ts";
import { WORKSPACE_DIR } from "../src/store.ts";

const USAGE =
  "usage: node scripts/agent-smoke.ts [--model m] [--resume id] [--steer-after seconds text] [--stop-after seconds] [--no-subagents] [--skills] <prompt>";

const args = process.argv.slice(2);
let model = DEFAULT_MODEL;
let resume: string | undefined;
let steer: { afterMs: number; text: string } | undefined;
let stopAfterMs: number | undefined;
let subagents = true;
let listSkills = false;
const words: string[] = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i] ?? "";
  if (arg === "--model" && isModelKey(args[i + 1] ?? "")) model = args[++i] as typeof model;
  else if (arg === "--resume") resume = args[++i];
  else if (arg === "--steer-after") {
    const seconds = Number(args[++i]);
    const text = args[++i];
    if (!(seconds >= 0) || !text) throw new Error(USAGE);
    steer = { afterMs: seconds * 1000, text };
  } else if (arg === "--stop-after") {
    const seconds = Number(args[++i]);
    if (!(seconds >= 0)) throw new Error(USAGE);
    stopAfterMs = seconds * 1000;
  } else if (arg === "--no-subagents") subagents = false;
  else if (arg === "--skills") listSkills = true;
  else words.push(arg);
}
const prompt = words.join(" ");
if (!prompt) throw new Error(USAGE);

const unavailable = () => Promise.reject(new Error("WeChat is not available in the smoke test"));
const out: Outbound = { channel: "wechat", text: unavailable, file: unavailable, typing: unavailable };

prepareWorkspace();
const rulesBefore = snapshotRules(WORKSPACE_DIR);
const run = new RunRecorder({ kind: "task", title: runTitle(prompt), model: MODELS[model] });
console.log(`[run] ${run.id}`);
const startedAt = Date.now();
const elapsed = () => `+${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
const input = new TaskInput(WORKBENCH_ON ? `${runIdNote(run.id)}\n\n${prompt}` : prompt);
const steerTimer = steer && setTimeout(() => {
  if (input.push(steer.text)) console.log(`[steer] ${elapsed()} pushed: ${steer.text}`);
  else console.log(`[steer] ${elapsed()} not pushed: the task already finished`);
}, steer.afterMs);
const tracker = new SubagentTracker();
const abort = new AbortController();
const stopTimer = stopAfterMs !== undefined && setTimeout(() => {
  console.log(`[stop] ${elapsed()} aborting with ${tracker.running.length} subagent(s) running`);
  input.close();
  abort.abort();
}, stopAfterMs);

let results = 0;
let firstRequest = true;
let modelUsage: Record<string, { costUSD: number }> = {};
const options = agentOptions({ out, model, resume, abortController: abort, subagents, run });
const q = query({ prompt: input, options });
try {
  for await (const m of q) {
    tracker.observe(m);
    if (m.type === "system" && m.subtype === "init") {
      if (results === 0) console.log(`[init] ${elapsed()} session=${m.session_id} model=${m.model} tools=${m.tools.join(",")}`);
      if (results === 0 && listSkills) {
        const skills = (await q.getContextUsage()).skills;
        console.log(`[skills] ${skills?.skillFrontmatter.map((s) => `${s.name} (${s.source}, ${s.tokens} tokens)`).join(", ") || "none"}`);
      }
    } else if (m.type === "system" && m.subtype.startsWith("task_")) {
      console.log(`[${m.subtype}] ${elapsed()} ${JSON.stringify(m).slice(0, 200)}`);
      console.log(`[subagents] ${elapsed()} running=${tracker.running.map((r) => `${r.role}:${r.description}`).join(", ") || "none"}`);
    } else if (m.type === "assistant") {
      if (firstRequest && !m.parent_tool_use_id) {
        firstRequest = false;
        const u = m.message.usage;
        const total = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        console.log(`[first-request] input=${total} (uncached ${u.input_tokens}, cache write ${u.cache_creation_input_tokens ?? 0}, cache read ${u.cache_read_input_tokens ?? 0})`);
      }
      const where = m.parent_tool_use_id ? `[sub ${m.parent_tool_use_id.slice(-6)}] ` : "";
      const agent = m.parent_tool_use_id ? tracker.roleOf(m.parent_tool_use_id) : undefined;
      for (const block of m.message.content) {
        if (block.type !== "tool_use") continue;
        console.log(`[tool] ${elapsed()} ${where}${block.name} ${JSON.stringify(block.input).slice(0, 160)}`);
        run.step(block.name, stepDetail(block.name, (block.input ?? {}) as Record<string, unknown>, WORKSPACE_DIR), agent);
      }
    } else if (m.type === "user" && !m.parent_tool_use_id && Array.isArray(m.message.content)) {
      for (const block of m.message.content) {
        if (block.type === "tool_result") {
          const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
          console.log(`[tool-result] ${elapsed()} ${block.tool_use_id.slice(-6)}${block.is_error ? " ERROR" : ""} ${text.slice(0, 200)}`);
        }
      }
      console.log(`[subagents] ${elapsed()} running=${tracker.running.map((r) => `${r.role}:${r.description}`).join(", ") || "none"}`);
    } else if (m.type === "result") {
      modelUsage = m.modelUsage ?? {};
      run.update({
        sessionId: m.session_id,
        costUsd: m.total_cost_usd,
        modelCostUsd: Object.fromEntries(Object.entries(modelUsage).map(([k, u]) => [k, u.costUSD])),
      });
      results++;
      const answered = answeredBy(m).length;
      input.settle(answeredBy(m));
      console.log(
        `[result] ${elapsed()} subtype=${m.subtype} turns=${m.num_turns} cost=$${m.total_cost_usd.toFixed(4)} ` +
          `answered=${answered} pending=${input.pending} denials=${m.permission_denials.length}`,
      );
      if (m.subtype === "success") console.log(m.result);
      else console.log(m.errors.join("\n"));
    }
  }
} catch (err) {
  // After an error result the CLI exits non-zero once its input closes; the handler treats that as done too.
  if (abort.signal.aborted) console.log(`[stop] ${elapsed()} query ended: ${err instanceof Error ? err.message : String(err)}`);
  else if (!(results > 0 && input.pending === 0)) throw err;
} finally {
  clearTimeout(steerTimer);
  if (stopTimer) clearTimeout(stopTimer);
  input.close();
}
run.finish(abort.signal.aborted ? "stopped" : results > 0 ? "done" : "failed");
for (const [m, u] of Object.entries(modelUsage).sort((a, b) => b[1].costUSD - a[1].costUSD)) {
  console.log(`[model] ${m} $${u.costUSD.toFixed(4)}`);
}
if (tracker.running.length) console.log(`[subagents] still marked running at the end: ${tracker.running.map((r) => r.role).join(", ")}`);
if (abort.signal.aborted) {
  // /stop must take the subagents down with the Claude Code process.
  let left = "";
  try {
    left = execFileSync("pgrep", ["-fl", "claude-agent-sdk"], { encoding: "utf8" }).trim();
  } catch {
    // pgrep exits 1 when nothing matches.
  }
  console.log(`[stop] ${elapsed()} Claude Code processes left: ${left || "none"}`);
}
const notice = rulesChangeNotice(rulesBefore, snapshotRules(WORKSPACE_DIR));
if (notice) console.log(`[notice] ${notice.replace(/\n/g, " | ")}`);
