// Confines the agent's file tools to the workspace.

import fs from "node:fs";
import path from "node:path";

import type { HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";

import { log } from "../log.ts";

function lexists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve `p` (relative paths are taken from `root`) to its real location and
 * return it only if it stays inside `root`. Symlinks are followed through the
 * deepest existing ancestor, so a link pointing out of the workspace is caught
 * even when the final component does not exist yet. Dangling links are refused.
 */
export function resolveInside(root: string, p: string): string | undefined {
  const rootReal = fs.realpathSync(root);
  let existing = path.resolve(rootReal, p);
  const rest: string[] = [];
  while (!lexists(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  let real: string;
  try {
    real = path.join(fs.realpathSync(existing), ...rest);
  } catch {
    return undefined;
  }
  return real === rootReal || real.startsWith(rootReal + path.sep) ? real : undefined;
}

const PATH_TOOLS: Record<string, string> = {
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

function hasParentSegment(pattern: string): boolean {
  return pattern.split(/[\\/]/).includes("..");
}

/** Input fields that name a path a tool call writes to. */
const WRITE_PATHS: Record<string, string[]> = {
  Write: ["file_path"],
  Edit: ["file_path"],
  MultiEdit: ["file_path"],
  NotebookEdit: ["notebook_path"],
  mcp__alfred__move_file: ["from", "to"],
  mcp__alfred__render_pdf: ["output"],
  mcp__alfred__generate_image: ["output"],
  mcp__alfred__save_media: ["output"],
};

/** Input fields that name a path a tool call reads without writing it, beyond PATH_TOOLS. */
const READ_PATHS: Record<string, string[]> = {
  mcp__alfred__deliver: ["path"],
  mcp__alfred__render_pdf: ["source"],
};

/** Whether a path or pattern has a `.git` segment, in any case: git's own directory, which no tool may use (see src/documents/versions.ts). */
function insideGitDir(p: string): boolean {
  return p.split(/[\\/]/).some((segment) => segment.toLowerCase() === ".git");
}

/** A denial reason when a tool call names a `.git` segment in a path, pattern or glob, read or written. */
function gitDirReason(toolName: string, input: Record<string, unknown>): string | undefined {
  const keys = [...(READ_PATHS[toolName] ?? [])];
  const pathKey = PATH_TOOLS[toolName];
  if (pathKey) keys.push(pathKey);
  if (toolName === "Glob" || toolName === "Grep") keys.push("path", "pattern", "glob");
  const named: unknown[] = [...keys.map((key) => input[key]), ...writtenPaths(toolName, input)];
  const hit = named.find((p): p is string => typeof p === "string" && insideGitDir(p));
  return hit === undefined ? undefined : `${hit} is inside a .git directory, which no tool may use.`;
}

/** Where a run may read but not write: top-level workspace directories, and file names that count anywhere in the workspace. Names match in any case, as on a case-insensitive disk. */
export interface ReadOnlyPaths {
  dirs: readonly string[];
  names: readonly string[];
}

/**
 * Where a run may write, enforced on every tool call of the run's own thread and of its subagents. Paths are
 * workspace-relative prefixes in any case, spelled with `/`. A scope with no field set is the whole workspace.
 */
export interface WriteScope {
  /** When set, writes are allowed only under these prefixes (a prefix names a folder or a file); every other write is denied. */
  allow?: readonly string[];
  /** Writes here are denied, whoever makes them, unless the path is under one of `except`. */
  readOnly?: ReadOnlyPaths;
  /** Prefixes the `readOnly` folders and names do not apply under: a bot's own home, whose ALFRED.md it may change. */
  except?: readonly string[];
}

export type GuardOptions = WriteScope;

/** Where generate_image and save_media write when the call names no output: the folders their defaults live in (see image.ts and media.ts). */
const DEFAULT_OUTPUTS: Record<string, string[]> = {
  mcp__alfred__generate_image: ["images"],
  mcp__alfred__save_media: ["images", "video", "audio"],
};

/** The paths a tool call writes to, as it spells them. */
function writtenPaths(toolName: string, input: Record<string, unknown>): string[] {
  const named = (WRITE_PATHS[toolName] ?? []).flatMap((key) => {
    const p = input[key];
    return typeof p === "string" && p ? [p] : [];
  });
  // render_pdf without an output writes next to its source (see tools.ts).
  const source = input.source;
  if (toolName === "mcp__alfred__render_pdf" && !named.length && typeof source === "string" && source) {
    return [`${source.slice(0, source.length - path.extname(source).length)}.pdf`];
  }
  return named.length ? named : (DEFAULT_OUTPUTS[toolName] ?? []);
}

function segmentsUnder(rel: string[], prefix: string): boolean {
  const parts = prefix.split("/").filter(Boolean);
  return parts.length <= rel.length && parts.every((part, i) => rel[i]?.toLowerCase() === part.toLowerCase());
}

/** What a write scope refuses in a tool call: the path as the call spelled it and the reason; undefined when the call writes only where the scope lets it. */
export function scopeViolation(root: string, toolName: string, input: Record<string, unknown>, scope: WriteScope): { path: string; reason: string } | undefined {
  const rootReal = fs.realpathSync(root);
  const dirs = (scope.readOnly?.dirs ?? []).map((dir) => dir.toLowerCase());
  const names = (scope.readOnly?.names ?? []).map((name) => name.toLowerCase());
  for (const p of writtenPaths(toolName, input)) {
    const real = resolveInside(root, p);
    if (!real) continue; // The workspace check refuses paths outside the workspace.
    const relPath = path.relative(rootReal, real);
    const rel = relPath ? relPath.split(path.sep) : [];
    if (scope.allow && !scope.allow.some((prefix) => segmentsUnder(rel, prefix))) {
      const where = scope.allow.map((prefix) => `${prefix}/`).join(", ");
      return { path: p, reason: `${p} is outside where this run may write: only ${where} may be changed, the rest of the workspace may be read. Say in your final message what should change instead.` };
    }
    if (scope.except?.some((prefix) => segmentsUnder(rel, prefix))) continue;
    const top = rel[0]?.toLowerCase();
    if ((top && dirs.includes(top)) || names.includes(path.basename(relPath).toLowerCase())) {
      const places = [...(scope.readOnly?.dirs ?? []).map((dir) => `${dir}/`), ...(scope.readOnly?.names ?? []).map((name) => `${name} files`)];
      return { path: p, reason: `${p} is read-only in this run: ${places.join(", ")} may be read but not changed. Say in your final message what should change instead.` };
    }
  }
  return undefined;
}

/** The path, as the call spelled it, where a tool call would write inside `readOnly`; undefined when it writes nowhere there. */
export function readOnlyWrite(root: string, toolName: string, input: Record<string, unknown>, readOnly: ReadOnlyPaths): string | undefined {
  return scopeViolation(root, toolName, input, { readOnly })?.path;
}

/** Returns a denial reason when a tool call would touch anything outside `root`, a `.git` path, or write where the write scope `options` does not let the run. */
export function checkToolInput(root: string, toolName: string, input: Record<string, unknown>, options: GuardOptions = {}): string | undefined {
  return gitDirReason(toolName, input) ?? checkWorkspace(root, toolName, input) ?? scopeViolation(root, toolName, input, options)?.reason;
}

function checkWorkspace(root: string, toolName: string, input: Record<string, unknown>): string | undefined {
  const outside = (p: string) => `${p} is outside the workspace; only files under ${root} are accessible.`;

  const pathKey = PATH_TOOLS[toolName];
  if (pathKey) {
    const p = input[pathKey];
    if (typeof p !== "string" || !p) return `${toolName} needs a ${pathKey}.`;
    return resolveInside(root, p) ? undefined : outside(p);
  }

  if (toolName === "Glob" || toolName === "Grep") {
    const dir = input.path;
    if (typeof dir === "string" && dir && !resolveInside(root, dir)) return outside(dir);
    const pattern = toolName === "Glob" ? input.pattern : input.glob;
    if (typeof pattern === "string" && pattern) {
      if (hasParentSegment(pattern)) return `Patterns may not contain "..": ${pattern}`;
      if (path.isAbsolute(pattern) && !resolveInside(root, pattern)) return outside(pattern);
    }
  }
  return undefined;
}

/** PreToolUse hook that denies out-of-workspace file access, and writes to the paths `options.readOnly` names. Runs before permission rules. */
export function workspaceGuard(root: string, options: GuardOptions = {}): HookCallbackMatcher {
  return {
    hooks: [
      async (input) => {
        if (input.hook_event_name !== "PreToolUse") return {};
        const reason = checkToolInput(root, input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>, options);
        if (!reason) return {};
        log.warn(`denied ${input.tool_name}${input.agent_id ? ` in subagent ${input.agent_type ?? input.agent_id}` : ""}: ${reason}`);
        return {
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
        };
      },
    ],
  };
}
