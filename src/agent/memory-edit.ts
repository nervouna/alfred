// The owner's view and edits of long-term memory in the app: the list (GET /api/memories) and the commands memory.create,
// memory.update and memory.delete (see MemoryCommands in src/api/server.ts). The files, their format and the generated
// index are memory.ts's; this adds what the app needs of them: a version for each memory, the sha256 of its file's bytes,
// and edits that never race a memory scan or the agent into a lost update. The commands hold the handler's MemoryLock as a
// task does, so they run beside running tasks and never beside a scan. Each checks the version and writes in one
// synchronous step, with no await between them, and writes atomically. Deleting moves the file into .trash/memory/, as
// the move_file tool does: nothing the owner or the agent does removes a file for good.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Memory, MemoryCreate, MemoryDelete, MemoryList, MemoryResult, MemoryUpdate } from "../api/schema.ts";
import type { MemoryCommands, MemoryReply } from "../api/server.ts";
import type { Versions } from "../documents/versions.ts";
import { localDate, uniquePath } from "../files.ts";
import { describeError, log } from "../log.ts";
import { resolveInside } from "./guard.ts";
import {
  type Locked,
  MEMORY_DIR,
  MEMORY_INDEX,
  type Memory as StoredMemory,
  capIndex,
  formatMemory,
  indexLine,
  loadMemoryFiles,
  memoryDir,
  parseMemory,
  syncMemoryIndex,
  writeFileAtomic,
} from "./memory.ts";

/** How long a command waits for a memory scan to end before it is refused. */
export const MEMORY_LOCK_WAIT_MS = 3000;
/** Where a deleted memory goes, relative to the workspace. */
const TRASH_MEMORY_DIR = ".trash/memory";
/** The most characters of a memory's file name before `.md` (MEMORY_FILE_RE allows 80). */
const MAX_STEM_CHARS = 80;
const BUSY = "Alfred is tidying memory right now; try again shortly.";

