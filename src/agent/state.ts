import path from "node:path";

import { log, mask } from "../log.ts";
import { STATE_DIR, readJson, writeJson } from "../store.ts";
import { DEFAULT_MODEL, isModelKey } from "./config.ts";
import type { ModelKey } from "./config.ts";

const AGENT_STATE_FILE = path.join(STATE_DIR, "agent-state.json");

/** The key of the owner's record in the state file. There is one owner, so the key is fixed. */
export const OWNER = "owner";

/** A run named in a notice to the user. */
export interface RunRef {
  id: string;
  title: string;
}

/** A task run whose report reached the owner, kept until the owner's next message so the chat can follow up on it. */
export interface TaskDelivery {
  taskId: string;
  /** The task's title when it ran. */
  title: string;
  runId: string;
  /** When the reply was posted. */
  at: string;
  /** The first line of the reply. */
  summary: string;
  /** The files the run sent, relative to the workspace. */
  files: string[];
}

/** A revision run that ended and told the owner so, kept until the owner's next message so the chat can follow up on it. */
export interface RevisionDelivery {
  documentId: string;
  /** The document's title when the run ran. */
  title: string;
  /** The document's workspace path when the run ended. */
  path: string;
  runId: string;
  /** When the run's message was posted. */
  at: string;
  outcome: "done" | "stopped" | "failed";
  /** Annotations the run answered, and those that went back to the owner. */
  answered: number;
  returned: number;
  /** The first line of Alfred's final message, or why the run failed; empty for a stopped run. */
  summary: string;
}

/** A retired session, kept so /resume can switch back to it. */
export interface SessionSnapshot {
  sessionId: string;
  sessionCostUsd: number;
  sessionModelCostUsd?: Record<string, number>;
  sessionStartedAt?: string;
}

export interface AgentUserState {
  /** Claude Code session to resume; retired by /new and idle rotation. */
  sessionId?: string;
  /** When the current session started; unknown for sessions created before this field existed. */
  sessionStartedAt?: string;
  model: ModelKey;
  /** Running cost total the SDK reported for the current session. */
  sessionCostUsd: number;
  /** The same running total per model (model id to USD), subagents included. */
  sessionModelCostUsd?: Record<string, number>;
  totalCostUsd: number;
  /** When the last task ended or /resume was sent; idle rotation counts from here. */
  lastRunAt?: string;
  /** The session retired last; /resume switches back to it. */
  previousSession?: SessionSnapshot;
  /** Runs a restart ended while they were live or queued; the user's next message gets a note naming them. */
  lostRuns?: RunRef[];
  /** Task runs delivered since the owner's last message, oldest first; the next message's prompt lists them and clears the list. */
  taskDeliveries?: TaskDelivery[];
  /** Revision runs that told the owner how they ended since the owner's last message, oldest first; the next message's prompt lists them and clears the list. */
  revisionDeliveries?: RevisionDelivery[];
  /** Spend on `spendDay` (YYYY-MM-DD in the owner's time zone), for the daily cap. */
  spendDay?: string;
  spendDayUsd?: number;
  /** USD per input-token equivalent of each model, from the last results' modelUsage (see cost.ts): what a run that ended without its last result is estimated at. */
  unitPrices?: Record<string, number>;
}

/** Per-user agent state, persisted so sessions and settings survive restarts. */
export class AgentStateStore {
  private readonly file: string;
  private entries: Record<string, AgentUserState>;

  constructor(file: string = AGENT_STATE_FILE) {
    this.file = file;
    this.entries = readJson(file) ?? {};
  }

  get(userId: string): AgentUserState {
    const entry = this.entries[userId];
    return {
      sessionCostUsd: 0,
      totalCostUsd: 0,
      ...entry,
      model: entry && isModelKey(entry.model) ? entry.model : DEFAULT_MODEL,
    };
  }

  update(userId: string, patch: Partial<AgentUserState>): AgentUserState {
    const next = { ...this.get(userId), ...patch };
    this.entries[userId] = next;
    writeJson(this.file, this.entries);
    return next;
  }

  /**
   * Moves the owner's record to OWNER when it is kept under another key. Until the app was the only channel,
   * the record was keyed by the owner's user id on the channel they used, which is not known any more: the
   * record used last is theirs. A record already under OWNER is never replaced. The note about results that
   * did not arrive is dropped with the rest of that feature. Returns whether a record moved.
   */
  adoptOwnerRecord(): boolean {
    if (this.entries[OWNER]) return false;
    const [latest] = Object.entries(this.entries).sort(([, a], [, b]) => (b.lastRunAt ?? "").localeCompare(a.lastRunAt ?? ""));
    if (!latest) return false;
    const [key, entry] = latest;
    const { undeliveredRuns: _dropped, ...record } = entry as AgentUserState & { undeliveredRuns?: unknown };
    this.entries[OWNER] = record;
    delete this.entries[key];
    writeJson(this.file, this.entries);
    log.info(`moved the state kept under ${mask(key)} to the owner record`);
    return true;
  }
}
