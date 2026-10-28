// Emptying .trash/. Deleting is a move into .trash/, and nothing else empties it, so the sweep removes a file there once
// it has seen the file for TRASH_RETENTION_DAYS. The clock is a stamp per file, not its mtime: a rename keeps the mtime,
// so a file trashed after a long life would go the day it was trashed. The stamps are in workbench/trash.json, which
// only this sweep writes, and they live outside the workspace, so the agent cannot write them.

import fs from "node:fs";
import path from "node:path";

import { describeError, log } from "../log.ts";
import { WORKBENCH_STATE_DIR } from "../runs.ts";
import { WORKSPACE_DIR, readJson, writeJson } from "../store.ts";
import { TRASH_DIR } from "./trash.ts";

/** A file under .trash/ is removed once the sweep has seen it there this many days. */
export const TRASH_RETENTION_DAYS = 30;
export const TRASH_STATE_FILE = path.join(WORKBENCH_STATE_DIR, "trash.json");
const DAY_MS = 86_400_000;

export interface PruneTrashOptions {
  /** The time of the sweep, in ms; the clock by default. */
  now?: number;
  /** The workspace whose .trash/ is swept; ALFRED_WORKSPACE by default. */
  workspace?: string;
  /** The stamps file; workbench/trash.json under the state directory by default. */
  file?: string;
  /** Called once with the workspace paths (`.trash/…`) of the files removed, when there are any. Its errors are logged. */
  onPurged?: (paths: string[]) => void;
}

/** Each file's path relative to .trash/, and the time the sweep first saw it there. */
type Stamps = Record<string, string>;

/**
 * Removes the files under .trash/ that the sweep has seen for TRASH_RETENTION_DAYS or more, then the directories the
 * removal left empty, and reports the files to `onPurged`. A file the sweep has not seen before is stamped with `now`.
 * Returns how many files went. It never throws: a failure is logged, and the file keeps its stamp for the next sweep.
 */
export function pruneTrash({
  now = Date.now(),
  workspace = WORKSPACE_DIR,
  file = TRASH_STATE_FILE,
  onPurged,
}: PruneTrashOptions = {}): number {
  const before = readStamps(file);
  const root = trashRoot(workspace);
  const stamps: Stamps = {};
  const purged: string[] = [];
  if (root !== undefined) {
    for (const rel of listFiles(root)) {
      const seen = before[rel] ?? new Date(now).toISOString();
      if (now - Date.parse(seen) < TRASH_RETENTION_DAYS * DAY_MS) {
        stamps[rel] = seen;
        continue;
      }
      try {
        removeFile(root, rel);
        purged.push(rel);
      } catch (err) {
        stamps[rel] = seen;
        log.warn(`removing ${TRASH_DIR}/${rel} failed, it is kept for the next sweep: ${describeError(err)}`);
      }
    }
    removeEmptied(root, purged);
  }
  if (purged.length > 0 && onPurged) {
    try {
      onPurged(purged.map((rel) => `${TRASH_DIR}/${rel}`));
    } catch (err) {
      log.warn(`telling the documents of ${purged.length} purged file(s) failed: ${describeError(err)}`);
    }
  }
  // Only the files still there keep a stamp: one whose file is gone (restored, or removed by hand) drops out here.
  try {
    writeJson(file, stamps);
  } catch (err) {
    log.warn(`writing ${file} failed, the next sweep stamps the files again: ${describeError(err)}`);
  }
  return purged.length;
}

/** The stamps as the file holds them. A file that is missing, unreadable or not a stamps file is logged and has none. */
function readStamps(file: string): Stamps {
  let raw: unknown;
  try {
    raw = readJson<unknown>(file);
  } catch (err) {
    log.warn(`${file} is unreadable, the trashed files are stamped afresh: ${describeError(err)}`);
    return {};
  }
  if (raw === undefined) {
    log.warn(`${file} is missing, the trashed files are stamped afresh`);
    return {};
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    log.warn(`${file} is not a stamps file, the trashed files are stamped afresh`);
    return {};
  }
  const stamps: Stamps = {};
  for (const [rel, seen] of Object.entries(raw)) {
    if (typeof seen === "string" && !Number.isNaN(Date.parse(seen))) stamps[rel] = seen;
  }
  return stamps;
}

/**
 * The real path of .trash/, or undefined when there is none. A .trash/ that is a link is not followed, and nothing is
 * swept under it.
 */
function trashRoot(workspace: string): string | undefined {
  const trash = path.join(workspace, TRASH_DIR);
  try {
    if (!fs.lstatSync(trash).isDirectory()) {
      log.warn(`${trash} is not a directory, nothing in it is swept`);
      return undefined;
    }
    return fs.realpathSync(trash);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") log.warn(`not sweeping ${trash}: ${describeError(err)}`);
    return undefined;
  }
}

/**
 * The regular files and links under the root, relative to it, in name order. Entries are typed without following a
 * link, and anything else (a pipe, a socket) is left alone.
 */
function listFiles(root: string, dir = ""): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
  } catch (err) {
    log.warn(`reading ${TRASH_DIR}/${dir} failed, its files are kept for now: ${describeError(err)}`);
    return [];
  }
  const found: string[] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...listFiles(root, rel));
    else if (entry.isFile() || entry.isSymbolicLink()) found.push(rel);
  }
  return found;
}

/**
 * Removes one file the walk found. Its directory must still be where the walk found it, so a directory swapped for a
 * link since is not followed. A link is removed as a link, and its target is left alone.
 */
function removeFile(root: string, rel: string): void {
  const dir = path.join(root, path.dirname(rel));
  if (fs.realpathSync(dir) !== dir) throw new Error(`${path.dirname(rel)} is no longer a directory of ${TRASH_DIR}/`);
  // force: a file already gone is as purged as one this removed.
  fs.rmSync(path.join(root, rel), { force: true });
}

/**
 * Removes the directories the purge left empty, deepest first. .trash/ itself stays, and so does a directory that still
 * holds a file. rmdir refuses a directory that is not empty, so a file that arrives meanwhile is never taken with it.
 */
function removeEmptied(root: string, purged: string[]): void {
  const dirs = new Set<string>();
  for (const rel of purged) {
    for (let dir = path.dirname(rel); dir !== "."; dir = path.dirname(dir)) dirs.add(dir);
  }
  const deepestFirst = [...dirs].sort((a, b) => b.split("/").length - a.split("/").length);
  for (const dir of deepestFirst) {
    const abs = path.join(root, dir);
    try {
      if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
    } catch (err) {
      log.warn(`removing the empty directory ${TRASH_DIR}/${dir} failed: ${describeError(err)}`);
    }
  }
}
