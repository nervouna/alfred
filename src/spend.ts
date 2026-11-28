import fs from "node:fs";
import path from "node:path";

import { localDate } from "./files.ts";
import { describeError, log } from "./log.ts";
import { WORKBENCH_STATE_DIR } from "./runs.ts";
import type { RunRecord } from "./runs.ts";
import { readJson, writeJson } from "./store.ts";

/** The day's and the month's spend as the caps count them, for the workbench to read; only Alfred writes it. */
export const SPEND_MIRROR_FILE = path.join(WORKBENCH_STATE_DIR, "spend.json");

/** What the file holds: the counters with the local day (YYYY-MM-DD) and month (YYYY-MM) they count. */
export interface SpendMirror {
  day: string;
  dayUsd: number;
  month: string;
  monthUsd: number;
}

export function writeSpendMirror(mirror: SpendMirror, file = SPEND_MIRROR_FILE): void {
  writeJson(file, mirror);
}

function isAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * The spend on `day` and in its month, from the mirror: a counter of another day or month is 0, as the caps read it.
 * A missing file is no spend yet; one that cannot be read or does not fit throws, naming the file.
 */
export function readSpend(day: string, file = SPEND_MIRROR_FILE): { spentTodayUsd: number; spentMonthUsd: number } {
  let raw: unknown;
  try {
    raw = readJson<unknown>(file);
  } catch (err) {
    throw new Error(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (raw === undefined) return { spentTodayUsd: 0, spentMonthUsd: 0 };
  const m = raw as Partial<SpendMirror> | null;
  if (typeof m !== "object" || m === null || typeof m.day !== "string" || typeof m.month !== "string" || !isAmount(m.dayUsd) || !isAmount(m.monthUsd)) {
    throw new Error(`${file} does not fit the spend mirror`);
  }
  return { spentTodayUsd: m.day === day ? m.dayUsd : 0, spentMonthUsd: m.month === day.slice(0, 7) ? m.monthUsd : 0 };
}

/** What Alfred spends outside Anthropic, one line per call of a priced external tool; the caps do not count it. */
export const EXTERNAL_SPEND_LOG = path.join(WORKBENCH_STATE_DIR, "external-spend.jsonl");

/** One line of external-spend.jsonl. `usd` is the owner's estimate (the tool's `priceUsd`), never a provider's bill. */
export interface ExternalSpend {
  at: string;
  /** The run the call belongs to; a subagent's call carries the run that started it. */
  runId: string;
  server: string;
  tool: string;
  units: number;
  usd: number;
  estimated: true;
  /** The agent type of the subagent that made the call; absent for the main thread and in lines from before this field. */
  role?: string;
}

/** Appends one entry. A failure is logged and never fails the tool call it records. */
export function appendExternalSpend(entry: ExternalSpend, file = EXTERNAL_SPEND_LOG): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch (err) {
    log.warn(`appending to the external spend log failed: ${describeError(err)}`);
  }
}

function isEntry(v: unknown): v is ExternalSpend {
  const e = v as Partial<ExternalSpend> | null;
  return (
    typeof e === "object" && e !== null && typeof e.at === "string" && typeof e.runId === "string" && typeof e.server === "string" &&
    typeof e.tool === "string" && isAmount(e.units) && isAmount(e.usd) && (e.role === undefined || typeof e.role === "string") &&
    !Number.isNaN(Date.parse(e.at))
  );
}

/** Every entry, oldest first. A missing file is no spend; a line that is cut short or does not fit is skipped. */
export function readExternalSpend(file = EXTERNAL_SPEND_LOG): ExternalSpend[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const entries: ExternalSpend[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isEntry(parsed)) entries.push(parsed);
    } catch {
      // A line cut short by a crash; the rest of the log is still good.
    }
  }
  return entries;
}

/** The external spend of a local month (YYYY-MM). */
export function externalSpendOfMonth(month: string, file = EXTERNAL_SPEND_LOG): number {
  return readExternalSpend(file).reduce((sum, e) => (localDate(new Date(e.at)).startsWith(month) ? sum + e.usd : sum), 0);
}

