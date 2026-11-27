import path from "node:path";

import { WORKBENCH_STATE_DIR } from "./runs.ts";
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
