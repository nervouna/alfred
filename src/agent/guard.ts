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

/** Returns a denial reason when a tool call would touch anything outside `root`. */
export function checkToolInput(root: string, toolName: string, input: Record<string, unknown>): string | undefined {
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

/** PreToolUse hook that denies out-of-workspace file access. Runs before permission rules. */
export function workspaceGuard(root: string): HookCallbackMatcher {
  return {
    hooks: [
      async (input) => {
        if (input.hook_event_name !== "PreToolUse") return {};
        const reason = checkToolInput(root, input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
        if (!reason) return {};
        log.warn(`denied ${input.tool_name}: ${reason}`);
        return {
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
        };
      },
    ],
  };
}