// Calls per run, for `maxPerRun`: a call is counted when it is let through (so calls in flight count) and given back if it
// fails. A subagent's calls count in the run that started it. Kept in memory: a run does not outlive the process.
const MAX_RUNS_KEPT = 500;
const callCounts = new Map<string, Map<string, number>>();

/** Lets a call of `key` (server and tool) through when the run has made fewer than `max` of them, and counts it. */
export function reserveCall(runId: string, key: string, max: number): boolean {
  let run = callCounts.get(runId);
  if (!run) {
    run = new Map();
    callCounts.set(runId, run);
    if (callCounts.size > MAX_RUNS_KEPT) callCounts.delete(callCounts.keys().next().value as string);
  }
  const n = run.get(key) ?? 0;
  if (n >= max) return false;
  run.set(key, n + 1);
  return true;
}

/** Gives back a call that failed. */
export function releaseCall(runId: string, key: string): void {
  const run = callCounts.get(runId);
  const n = run?.get(key) ?? 0;
  if (n > 0) run?.set(key, n - 1);
}

export type SpendGroup = "day" | "kind" | "model" | "role" | "task" | "server";
export const SPEND_GROUPS = ["day", "kind", "model", "role", "task", "server"] as const satisfies readonly SpendGroup[];

export interface SpendRow {
  key: string;
  usd: number;
  /** Run records, or calls of external tools. */
  count: number;
}

export interface SpendReport {
  /** The period, local dates, both ends included. */
  from: string;
  to: string;
  groupBy: SpendGroup;
  /** What the caps count: Anthropic usage as the run records hold it. */
  runRecords: { totalUsd: number; runs: number; rows: SpendRow[] };
  /** The owner's estimates for external tools: not in the caps, not in the run records. */
  external: { totalUsd: number; calls: number; rows: SpendRow[] };
}

const CHAT = "chat";
const MAIN = "(main thread)";
const NONE = "(none)";

function add(rows: Map<string, SpendRow>, key: string, usd: number): void {
  const row = rows.get(key) ?? { key, usd: 0, count: 0 };
  row.usd += usd;
  row.count += 1;
  rows.set(key, row);
}

function sorted(rows: Map<string, SpendRow>, byKey: boolean): SpendRow[] {
  return [...rows.values()].sort((a, b) => (byKey ? a.key.localeCompare(b.key) : b.usd - a.usd || a.key.localeCompare(b.key)));
}

/** A chat run is kind `task` with no `taskId`; the report calls it chat and keeps task for the scheduled tasks' runs. */
function kindOf(r: RunRecord): string {
  return r.kind === "task" && !r.taskId ? CHAT : r.kind;
}

/**
 * The spend of the days `from` to `to` (local, inclusive), by `groupBy`, from the run records and the external log, as two
 * separate figures. A background subagent's cost is inside its parent run's (the SDK's result reports both), so the run
 * records' total is that of the runs that are not subagents. Grouped by role, a subagent's own share is listed under its
 * role and taken off its parent's, which keeps the rest under "(main thread)". Grouped by server, the run records have no
 * rows: servers are an external notion.
 */
