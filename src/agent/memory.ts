// Long-term memory: one fact per Markdown file under workspace/memory/, with a
// generated index (MEMORY.md) that is injected into every task's system prompt.
// The agent reads individual memory files on demand.

import fs from "node:fs";
import path from "node:path";

import { readJson } from "../store.ts";
import { resolveInside } from "./guard.ts";

export const MEMORY_DIR = "memory";
export const MEMORY_INDEX = "MEMORY.md";
export const MEMORY_TYPES = ["user", "preference", "project", "correction"] as const;

/** Cap on the index injected into the system prompt. */
export const INDEX_MAX_LINES = 200;
export const INDEX_MAX_BYTES = 8 * 1024;
const DESCRIPTION_MAX_CHARS = 200;

/** Memory file names: kebab-case ASCII, so they are easy to type and never collide with MEMORY.md. */
export const MEMORY_FILE_RE = /^[a-z0-9][a-z0-9-]{0,79}\.md$/;

export interface Memory {
  /** File name inside memory/. */
  file: string;
  name: string;
  description: string;
  type: string;
  /** YYYY-MM-DD; empty when the file has none. */
  updated: string;
  body: string;
}

const INDEX_HEADER = `# Memory index

<!-- Generated from the memory files in this folder after every task. Edit those files, not this one. -->
`;

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return String(JSON.parse(v));
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/** Parse a memory file: `key: value` frontmatter between `---` lines, then the body. Tolerates missing frontmatter. */
export function parseMemory(file: string, text: string): Memory {
  const fields: Record<string, string> = {};
  let body = text;
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (match) {
    for (const line of (match[1] ?? "").split(/\r?\n/)) {
      const colon = line.indexOf(":");
      if (colon > 0) fields[line.slice(0, colon).trim().toLowerCase()] = unquote(line.slice(colon + 1));
    }
    body = text.slice(match[0].length);
  }
  return {
    file,
    name: fields.name || file.replace(/\.md$/, ""),
    description: fields.description ?? "",
    type: fields.type ?? "",
    updated: fields.updated ?? "",
    body: body.trim(),
  };
}

export function formatMemory(m: Omit<Memory, "file">): string {
  const field = (s: string) => JSON.stringify(oneLine(s, 500));
  return `---\nname: ${field(m.name)}\ndescription: ${field(m.description)}\ntype: ${m.type}\nupdated: ${m.updated}\n---\n\n${m.body.trim()}\n`;
}

/** The memory directory, or undefined when it is missing or a symlink out of the workspace. */
export function memoryDir(workspace: string): string | undefined {
  try {
    const dir = resolveInside(workspace, MEMORY_DIR);
    return dir && fs.statSync(dir).isDirectory() ? dir : undefined;
  } catch {
    return undefined;
  }
}

/**
 * All memories, most recently updated first. Only regular top-level `.md`
 * files count; symlinks are skipped so a link cannot pull outside content
 * into the system prompt.
 */
export function loadMemories(workspace: string): Memory[] {
  const dir = memoryDir(workspace);
  if (!dir) return [];
  const memories: Memory[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === MEMORY_INDEX) continue;
    memories.push(parseMemory(entry.name, fs.readFileSync(path.join(dir, entry.name), "utf-8")));
  }
  return memories.sort((a, b) => b.updated.localeCompare(a.updated) || a.name.localeCompare(b.name));
}

export function indexLine(m: Memory): string {
  const description = oneLine(m.description || m.body, DESCRIPTION_MAX_CHARS);
  const line = `- [${oneLine(m.name, 80)}](${m.file})${description ? ` — ${description}` : ""}`;
  // The prompt wraps the index in <memory-index> tags; a memory must not close them.
  return line.replace(/<(\/?memory-index)/gi, "‹$1");
}