function sha256Hex(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** The contract's view of a memory parsed from a file with these bytes. */
function toMemory(stored: StoredMemory, bytes: Buffer): Memory {
  return {
    file: stored.file,
    name: stored.name,
    description: stored.description,
    kind: stored.type,
    // A file may hold anything for `updated`; the contract holds a date or nothing.
    updated: /^\d{4}-\d{2}-\d{2}$/.test(stored.updated) ? stored.updated : "",
    body: stored.body,
    version: sha256Hex(bytes),
  };
}

/**
 * GET /api/memories: every memory, in the order the system prompt's index lists them, each with the sha256 of its file's
 * bytes as its version. `promptCount` is how many of the first fit that index under capIndex's caps (`caps` is for tests).
 * A memory is parsed from the same bytes its version is taken of.
 */
export function memoryList(workspace: string, caps: { maxLines?: number; maxBytes?: number } = {}): MemoryList {
  const files = loadMemoryFiles(workspace);
  const { lines } = capIndex(files.map((file) => indexLine(file.memory)), caps.maxLines, caps.maxBytes);
  return { memories: files.map((file) => toMemory(file.memory, file.bytes)), promptCount: lines.length };
}

/** What a command did: the answer, and for a change the commit that records it in the workspace's history. */
interface Outcome<T> {
  reply: MemoryReply<T>;
  commit?: { message: string; paths: string[] };
}

function refused<T>(status: 400 | 404 | 409, error: string): Outcome<T> {
  return { reply: { ok: false, status, error } };
}

const relOf = (file: string): string => `${MEMORY_DIR}/${file}`;
const INDEX_REL = relOf(MEMORY_INDEX);

/** The memory directory, made when it is missing; undefined when `memory` is there but is not a folder of the workspace. */
function ensureMemoryDir(workspace: string): string | undefined {
  const existing = memoryDir(workspace);
  if (existing) return existing;
  try {
    fs.mkdirSync(path.join(fs.realpathSync(workspace), MEMORY_DIR));
  } catch {
    return undefined;
  }
  return memoryDir(workspace);
}

/**
 * The bytes of the regular file `file` in the memory directory, undefined when there is none. The directory is listed
 * rather than the file looked up: on a file system that ignores case, `memory.md` would find MEMORY.md, the index.
 */
function readMemoryFile(dir: string, file: string): Buffer | undefined {
  const entry = fs.readdirSync(dir, { withFileTypes: true }).find((candidate) => candidate.name === file);
  return entry?.isFile() ? fs.readFileSync(path.join(dir, file)) : undefined;
}

function isTaken(dir: string, file: string): boolean {
  try {
    fs.lstatSync(path.join(dir, file));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function randomId(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
}

/**
 * The file name for a new memory called `name`: the name's lowercase ASCII letters and digits with hyphens between, or
 * `memory-<YYYYMMDD>-<4 letters or digits>` when it has none (a Chinese name, for one). A name that is `taken` gets
 * `-2`, `-3` and on. Always a MEMORY_FILE_RE match, with at most 80 characters before `.md`.
 */
export function memoryFileName(name: string, today: string, taken: (file: string) => boolean): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const base = slug || `memory-${today.replaceAll("-", "")}-${randomId(4)}`;
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const file = `${base.slice(0, MAX_STEM_CHARS - suffix.length).replace(/-+$/, "")}${suffix}.md`;
    if (!taken(file)) return file;
  }
}

/** The index follows every change. A failure to rebuild it is logged: the change is made, and the next run rebuilds it. */
function syncIndex(workspace: string): void {
  try {
    syncMemoryIndex(workspace);
  } catch (err) {
    log.warn(`memory index sync after the owner's edit failed: ${describeError(err)}`);
  }
}

/** The answer to a command that wrote `text` as the memory `file`. */
function written(file: string, text: string): MemoryReply<MemoryResult> {
  return { ok: true, body: { memory: toMemory(parseMemory(file, text), Buffer.from(text, "utf8")) } };
}

/** memory.create: writes a new memory dated `today`, under a name that no file in memory/ has. Synchronous. */
export function createMemory(workspace: string, command: MemoryCreate, today = localDate()): Outcome<MemoryResult> {
  const dir = ensureMemoryDir(workspace);
  if (!dir) return refused(409, `${MEMORY_DIR}/ is not a folder in the workspace, so nothing is added to it`);
  const file = memoryFileName(command.name, today, (candidate) => isTaken(dir, candidate));
  const text = formatMemory({ name: command.name, description: command.description, type: command.kind, updated: today, body: command.body });
  writeFileAtomic(path.join(dir, file), text);
  syncIndex(workspace);
  return { reply: written(file, text), commit: { message: `Add ${relOf(file)}`, paths: [relOf(file), INDEX_REL] } };
}

/**
 * memory.update: replaces the memory with the command's fields, dated `today`, when the command's version is the file's
 * current one. The file is written with formatMemory, so it keeps the five known fields and no other. Synchronous.
 */
export function updateMemory(workspace: string, command: MemoryUpdate, today = localDate()): Outcome<MemoryResult> {
  const dir = memoryDir(workspace);
  const current = dir && readMemoryFile(dir, command.file);
  if (!dir || !current) return refused(404, `no memory ${command.file}`);
  if (sha256Hex(current) !== command.version) return refused(409, `version: not the current version of ${command.file}`);
  const text = formatMemory({ name: command.name, description: command.description, type: command.kind, updated: today, body: command.body });
  writeFileAtomic(path.join(dir, command.file), text);
  syncIndex(workspace);
  return { reply: written(command.file, text), commit: { message: `Edit ${relOf(command.file)}`, paths: [relOf(command.file), INDEX_REL] } };
}

/**
 * memory.delete: moves the file into .trash/memory/ (under a number suffix when that name is taken there) when the
 * command's version is the file's current one. Synchronous.
 */
export function deleteMemory(workspace: string, command: MemoryDelete): Outcome<{ deleted: true }> {
  const dir = memoryDir(workspace);
  const current = dir && readMemoryFile(dir, command.file);
  if (!dir || !current) return refused(404, `no memory ${command.file}`);
  if (sha256Hex(current) !== command.version) return refused(409, `version: not the current version of ${command.file}`);
  const trash = resolveInside(workspace, TRASH_MEMORY_DIR);
  if (!trash) return refused(409, `${TRASH_MEMORY_DIR}/ is outside the workspace, so nothing is moved into it`);
  fs.mkdirSync(trash, { recursive: true });
  const target = uniquePath(trash, command.file);
  fs.renameSync(path.join(dir, command.file), target);
  syncIndex(workspace);
  const moved = path.relative(fs.realpathSync(workspace), target).split(path.sep).join("/");
  // .trash/ is not versioned, so the history records the old path as deleted; the new path is named for completeness.
  return { reply: { ok: true, body: { deleted: true } }, commit: { message: `Delete ${relOf(command.file)}`, paths: [relOf(command.file), moved, INDEX_REL] } };
}

/** What runs a job under the memory lock: the agent handler. */
export interface MemoryLocker {
  withMemoryLock<T>(job: () => T, waitMs: number): Promise<Locked<T>>;
}

/**
 * The memory commands of the command API. Each runs under `locker`'s memory lock, waiting up to `lockWaitMs` (3 s) for a
 * scan to end and answering 409 when it does not. With `versions`, a change is then committed to the workspace's history
 * (`Add`, `Edit` or `Delete` `memory/<file>`, with the index); a failed commit is logged and the answer stays as it was.
 */
export function memoryCommands(
  locker: MemoryLocker,
  opts: { workspace: string; versions?: Pick<Versions, "commit">; lockWaitMs?: number },
): MemoryCommands {
  async function run<T>(job: () => Outcome<T>): Promise<MemoryReply<T>> {
    const done = await locker.withMemoryLock(job, opts.lockWaitMs ?? MEMORY_LOCK_WAIT_MS);
    if (!done.locked) return { ok: false, status: 409, error: BUSY };
    const { reply, commit } = done.value;
    if (reply.ok && commit && opts.versions) {
      try {
        await opts.versions.commit(commit.message, { paths: commit.paths });
      } catch (err) {
        log.warn(`committing "${commit.message}" failed: ${describeError(err)}`);
      }
    }
    return reply;
  }
  return {
    create: (command) => run(() => createMemory(opts.workspace, command)),
    update: (command) => run(() => updateMemory(opts.workspace, command)),
    delete: (command) => run(() => deleteMemory(opts.workspace, command)),
  };
}