export function querySpend(query: { from: string; to: string; groupBy: SpendGroup }, runs: readonly RunRecord[], external: readonly ExternalSpend[]): SpendReport {
  const { from, to, groupBy } = query;
  const inPeriod = (iso: string) => {
    const day = localDate(new Date(iso));
    return day >= from && day <= to;
  };
  const records = runs.filter((r) => r.kind !== "subagent" && inPeriod(r.startedAt));
  const byId = new Map(runs.map((r) => [r.id, r]));

  const rows = new Map<string, SpendRow>();
  let totalUsd = 0;
  for (const r of records) {
    totalUsd += r.costUsd;
    switch (groupBy) {
      case "day":
        add(rows, localDate(new Date(r.startedAt)), r.costUsd);
        break;
      case "kind":
        add(rows, kindOf(r), r.costUsd);
        break;
      case "task":
        add(rows, r.taskId ?? NONE, r.costUsd);
        break;
      case "model": {
        const models: [string, number][] = r.modelCostUsd && Object.keys(r.modelCostUsd).length ? Object.entries(r.modelCostUsd) : [[r.model ?? "(unknown)", r.costUsd]];
        for (const [model, usd] of models) add(rows, model, usd);
        break;
      }
      case "role": {
        const subagents = runs.filter((s) => s.kind === "subagent" && s.parentRunId === r.id);
        add(rows, MAIN, Math.max(0, r.costUsd - subagents.reduce((sum, s) => sum + s.costUsd, 0)));
        for (const s of subagents) add(rows, s.role ?? "(unknown role)", s.costUsd);
        break;
      }
      case "server":
        break;
    }
  }

  const calls = external.filter((e) => inPeriod(e.at));
  const outside = new Map<string, SpendRow>();
  let externalUsd = 0;
  for (const e of calls) {
    externalUsd += e.usd;
    const run = byId.get(e.runId);
    switch (groupBy) {
      case "day":
        add(outside, localDate(new Date(e.at)), e.usd);
        break;
      case "server":
        add(outside, e.server, e.usd);
        break;
      case "kind":
        add(outside, run ? kindOf(run) : "(unknown run)", e.usd);
        break;
      case "task":
        add(outside, run ? (run.taskId ?? NONE) : "(unknown run)", e.usd);
        break;
      case "role":
        add(outside, e.role ?? MAIN, e.usd);
        break;
      case "model":
        add(outside, "(external tools have no model)", e.usd);
        break;
    }
  }

  return {
    from,
    to,
    groupBy,
    runRecords: { totalUsd, runs: records.length, rows: sorted(rows, groupBy === "day") },
    external: { totalUsd: externalUsd, calls: calls.length, rows: sorted(outside, groupBy === "day") },
  };
}

const money = (n: number): string => `$${n.toFixed(n < 1 ? 3 : 2)}`;

/** The report as the agent reads it: the two figures apart, each said to be what it is. */
export function formatSpendReport(report: SpendReport): string {
  const period = report.from === report.to ? report.from : `${report.from} to ${report.to}`;
  const section = (title: string, total: string, rows: SpendRow[], unit: string): string[] => [
    `${title}: ${total}`,
    ...rows.map((r) => `  ${r.key}: ${money(r.usd)} (${r.count} ${unit})`),
  ];
  return [
    `Spend ${period}, grouped by ${report.groupBy}. The two figures are separate: do not add them without saying so.`,
    "",
    ...section(
      "Run records (Anthropic usage, what the daily and monthly caps count; subagents are inside their parent run)",
      `${money(report.runRecords.totalUsd)} over ${report.runRecords.runs} runs`,
      report.runRecords.rows,
      "runs",
    ),
    "",
    ...section(
      "External tools (the owner's price estimates per call, not in the caps)",
      `${money(report.external.totalUsd)} over ${report.external.calls} calls`,
      report.external.rows,
      "calls",
    ),
  ].join("\n");
}

function isDate(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return false;
  return localDate(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) === text;
}

/**
 * The days a question about spend covers: `from` and `to` when both are given; else the month of `date` (or this month) when
 * `period` is "month"; else the day `date`, or today. A string is returned for a request that does not fit.
 */
export function spendPeriod(input: { period?: "day" | "month"; date?: string; from?: string; to?: string }, now = new Date()): { from: string; to: string } | string {
  const { period, date, from, to } = input;
  if (from !== undefined || to !== undefined) {
    if (from === undefined || to === undefined) return "Give both from and to (YYYY-MM-DD), or neither.";
    if (!isDate(from) || !isDate(to)) return "from and to must be dates as YYYY-MM-DD.";
    if (from > to) return "from is after to.";
    return { from, to };
  }
  if (period === "month") {
    const month = date ?? localDate(now).slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month) || !isDate(`${month}-01`)) return "For a month, date must be YYYY-MM.";
    const last = new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0);
    return { from: `${month}-01`, to: localDate(last) };
  }
  const day = date ?? localDate(now);
  if (!isDate(day)) return "For a day, date must be YYYY-MM-DD.";
  return { from: day, to: day };
}
