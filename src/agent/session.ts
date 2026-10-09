// Session lifecycle: idle rotation, /resume and spend accounting. The state
// transitions are pure functions of the stored state so they can be unit-tested;
// the handler applies the patches they return.

import type { AgentUserState } from "./state.ts";

const HOUR_MS = 3_600_000;

/** Why a session stopped being the user's active session. */
export type RetireReason =
  /** The next task came after the idle threshold. */
  | "idle"
  /** The user sent /new. */
  | "new"
  /** The user sent /resume, which swapped it out for the previous session. */
  | "resume"
  /** Claude Code could not resume it; it is dropped, not kept for /resume. */
  | "resume-failed";

/** When an idle session will rotate (epoch ms), or undefined if it will not. */
export function rotationDueAt(state: AgentUserState, idleHours: number): number | undefined {
  if (!state.sessionId || !state.lastRunAt || !(idleHours > 0)) return undefined;
  const last = Date.parse(state.lastRunAt);
  return Number.isNaN(last) ? undefined : last + idleHours * HOUR_MS;
}

/** True when a task starting at `now` should open a new session instead of resuming the current one. */
export function shouldRotate(state: AgentUserState, now: number, idleHours: number): boolean {
  const due = rotationDueAt(state, idleHours);
  return due !== undefined && now > due;
}

/** Fields that clear the active session; the next task starts a new one. */
export const NO_SESSION = { sessionId: undefined, sessionCostUsd: 0, sessionStartedAt: undefined } as const;

/** Patch that retires the active session and keeps it as the one /resume returns to. */
export function retire(state: AgentUserState): Partial<AgentUserState> {
  if (!state.sessionId) return {};
  const { sessionId, sessionCostUsd, sessionStartedAt } = state;
  return { ...NO_SESSION, previousSession: { sessionId, sessionCostUsd, sessionStartedAt } };
}

/**
 * Patch that swaps the active and previous sessions, so a second /resume undoes
 * the first; undefined when there is nothing to resume. It also restarts the idle
 * clock, otherwise the next task would rotate the resumed session straight away.
 */
export function resumePrevious(state: AgentUserState, now: number): Partial<AgentUserState> | undefined {
  const prev = state.previousSession;
  if (!prev) return undefined;
  const { sessionId, sessionCostUsd, sessionStartedAt } = state;
  return {
    sessionId: prev.sessionId,
    sessionCostUsd: prev.sessionCostUsd,
    sessionStartedAt: prev.sessionStartedAt,
    previousSession: sessionId ? { sessionId, sessionCostUsd, sessionStartedAt } : undefined,
    lastRunAt: new Date(now).toISOString(),
  };
}

/**
 * Spend after a result that reported `reportedUsd`. The SDK reports a running
 * total for the session: it grows across the turns of a streaming query, a resumed
 * session continues from the total its transcript saved, and it starts again from
 * zero when the transcript saved none.
 */
export function accountRun(
  state: AgentUserState,
  reportedUsd: number,
): { sessionCostUsd: number; totalCostUsd: number; deltaUsd: number } {
  const deltaUsd = reportedUsd >= state.sessionCostUsd ? reportedUsd - state.sessionCostUsd : reportedUsd;
  return { sessionCostUsd: reportedUsd, totalCostUsd: state.totalCostUsd + deltaUsd, deltaUsd };
}
