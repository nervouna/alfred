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
};

/** Input fields that name a path a tool call reads without writing it, beyond PATH_TOOLS. */
const READ_PATHS: Record<string, string[]> = {
  mcp__alfred__send_file: ["path"],
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

export interface GuardOptions {
  /** Every tool call that writes here is denied, whoever makes it: the run's own thread or a subagent. */
  readOnly?: ReadOnlyPaths;
}

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
  return named;
}

/** The path, as the call spelled it, where a tool call would write inside `readOnly`; undefined when it writes nowhere there. */
export function readOnlyWrite(root: string, toolName: string, input: Record<string, unknown>, readOnly: ReadOnlyPaths): string | undefined {
  const rootReal = fs.realpathSync(root);
  const dirs = readOnly.dirs.map((dir) => dir.toLowerCase());
  const names = readOnly.names.map((name) => name.toLowerCase());
  for (const p of writtenPaths(toolName, input)) {
    const real = resolveInside(root, p);
    if (!real) continue; // The workspace check refuses paths outside the workspace.
    const rel = path.relative(rootReal, real);
    const top = rel.split(path.sep)[0]?.toLowerCase();
    if ((top && dirs.includes(top)) || names.includes(path.basename(rel).toLowerCase())) return p;
  }
  return undefined;
}

/** Returns a denial reason when a tool call would touch anything outside `root`, a `.git` path, or write to a path `options.readOnly` names. */
export function checkToolInput(root: string, toolName: string, input: Record<string, unknown>, options: GuardOptions = {}): string | undefined {
  return gitDirReason(toolName, input) ?? checkWorkspace(root, toolName, input) ?? checkReadOnly(root, toolName, input, options.readOnly);
}

function checkReadOnly(root: string, toolName: string, input: Record<string, unknown>, readOnly: ReadOnlyPaths | undefined): string | undefined {
  if (!readOnly) return undefined;
  const p = readOnlyWrite(root, toolName, input, readOnly);
  if (p === undefined) return undefined;
  const places = [...readOnly.dirs.map((dir) => `${dir}/`), ...readOnly.names.map((name) => `${name} files`)];
  return `${p} is read-only in this run: ${places.join(", ")} may be read but not changed. Say in your final message what should change instead.`;
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