/** Regenerate memory/MEMORY.md from the memory files and return its index lines. */
export function syncMemoryIndex(workspace: string): string[] {
  const dir = memoryDir(workspace);
  if (!dir) return [];
  const lines = loadMemories(workspace).map(indexLine);
  const content = `${INDEX_HEADER}\n${lines.length ? lines.join("\n") : "(no memories yet)"}\n`;
  const file = path.join(dir, MEMORY_INDEX);
  let current: string | undefined;
  try {
    current = fs.readFileSync(file, "utf-8");
  } catch {}
  if (current !== content) writeFileAtomic(file, content);
  return lines;
}

export interface PromptIndex {
  /** Lines that fit under the cap. */
  lines: string[];
  /** Number of memories in the full index. */
  total: number;
}

/** Keep the leading index lines that fit within both caps. */
export function capIndex(lines: string[], maxLines = INDEX_MAX_LINES, maxBytes = INDEX_MAX_BYTES): PromptIndex {
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(line, "utf-8") + 1;
    if (kept.length >= maxLines || bytes + size > maxBytes) break;
    kept.push(line);
    bytes += size;
  }
  return { lines: kept, total: lines.length };
}

/** Write via a temp file and rename, so readers never see a partial file. */
export function writeFileAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/** Text that looks like a credential. Extraction drops such candidates. */
export function looksLikeSecret(text: string): boolean {
  return [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/,
    /\b(?:ghp|gho|ghs|ghu|github_pat|xox[abpr]|glpat)[-_][A-Za-z0-9_-]{16,}/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
    /(?:password|passwd|密码|口令|token|api[ _-]?key|secret)\s*[:=：是为]\s*\S{6,}/i,
  ].some((re) => re.test(text)) || /\b(?=[A-Za-z]*\d)(?=\d*[A-Za-z])[A-Za-z0-9]{32,}\b/.test(text);
}

type LockHolder = "task" | "scan";
interface LockInfo {
  pid: number;
  holder: LockHolder;
  since: string;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Mutual exclusion between agent tasks and memory scans, so the agent and the
 * extraction job never edit memory files at the same time. It is a lock file
 * because a manual scan (`cli.ts memory-scan`) runs in a separate process from
 * the bot. Tasks share the lock with each other; a scan holds it alone. A lock
 * left by a dead process is taken over.
 */
export class MemoryLock {
  private readonly file: string;
  private holder?: LockHolder;
  private count = 0;

  constructor(file: string) {
    this.file = file;
  }

  tryAcquire(holder: LockHolder): boolean {
    if (this.holder) {
      if (this.holder !== "task" || holder !== "task") return false;
      this.count++;
      return true;
    }
    const info: LockInfo = { pid: process.pid, holder, since: new Date().toISOString() };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(this.file, JSON.stringify(info), { flag: "wx", mode: 0o600 });
        this.holder = holder;
        this.count = 1;
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      const current = this.current();
      if (current ? isAlive(current.pid) : this.justCreated()) return false;
      fs.rmSync(this.file, { force: true });
    }
    return false;
  }

  /** Poll until the lock is free; false when `timeoutMs` passes or `signal` aborts first. */
  async acquire(holder: LockHolder, timeoutMs: number, signal?: AbortSignal, pollMs = 500): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.tryAcquire(holder)) {
      if (signal?.aborted || Date.now() >= deadline) return false;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, pollMs);
        signal?.addEventListener("abort", done, { once: true });
      });
    }
    return true;
  }

  release(): void {
    if (!this.holder || --this.count > 0) return;
    this.holder = undefined;
    fs.rmSync(this.file, { force: true });
  }

  /** An unreadable lock file may still be being written by its new holder. */
  private justCreated(): boolean {
    try {
      return Date.now() - fs.statSync(this.file).mtimeMs < 5_000;
    } catch {
      return false;
    }
  }

  /** Who holds the lock, for messages; undefined when it is free or unreadable. */
  current(): LockInfo | undefined {
    try {
      return readJson<LockInfo>(this.file);
    } catch {
      return undefined;
    }
  }
}
