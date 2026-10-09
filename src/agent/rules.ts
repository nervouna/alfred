// Workspace rules kept in ALFRED.md files.
//
// The root ALFRED.md goes into the system prompt of every task. A subdirectory
// can have its own ALFRED.md; a PostToolUse hook discloses it through
// additionalContext the first time in a run the agent touches a path under
// that directory, and again if the file changes.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";

import { log } from "../log.ts";
import { resolveInside } from "./guard.ts";

export const RULES_FILE = "ALFRED.md";
/** Cap on the text of one rules file placed in the prompt or injected by the hook. */
export const RULES_MAX_BYTES = 8 * 1024;
/** Rules files under .trash/ were deleted and never apply. */
const TRASH_DIR = ".trash";

export const DEFAULT_RULES = `# Workspace rules

How Alfred works in this workspace. Alfred reads this file at the start of every task. A subdirectory can have its own ALFRED.md with rules for that directory; Alfred sees it once it works there. To change a rule, tell Alfred in WeChat or edit the file.

## Layout

- inbox/<date>/  files sent in WeChat (images, PDFs, documents, video); Alfred saves them here
- reports/  deliverables written for the user
- notes/  working notes and collected material
- .trash/  deleted files
`;

export interface RulesFile {
  /** Real path, always spelled with RULES_FILE as the last component. */
  file: string;
  /** Path relative to the workspace, for display. */
  rel: string;
  text: string;
  truncated: boolean;
  /** mtime and size; a changed file gets a new version and is disclosed again. */
  version: string;
}

export function isRulesFileName(name: string): boolean {
  return name.toLowerCase() === RULES_FILE.toLowerCase();
}

function realRoot(root: string): string {
  return fs.realpathSync(root);
}

