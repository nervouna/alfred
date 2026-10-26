// What the workbench reads. Everything here is read-only: run records and the
// heartbeat under $STATE_DIR/workbench, transcripts in the agent's config dir,
// and the workspace.

import fs from "node:fs";
import path from "node:path";

import { AGENT_CONFIG_DIR } from "../agent/config.ts";
import { transcriptDirs } from "../agent/memory-scan.ts";
import { TaskListSchema } from "../api/schema.ts";
import type { TaskList } from "../api/schema.ts";
import { describeError } from "../log.ts";
import { LOG_FILE, STATUS_FILE, TASKS_FILE, readRunFile, readRunLog, runFileIds } from "../runs.ts";
import type { Heartbeat, RunFile, RunRecord } from "../runs.ts";
import { readJson } from "../store.ts";

/** A heartbeat older than this means Alfred is down. */
export const HEARTBEAT_STALE_MS = 90_000;

/**
 * Runs newest first. A finished run's record is its line in runs.jsonl; only
 * runs not there yet (live ones) are read from their run files, which hold
 * the steps and can be large.
 */
export function allRuns(): RunRecord[] {
  const byId = new Map<string, RunRecord>();
  for (const r of readRunLog()) byId.set(r.id, r);
  for (const id of runFileIds()) {
    if (byId.has(id)) continue;
    const f = readRunFile(id);
    if (f) byId.set(id, f);
  }
  return [...byId.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function runDetail(id: string): { record: RunRecord; file?: RunFile } | undefined {
  const file = readRunFile(id);
  if (file) return { record: file, file };
  const record = readRunLog().findLast((r) => r.id === id);
  return record ? { record } : undefined;
}

/**
 * The task list the task store keeps in tasks.json, through TaskListSchema. With no such file there are no tasks
 * yet, and the schedules are computed in the workbench's own time zone. A file that cannot be read or does not
 * fit throws, naming the file.
 */
export function readTaskList(file = TASKS_FILE): TaskList {
  let raw: unknown;
  try {
    raw = readJson<unknown>(file);
  } catch (err) {
    throw new Error(`cannot read ${file}: ${describeError(err)}`);
  }
  if (raw === undefined) return { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, tasks: [] };
  const parsed = TaskListSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${file} does not fit a task list: ${parsed.error.message}`);
  return parsed.data;
}

export interface AlfredStatus {
  up: boolean;
  beat?: Heartbeat;
}

export function alfredStatus(now = Date.now()): AlfredStatus {
  let beat: Heartbeat | undefined;
  try {
    beat = readJson<Heartbeat>(STATUS_FILE);
  } catch {
    beat = undefined;
  }
  if (!beat) return { up: false };
  // Only the fields the workbench shows are kept, whatever else the file holds.
  const kept: Heartbeat = {
    pid: Number(beat.pid),
    startedAt: String(beat.startedAt),
    updatedAt: String(beat.updatedAt),
    memory: {
      rssBytes: Number(beat.memory?.rssBytes ?? 0),
      cgroupBytes: beat.memory?.cgroupBytes,
      cgroupMaxBytes: beat.memory?.cgroupMaxBytes,
    },
    stoppedAt: beat.stoppedAt,
  };
  const age = now - Date.parse(kept.updatedAt);
  return { up: !kept.stoppedAt && Math.abs(age) < HEARTBEAT_STALE_MS, beat: kept };
}

/** Local calendar date (YYYY-MM-DD) in the process's time zone. */
export function localDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA");
}

/** A subagent's cost is part of the cost its task reports, so totals leave subagent runs out. */
export function countsForSpend(r: RunRecord): boolean {
  return r.kind !== "subagent";
}

export interface DaySpend {
  day: string;
  costUsd: number;
  runs: number;
  byModel: Record<string, number>;
}

/** Spend per local day, newest first, from finished runs. */
export function spendByDay(runs: RunRecord[]): DaySpend[] {
  const days = new Map<string, DaySpend>();
  for (const r of runs.filter(countsForSpend)) {
    const day = localDay(r.startedAt);
    const d = days.get(day) ?? { day, costUsd: 0, runs: 0, byModel: {} };
    d.costUsd += r.costUsd || 0;
    d.runs++;
    for (const [model, usd] of Object.entries(r.modelCostUsd ?? {})) d.byModel[model] = (d.byModel[model] ?? 0) + usd;
    days.set(day, d);
  }
  return [...days.values()].sort((a, b) => b.day.localeCompare(a.day));
}

export interface SessionInfo {
  id: string;
  file: string;
  bytes: number;
  modifiedAt: number;
}

/** Claude Code transcripts of the workspace's sessions, newest first. */
export function listSessions(workspace: string): SessionInfo[] {
  const sessions: SessionInfo[] = [];
  for (const dir of transcriptDirs(AGENT_CONFIG_DIR, workspace)) {
    for (const name of fs.readdirSync(dir)) {
      if (!/^[0-9a-f-]{36}\.jsonl$/.test(name)) continue;
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      sessions.push({ id: name.slice(0, -6), file, bytes: stat.size, modifiedAt: stat.mtimeMs });
    }
  }
  return sessions.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

export interface TranscriptEntry {
  at?: string;
  role: "user" | "assistant" | "tool";
  /** Set for entries from inside a subagent. */
  sidechain: boolean;
  text: string;
}

const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_TOOL_TEXT = 400;

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function blocksOf(content: unknown): Record<string, unknown>[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content.filter((b) => b && typeof b === "object") as Record<string, unknown>[]) : [];
}

/** The readable part of a transcript: user and assistant text, tool calls and results in short. */
export function readTranscript(file: string): { entries: TranscriptEntry[]; truncated: boolean } {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - MAX_TRANSCRIPT_BYTES);
  const fd = fs.openSync(file, "r");
  let text: string;
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    text = buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
  const lines = text.split("\n");
  if (start > 0) lines.shift(); // Starts mid-line.
  const entries: TranscriptEntry[] = [];
  for (const line of lines) {
    if (!line.trim() || line.length > MAX_LINE_BYTES) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = entry.type;
    if (type !== "user" && type !== "assistant") continue;
    const message = (entry.message ?? {}) as Record<string, unknown>;
    const at = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
    const sidechain = entry.isSidechain === true;
    for (const block of blocksOf(message.content)) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        entries.push({ at, role: type, sidechain, text: block.text });
      } else if (block.type === "tool_use") {
        entries.push({ at, role: "tool", sidechain, text: `→ ${String(block.name)} ${clip(JSON.stringify(block.input ?? {}), MAX_TOOL_TEXT)}` });
      } else if (block.type === "tool_result") {
        const body = blocksOf(block.content)
          .map((b) => (typeof b.text === "string" ? b.text : `[${String(b.type)}]`))
          .join(" ");
        entries.push({ at, role: "tool", sidechain, text: `← ${clip(body.replace(/\s+/g, " "), MAX_TOOL_TEXT)}` });
      }
    }
  }
  return { entries, truncated: start > 0 };
}

/** The last `n` lines of Alfred's log, oldest first. */
export function tailLog(n: number, file = LOG_FILE): string[] {
  const lines: string[] = [];
  for (const f of [file, `${file}.1`]) {
    let text: string;
    try {
      const size = fs.statSync(f).size;
      const want = Math.min(size, 2 * 1024 * 1024);
      const fd = fs.openSync(f, "r");
      try {
        const buf = Buffer.alloc(want);
        fs.readSync(fd, buf, 0, want, size - want);
        text = buf.toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue;
    }
    const got = text.split("\n").filter((l) => l.length);
    if (got.length && text.length >= 2 * 1024 * 1024) got.shift();
    lines.unshift(...got);
    if (lines.length >= n) break;
  }
  return lines.slice(-n);
}
