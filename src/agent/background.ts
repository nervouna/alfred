// Background subagents of one task, nested ones included. A task's query stays
// open while they run; this module decides which Agent calls may start one (a
// concurrency cap and the daily budget), queues the rest and hands them back when
// a slot frees, and keeps each subagent's run record for the workbench, with its
// cost so far.

import type { ModelUsage } from "@anthropic-ai/claude-agent-sdk";

import { TranscriptUsage, unitPrices } from "./cost.ts";
import { MODELS, SUBAGENT_ROLES, isModelKey, isSubagentRole } from "./config.ts";
import type { EventLog } from "../events.ts";
import { RunRecorder } from "../runs.ts";
import type { RunStatus } from "../runs.ts";
import type { AgentAdmission, AgentCall } from "./subagents.ts";

export interface BackgroundRun {
  recorder: RunRecorder;
  /** The agent type: a role, a built-in type or a plugin's. */
  role: string;
  description: string;
  toolUseId: string;
  agentId?: string;
  startedAt: number;
  usage?: TranscriptUsage;
}

export interface QueuedBrief {
  recorder: RunRecorder;
  role: string;
  /** The model the call asked for, if any. */
  model?: string;
  description: string;
  prompt: string;
}

interface Ended {
  run: BackgroundRun;
  status: Exclude<RunStatus, "running" | "queued">;
}

/**
 * Model prices learned from every result in this process, so a subagent on a
 * model its own query has not reported yet is priced from an earlier query's.
 */
const prices: Record<string, number> = {};

/**
 * The model a call's subagent runs on, as far as Alfred knows before it starts:
 * the one the call asks for, else its role's. Other types (general-purpose,
 * plugin agents) say theirs in their first message (see handler.ts).
 */
function expectedModel(call: AgentCall): string | undefined {
  if (call.model) return isModelKey(call.model) ? MODELS[call.model] : call.model;
  return isSubagentRole(call.role) ? MODELS[SUBAGENT_ROLES[call.role].model] : undefined;
}

const NOTIFICATION_STATUS: Record<string, Ended["status"]> = { completed: "done", failed: "failed", stopped: "stopped" };

export class BackgroundRuns implements AgentAdmission {
  private readonly parentRunId: string;
  private readonly max: number;
  private readonly overBudget: () => boolean;
  private readonly release: (brief: QueuedBrief) => void;
  private readonly transcriptOf: (agentId: string) => string | undefined;
  private readonly events?: EventLog;
  /** Admitted Agent calls whose subagent has not started yet, by tool_use id. */
  private readonly launching = new Map<string, BackgroundRun>();
  /** Running subagents, by the SDK's agent (task) id. */
  private readonly live = new Map<string, BackgroundRun>();
  private readonly queue: QueuedBrief[] = [];
  /** A queued brief handed back to the agent, waiting for its Agent call. */
  private released?: QueuedBrief;
  /** Ended subagents whose records wait for the next result, which brings the prices of their models. */
  private ended: Ended[] = [];
  /** Subagents started since the last reply, which names them. */
  private dispatched: RunRecorder[] = [];
  /** Subagents ended since the last reply; a notification turn's reply is about them. */
  private reported: RunRecorder[] = [];

  constructor(opts: {
    parentRunId: string;
    max: number;
    overBudget: () => boolean;
    release: (brief: QueuedBrief) => void;
    /** A subagent's transcript, once its session is known. */
    transcriptOf: (agentId: string) => string | undefined;
    /** Where the subagents' runs publish their events; the shared event log by default. */
    events?: EventLog;
  }) {
    this.parentRunId = opts.parentRunId;
    this.max = opts.max;
    this.overBudget = opts.overBudget;
    this.release = opts.release;
    this.transcriptOf = opts.transcriptOf;
    this.events = opts.events;
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

  private recorder(call: AgentCall, queued: boolean): RunRecorder {
    return new RunRecorder({
      kind: "subagent",
      title: call.description || call.role,
      model: expectedModel(call),
      role: call.role,
      parentRunId: this.parentRunId,
      queued,
      events: this.events,
    });
  }

  admit(call: AgentCall): string | undefined {
    if (!call.background) return undefined;
    if (this.overBudget()) return "The daily spend cap is reached, so no new subagent starts today. Tell the user, and do the work yourself only if it is small.";
    if (this.live.size + this.launching.size >= this.max) {
      const recorder = this.recorder(call, true);
      this.queue.push({ recorder, role: call.role, model: call.model, description: call.description, prompt: call.prompt });
      return `${this.max} background subagents are already running, the most allowed. This one is queued as run ${recorder.id}, and its brief comes back to you when a slot frees. Tell the user it is queued.`;
    }
    const released = this.released;
    this.released = undefined;
    const recorder = released?.recorder ?? this.recorder(call, false);
    if (released) {
      recorder.update({ title: call.description || released.description, role: call.role, model: expectedModel(call) });
      recorder.start();
    }
    this.launching.set(call.toolUseId, { recorder, role: call.role, description: call.description, toolUseId: call.toolUseId, startedAt: Date.now() });
    return undefined;
  }

  /** The SDK started the subagent of an admitted call (task_started), of `agentType` when it says. Calls run in the foreground are not ours. */
  started(toolUseId: string, agentId: string, agentType?: string): void {
    const run = this.launching.get(toolUseId);
    if (!run) return;
    this.launching.delete(toolUseId);
    run.agentId = agentId;
    if (agentType) run.role = agentType;
    run.recorder.update({ agentId, role: run.role });
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
  notified(agentId: string, status: string): void {
    const run = this.live.get(agentId);
    if (!run) return;
    this.live.delete(agentId);
    this.ended.push({ run, status: NOTIFICATION_STATUS[status] ?? "failed" });
    this.reported.push(run.recorder);
    this.releaseNext();
  }

  /** A background subagent sent a message: its cost so far goes on its card. */
  progressed(run: BackgroundRun): void {
    this.price(run);
  }

  /** A result came with the query's modelUsage: learn its prices, reprice the running subagents and close the records of ended ones. */
  settleEnded(modelUsage: Record<string, ModelUsage>): void {
    Object.assign(prices, unitPrices(modelUsage));
    for (const run of this.live.values()) this.price(run);
    for (const { run, status } of this.ended.splice(0)) {
      this.price(run);
      run.recorder.finish(status);
    }
  }

  /** Prices what the subagent's transcript holds so far; the cost stays as it is while a model it used has no price yet. */
  private price(run: BackgroundRun): void {
    const file = run.agentId && this.transcriptOf(run.agentId);
    if (!file) return;
    run.usage ??= new TranscriptUsage(file);
    run.usage.read();
    const usd = run.usage.cost(prices);
    if (usd !== undefined && usd !== run.recorder.record.costUsd) run.recorder.update({ costUsd: usd, costEstimated: true });
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
    for (const r of [...this.ended.map((e) => e.run), ...this.live.values()]) this.price(r);
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