/** Write the default root ALFRED.md unless one exists. Returns true when it was written. */
export function seedRules(root: string): boolean {
  try {
    fs.writeFileSync(path.join(root, RULES_FILE), DEFAULT_RULES, { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/**
 * Read a rules file, capped at RULES_MAX_BYTES. A symlink in the last component
 * is not followed and anything but a regular file is ignored. `file` must be a
 * real path below the real workspace root.
 */
export function readRules(rootReal: string, file: string): RulesFile | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return undefined;
    const buf = Buffer.alloc(Math.min(stat.size, RULES_MAX_BYTES));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const truncated = stat.size > n;
    // A cut can split a UTF-8 sequence; drop the replacement characters it leaves.
    let text = buf.subarray(0, n).toString("utf8");
    if (truncated) text = text.replace(/�+$/, "");
    return { file, rel: path.relative(rootReal, file), text: text.trim(), truncated, version: `${stat.mtimeMs}:${stat.size}` };
  } finally {
    fs.closeSync(fd);
  }
}

/** The root ALFRED.md, or undefined when there is none. */
export function loadRootRules(root: string): RulesFile | undefined {
  const rootReal = realRoot(root);
  return readRules(rootReal, path.join(rootReal, RULES_FILE));
}

/**
 * Directories whose ALFRED.md applies to `p`, from the workspace root down to
 * the directory `p` is in (or is), as real paths. Empty when `p` is outside the
 * workspace; directories under .trash/ are left out.
 */
export function rulesDirs(root: string, p: string): string[] {
  const real = resolveInside(root, p);
  if (!real) return [];
  const rootReal = realRoot(root);
  let dir = real;
  try {
    if (!fs.statSync(real).isDirectory()) dir = path.dirname(real);
  } catch {
    dir = path.dirname(real);
  }
  const dirs = [rootReal];
  const rel = path.relative(rootReal, dir);
  const parts = rel ? rel.split(path.sep) : [];
  if (parts[0] === TRASH_DIR) return dirs;
  for (const part of parts) dirs.push(path.join(dirs[dirs.length - 1] ?? rootReal, part));
  return dirs;
}

const GLOB_CHARS = /[*?[\]{}]/;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** Paths a file tool call works in. Rules along these paths are disclosed after the call. */
export function touchedPaths(toolName: string, input: Record<string, unknown>): string[] {
  let paths: (string | undefined)[];
  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
      paths = [str(input.file_path)];
      break;
    case "Glob": {
      // The directory the pattern starts in: its segments before the first wildcard.
      const fixed: string[] = [];
      for (const segment of (str(input.pattern) ?? "").split("/")) {
        if (GLOB_CHARS.test(segment)) break;
        fixed.push(segment);
      }
      const prefix = fixed.join("/");
      paths = [path.isAbsolute(prefix) ? prefix : path.join(str(input.path) ?? ".", prefix)];
      break;
    }
    case "Grep":
      paths = [str(input.path) ?? "."];
      break;
    case "mcp__alfred__move_file":
      paths = [str(input.from), str(input.to)];
      break;
    case "mcp__alfred__render_pdf":
      paths = [str(input.source), str(input.output)];
      break;
    default:
      paths = [];
  }
  return paths.filter((p) => p !== undefined);
}

/** Rules files the agent has seen in one run, by real path and version. */
export class RulesTracker {
  private readonly seen = new Map<string, string>();
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /** Load the root ALFRED.md for the system prompt and count it as seen. */
  loadRoot(): RulesFile | undefined {
    const rules = loadRootRules(this.root);
    if (rules) this.seen.set(rules.file, rules.version);
    return rules;
  }

  /**
   * Rules files along `paths` that the agent has not seen in their current
   * version, root first. They are marked seen, so each version is returned
   * once per run. Synchronous, so parallel tool calls cannot both take a file.
   */
  take(paths: string[]): RulesFile[] {
    const rootReal = realRoot(this.root);
    const out: RulesFile[] = [];
    for (const p of paths) {
      for (const dir of rulesDirs(this.root, p)) {
        const rules = readRules(rootReal, path.join(dir, RULES_FILE));
        if (!rules || this.seen.get(rules.file) === rules.version) continue;
        this.seen.set(rules.file, rules.version);
        out.push(rules);
      }
    }
    return out;
  }

  /**
   * Account for a successful tool call that targets a rules file itself: Read,
   * Write and Edit leave the agent knowing its content, so it is not disclosed
   * again; writes and moves are logged.
   */
  recordToolUse(toolName: string, input: Record<string, unknown>): void {
    const rootReal = realRoot(this.root);
    if (toolName === "Read" || toolName === "Write" || toolName === "Edit") {
      const p = str(input.file_path);
      // Resolve only the directory: a symlinked ALFRED.md must not mark the file it points to.
      const dir = p && isRulesFileName(path.basename(p)) ? resolveInside(this.root, path.dirname(p)) : undefined;
      if (!dir) return;
      const rules = readRules(rootReal, path.join(dir, RULES_FILE));
      if (rules) this.seen.set(rules.file, rules.version);
      if (toolName !== "Read") log.info(`agent ${toolName === "Write" ? "wrote" : "edited"} ${rules?.rel ?? p}`);
    } else if (toolName === "mcp__alfred__move_file") {
      const from = str(input.from) ?? "";
      const to = str(input.to) ?? "";
      if (isRulesFileName(path.basename(from)) || isRulesFileName(path.basename(to))) {
        log.info(`agent moved ${from} to ${to}`);
      }
    }
  }
}

export function formatRules(rules: RulesFile): string {
  const note = rules.truncated ? `\n[Cut off at ${RULES_MAX_BYTES} bytes; the file is longer. Suggest that the user shorten it.]` : "";
  return `<workspace-rules path="${rules.rel}">\n${rules.text}${note}\n</workspace-rules>`;
}

function disclosure(files: RulesFile[]): string {
  return `Workspace rules for the path you just used, from ${files.map((f) => f.rel).join(", ")}. Each file applies to its directory and everything below it, adds to the rules above it and wins where they conflict. Follow them for the rest of this task. If what you just wrote does not follow them, fix it.

${files.map(formatRules).join("\n\n")}`;
}

/** PostToolUse and PostToolUseFailure hook that discloses rules files the agent has not seen in this run. */
export function rulesDisclosure(tracker: RulesTracker): HookCallbackMatcher {
  return {
    hooks: [
      async (input) => {
        if (input.hook_event_name !== "PostToolUse" && input.hook_event_name !== "PostToolUseFailure") return {};
        const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
        if (input.hook_event_name === "PostToolUse") tracker.recordToolUse(input.tool_name, toolInput);
        const files = tracker.take(touchedPaths(input.tool_name, toolInput));
        if (!files.length) return {};
        log.info(`disclosed ${files.map((f) => f.rel).join(", ")} after ${input.tool_name}`);
        return { hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: disclosure(files) } };
      },
    ],
  };
}

/** Content hash of every rules file in the workspace outside .trash/, by workspace-relative path. */
export function snapshotRules(root: string): Map<string, string> {
  const out = new Map<string, string>();
  let rootReal: string;
  try {
    rootReal = realRoot(root);
  } catch {
    return out;
  }
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      // Dirent types come from lstat, so symlinks are neither walked nor read.
      if (entry.isDirectory()) {
        if (!(dir === rootReal && entry.name === TRASH_DIR)) walk(full);
      } else if (entry.isFile() && isRulesFileName(entry.name)) {
        try {
          out.set(path.relative(rootReal, full), crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex"));
        } catch {
          // Vanished or unreadable; treat as absent.
        }
      }
    }
  };
  walk(rootReal);
  return out;
}

/** WeChat notice for rules files a run created, changed or removed; undefined when none changed. */
export function rulesChangeNotice(before: Map<string, string>, after: Map<string, string>): string | undefined {
  const lines: string[] = [];
  for (const rel of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const prev = before.get(rel);
    const next = after.get(rel);
    if (prev === undefined) lines.push(`已新建 ${rel}`);
    else if (next === undefined) lines.push(`已移除 ${rel}`);
    else if (prev !== next) lines.push(`已更新 ${rel}`);
  }
  return lines.length ? lines.join("\n") : undefined;
}
