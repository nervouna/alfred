import fs from "node:fs";
import path from "node:path";

import { isRulesFileName } from "./agent/rules.ts";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function localDate(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function localTime(d = new Date()): string {
  return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** A moment in the process's time zone, which is the owner's (see src/tasks/schedule.ts), as "2026-10-27 09:01". */
export function localStamp(d: Date): string {
  return `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The first non-empty line of `text`, cut to `max` characters with an ellipsis. */
export function firstLine(text: string, max: number): string {
  const line = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  const chars = Array.from(line);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : line;
}

/** Linux file systems cap a name at 255 bytes; this leaves room for the "_" prefix and uniquePath's "-N". */
const MAX_NAME_BYTES = 240;
/** An extension longer than this is not one worth keeping when a name is cut. */
const MAX_EXT_BYTES = 32;

/** `name` cut to MAX_NAME_BYTES of UTF-8 at a code point, keeping its extension. */
function fitName(name: string): string {
  if (Buffer.byteLength(name) <= MAX_NAME_BYTES) return name;
  const ext = path.extname(name);
  const keep = Buffer.byteLength(ext) <= MAX_EXT_BYTES ? ext : "";
  let budget = MAX_NAME_BYTES - Buffer.byteLength(keep);
  let stem = "";
  for (const ch of name.slice(0, name.length - keep.length)) {
    budget -= Buffer.byteLength(ch);
    if (budget < 0) break;
    stem += ch;
  }
  return stem + keep;
}

/**
 * Strip path components and characters that are unsafe in file names. Hidden
 * files and received ALFRED.md files get a "_" prefix, so a forwarded file
 * cannot become workspace rules.
 */
export function sanitizeFileName(name: string | undefined, fallback: string): string {
  const base = path.basename((name ?? "").replace(/\\/g, "/"));
  const cleaned = fitName(base.replace(/[\x00-\x1f<>:"/\\|?*]/g, "_").trim());
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  return cleaned.startsWith(".") || isRulesFileName(cleaned) ? `_${cleaned}` : cleaned;
}

/** Pick a path in `dir` that does not exist yet. */
export function uniquePath(dir: string, fileName: string): string {
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  let candidate = path.join(dir, fileName);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${stem}-${i}${ext}`);
  return candidate;
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function humanAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s}s`;
  if (s < 7200) return `${Math.round(s / 60)}min`;
  return `${(s / 3600).toFixed(1)}h`;
}
