// Background subagents of one task. A task's query stays open while they run;
// this module decides which Agent calls may start one (a concurrency cap and the
// daily budget), queues the rest and hands them back when a slot frees, and keeps
// each subagent's run record for the workbench.

import { MODELS, SUBAGENT_ROLES } from "./config.ts";
import type { SubagentRoleName } from "./config.ts";
import { RunRecorder } from "../runs.ts";
import type { RunStatus } from "../runs.ts";
import type { AgentAdmission, AgentCall } from "./subagents.ts";

export interface BackgroundRun {
  recorder: RunRecorder;
  role: SubagentRoleName;
  description: string;
  toolUseId: string;
  agentId?: string;
  startedAt: number;
}

export interface QueuedBrief {
  recorder: RunRecorder;
  role: SubagentRoleName;
  description: string;
  prompt: string;
}

interface Ended {
  run: BackgroundRun;
  status: Exclude<RunStatus, "running" | "queued">;
  tokens?: number;
}

/** USD per token of a model so far in this query, from the SDK's modelUsage. */
export type TokenRates = Record<string, number>;

/** Per-token cost of each model, from a result's modelUsage: total cost over all tokens it counted. */
export function tokenRates(modelUsage: Record<string, { costUSD: number; inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>): TokenRates {
  const rates: TokenRates = {};
  for (const [model, u] of Object.entries(modelUsage)) {
    const tokens = u.inputTokens + u.outputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens;
    if (tokens > 0) rates[model] = u.costUSD / tokens;
  }
  return rates;
}

const NOTIFICATION_STATUS: Record<string, Ended["status"]> = { completed: "done", failed: "failed", stopped: "stopped" };

export class BackgroundRuns implements AgentAdmission {
  private readonly parentRunId: string;
  private readonly max: number;
  private readonly overBudget: () => boolean;
  private readonly release: (brief: QueuedBrief) => void;
  /** Admitted Agent calls whose subagent has not started yet, by tool_use id. */
  private readonly launching = new Map<string, BackgroundRun>();
  /** Running subagents, by the SDK's agent (task) id. */
  private readonly live = new Map<string, BackgroundRun>();
  private readonly queue: QueuedBrief[] = [];
  /** A queued brief handed back to the agent, waiting for its Agent call. */
  private released?: QueuedBrief;
  /** Ended subagents whose records wait for the next result, which brings the cost to estimate theirs. */
  private ended: Ended[] = [];
  /** Subagents started since the last reply, which names them. */
  private dispatched: RunRecorder[] = [];
  /** Subagents ended since the last reply; a notification turn's reply is about them. */
  private reported: RunRecorder[] = [];

  constructor(opts: { parentRunId: string; max: number; overBudget: () => boolean; release: (brief: QueuedBrief) => void }) {
    this.parentRunId = opts.parentRunId;
    this.max = opts.max;
    this.overBudget = opts.overBudget;
    this.release = opts.release;
  }

  /** Nothing running, starting, queued or handed back: the task's query may end. */
  get idle(): boolean {
    return !this.live.size && !this.launching.size && !this.queue.length && !this.released;
  }

  get running(): BackgroundRun[] {
    return [...this.launching.values(), ...this.live.values()];
  }

  get queued(): QueuedBrief[] {
    return this.released ? [this.released, ...this.queue] : [...this.queue];
  }

  private recorder(role: SubagentRoleName, description: string, queued: boolean): RunRecorder {
    return new RunRecorder({
      kind: "subagent",
      title: description || role,
      model: MODELS[SUBAGENT_ROLES[role].model],
      role,
      parentRunId: this.parentRunId,
      queued,
    });
  }

  admit(call: AgentCall): string | undefined {
    if (!call.background) return undefined;
    if (this.overBudget()) return "The daily spend cap is reached, so no new subagent starts today. Tell the user, and do the work yourself only if it is small.";
    if (this.live.size + this.launching.size >= this.max) {
      const recorder = this.recorder(call.role, call.description, true);
      this.queue.push({ recorder, role: call.role, description: call.description, prompt: call.prompt });
      return `${this.max} background subagents are already running, the most allowed. This one is queued as run ${recorder.id}, and its brief comes back to you when a slot frees. Tell the user it is queued.`;
    }
    const released = this.released;
    this.released = undefined;
    const recorder = released?.recorder ?? this.recorder(call.role, call.description, false);
    if (released) {
      recorder.update({ title: call.description || released.description });
      recorder.start();
    }
    this.launching.set(call.toolUseId, { recorder, role: call.role, description: call.description, toolUseId: call.toolUseId, startedAt: Date.now() });
    return undefined;
  }

  /** The SDK started the subagent of an admitted call (task_started). Calls run in the foreground are not ours. */
  started(toolUseId: string, agentId: string): void {
    const run = this.launching.get(toolUseId);
    if (!run) return;
    this.launching.delete(toolUseId);
    run.agentId = agentId;
    run.recorder.update({ agentId });
    this.live.set(agentId, run);
    this.dispatched.push(run.recorder);
  }

  /** An admitted Agent call failed before its subagent started. */
  failedToStart(toolUseId: string, error: string): void {
    const run = this.launching.get(toolUseId);
    if (!run) return;
    this.launching.delete(toolUseId);
    run.recorder.finish("failed", error);
    this.releaseNext();
  }

  /** The background run whose Agent call was `toolUseId`, for the steps its subagent takes. */
  byToolUse(toolUseId: string): BackgroundRun | undefined {
    for (const run of this.live.values()) if (run.toolUseId === toolUseId) return run;
    return this.launching.get(toolUseId);
  }

  /** The run id of the subagent an admitted Agent call started, by the call's tool_use id. */
  runIdFor(toolUseId: string): string | undefined {
    return this.byToolUse(toolUseId)?.recorder.id;
  }

  /** The run record of a running subagent by its SDK agent id, for the files it writes. */
  recorderOf(agentId: string): RunRecorder | undefined {
    return this.live.get(agentId)?.recorder;
  }

  /** The SDK agent id of a running subagent by its run id, for stopping it. */
  agentIdOf(runId: string): string | undefined {
    for (const run of this.live.values()) if (run.recorder.id === runId) return run.agentId;
    return undefined;
  }

  /** A subagent ended (task_notification). Its slot frees at once; its record closes at the next result. */
  notified(agentId: string, status: string, tokens?: number): void {
    const run = this.live.get(agentId);
    if (!run) return;
    this.live.delete(agentId);
    this.ended.push({ run, status: NOTIFICATION_STATUS[status] ?? "failed", tokens });
    this.reported.push(run.recorder);
    this.releaseNext();
  }

  /** Close the records of ended subagents, with a cost estimated from their tokens and this query's rates. */
  settleEnded(rates: TokenRates): void {
    for (const { run, status, tokens } of this.ended.splice(0)) {
      const rate = rates[run.recorder.record.model ?? ""];
      if (tokens !== undefined && rate !== undefined) run.recorder.update({ costUsd: tokens * rate, costEstimated: true });
      run.recorder.finish(status);
    }
  }

  /** Drop a queued brief (by run id) before it starts. */
  dropQueued(runId: string): boolean {
    const i = this.queue.findIndex((b) => b.recorder.id === runId);
    if (i >= 0) {
      const [brief] = this.queue.splice(i, 1);
      brief?.recorder.finish("stopped", "removed from the queue");
      return true;
    }
    if (this.released?.recorder.id === runId) {
      this.released.recorder.finish("stopped", "removed from the queue");
      this.released = undefined;
      this.releaseNext();
      return true;
    }
    return false;
  }

  /** The handed-back brief was answered without an Agent call: the agent chose not to start it. */
  abandonReleased(): void {
    if (!this.released) return;
    this.released.recorder.finish("stopped", "not started when its slot freed");
    this.released = undefined;
    this.releaseNext();
  }

  /** Runs to name in the next reply: those started since the last one, and those it reports on. Clears both lists. */
  takeForReply(): { dispatched: RunRecorder[]; reported: RunRecorder[] } {
    const out = { dispatched: this.dispatched, reported: this.reported };
    this.dispatched = [];
    this.reported = [];
    return out;
  }

  /** The query ended: every run not finished yet ends with `status`. Returns their records. */
  endAll(status: "stopped" | "lost", error?: string): RunRecorder[] {
    const all = [
      ...this.ended.map((e) => e.run.recorder),
      ...[...this.launching.values()].map((r) => r.recorder),
      ...[...this.live.values()].map((r) => r.recorder),
      ...this.queued.map((b) => b.recorder),
    ];
    // Ended ones keep the status their notification gave.
    for (const { run, status: own } of this.ended.splice(0)) run.recorder.finish(own);
    this.launching.clear();
    this.live.clear();
    this.queue.length = 0;
    this.released = undefined;
    for (const r of all) r.finish(status, error);
    return all.filter((r) => r.record.status === status);
  }

  private releaseNext(): void {
    if (this.released || !this.queue.length || this.live.size + this.launching.size >= this.max) return;
    const brief = this.queue.shift();
    if (!brief) return;
    this.released = brief;
    this.release(brief);
  }
}
