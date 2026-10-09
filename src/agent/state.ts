import path from "node:path";

import { STATE_DIR, readJson, writeJson } from "../store.ts";
import { DEFAULT_MODEL, isModelKey } from "./config.ts";
import type { ModelKey } from "./config.ts";

const AGENT_STATE_FILE = path.join(STATE_DIR, "agent-state.json");

/** A retired session, kept so /resume can switch back to it. */
export interface SessionSnapshot {
  sessionId: string;
  sessionCostUsd: number;
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
  totalCostUsd: number;
  /** When the last task ended or /resume was sent; idle rotation counts from here. */
  lastRunAt?: string;
  /** The session retired last; /resume switches back to it. */
  previousSession?: SessionSnapshot;
}

/** Per-user agent state, persisted so sessions and settings survive restarts. */
export class AgentStateStore {
  private entries: Record<string, AgentUserState> = readJson(AGENT_STATE_FILE) ?? {};

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
    writeJson(AGENT_STATE_FILE, this.entries);
    return next;
  }
}
