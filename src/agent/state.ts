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
  /** Spend on `spendDay` (YYYY-MM-DD in the owner's time zone), for the daily cap. */
  spendDay?: string;
  spendDayUsd?: number;
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
