// Subagent guard rails and tracking. Roles are defined in config.ts; this
// module keeps the role the only lever on an Agent call, keeps subagents away
// from memory and workspace rules, and follows which subagents are running.

import fs from "node:fs";
import path from "node:path";

import type { HookCallbackMatcher, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { log } from "../log.ts";
import { SUBAGENT_ROLES, isSubagentRole } from "./config.ts";
import { resolveInside } from "./guard.ts";
import { RULES_FILE } from "./rules.ts";

const AGENT_TOOL = "Agent";

/**
 * The input an Agent call runs with, or a denial reason. The call must name a
 * role. Everything that would override the role (model, effort) or outlive the
 * task (background runs, names other agents could message) is dropped.
 */
export function checkAgentCall(input: Record<string, unknown>): { deny: string } | { input: Record<string, unknown> } {
  const role = input.subagent_type;
  if (!isSubagentRole(role)) {
    return { deny: `subagent_type must be one of ${Object.keys(SUBAGENT_ROLES).join(", ")}; got ${JSON.stringify(role ?? null)}.` };
  }
  return { input: { description: input.description, prompt: input.prompt, subagent_type: role, run_in_background: false } };
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

/** Returns a denial reason when a subagent's tool call would change long-term memory or a workspace rules file. */
export function checkSubagentWrite(root: string, toolName: string, input: Record<string, unknown>): string | undefined {
  const rootReal = fs.realpathSync(root);
  for (const key of WRITE_PATHS[toolName] ?? []) {
    const p = input[key];
    if (typeof p !== "string" || !p) continue;
    const real = resolveInside(root, p);
    if (!real) continue; // The workspace guard refuses paths outside the workspace.
    const rel = path.relative(rootReal, real);
    const top = rel.split(path.sep)[0]?.toLowerCase();
    if (top === "memory" || path.basename(rel).toLowerCase() === RULES_FILE.toLowerCase()) {
      return `Subagents may not change ${p}: only Alfred changes memory/ and ${RULES_FILE} files. Report what should change in your final message instead.`;
    }
  }
  return undefined;
}

function deny(reason: string) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason } };
}

/** PreToolUse hook: rewrites or denies Agent calls, and denies subagent writes to memory and rules. */
export function subagentGuard(root: string): HookCallbackMatcher {
  return {
    hooks: [
      async (input) => {
        if (input.hook_event_name !== "PreToolUse") return {};
        const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
        if (input.agent_id) {
          const reason = checkSubagentWrite(root, input.tool_name, toolInput);
          if (!reason) return {};
          log.warn(`denied ${input.tool_name} in subagent ${input.agent_type ?? input.agent_id}: ${reason}`);
          return deny(reason);
        }
        if (input.tool_name !== AGENT_TOOL) return {};
        const checked = checkAgentCall(toolInput);
        if ("deny" in checked) {
          log.warn(`denied Agent call: ${checked.deny}`);
          return deny(checked.deny);
        }
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: checked.input } };
      },
    ],
  };
}

export interface LiveSubagent {
  role: string;
  description: string;
  startedAt: number;
}

/** Follows a query's messages to know which subagents run: an Agent call in the main thread starts one, its tool result ends it. */
export class SubagentTracker {
  private readonly live = new Map<string, LiveSubagent>();

  observe(m: SDKMessage, now = Date.now()): void {
    if (m.type === "result") {
      // Subagents run in the foreground, so none outlives the turn; a turn cut short (spend cap, max turns) leaves no result for its Agent call.
      this.live.clear();
    } else if (m.type === "assistant" && m.parent_tool_use_id === null) {
      for (const block of m.message.content) {
        if (block.type !== "tool_use" || block.name !== AGENT_TOOL) continue;
        const input = (block.input ?? {}) as Record<string, unknown>;
        this.live.set(block.id, { role: String(input.subagent_type ?? "?"), description: String(input.description ?? ""), startedAt: now });
      }
    } else if (m.type === "user" && m.parent_tool_use_id === null && Array.isArray(m.message.content)) {
      for (const block of m.message.content) {
        if (block.type === "tool_result") this.live.delete(block.tool_use_id);
      }
    }
  }

  get running(): LiveSubagent[] {
    return [...this.live.values()];
  }
}
