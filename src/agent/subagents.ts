// Subagent guard rails and tracking. Roles are defined in config.ts; this
// module keeps the role the only lever on an Agent call, lets the task admit or
// queue background calls (background.ts), keeps every subagent (roles, built-in
// agent types, forked skills) away from memory, skills, workspace rules and the
// user, and follows which foreground subagents are running.

import fs from "node:fs";
import path from "node:path";

import type { HookCallbackMatcher, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { log } from "../log.ts";
import { SUBAGENT_DISALLOWED_TOOLS, SUBAGENT_ROLES, isSubagentRole } from "./config.ts";
import type { SubagentRoleName } from "./config.ts";
import { resolveInside } from "./guard.ts";
import { RULES_FILE } from "./rules.ts";
import { SKILLS_DIR } from "./skills.ts";

const AGENT_TOOL = "Agent";

/**
 * The input an Agent call runs with, or a denial reason. The call must name a
 * role. Everything that would override the role (model, effort) or reach past
 * the task (names other agents could message, worktrees) is dropped. Calls run
 * in the background unless they ask for the foreground, as the SDK's default.
 */
export function checkAgentCall(input: Record<string, unknown>): { deny: string } | { input: Record<string, unknown> } {
  const role = input.subagent_type;
  if (!isSubagentRole(role)) {
    return { deny: `subagent_type must be one of ${Object.keys(SUBAGENT_ROLES).join(", ")}; got ${JSON.stringify(role ?? null)}.` };
  }
  return {
    input: { description: input.description, prompt: input.prompt, subagent_type: role, run_in_background: input.run_in_background !== false },
  };
}

/** An Agent call the main thread makes, after checkAgentCall. */
export interface AgentCall {
  toolUseId: string;
  role: SubagentRoleName;
  description: string;
  prompt: string;
  background: boolean;
}

/** The task's say on Agent calls: undefined lets one start, a reason denies it (and is relayed to the agent). */
export interface AgentAdmission {
  admit(call: AgentCall): string | undefined;
  failedToStart(toolUseId: string, error: string): void;
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

/** Top-level workspace directories only Alfred's main thread changes. */
const PROTECTED_DIRS = new Set(["memory", SKILLS_DIR]);

/** Returns a denial reason when a subagent's tool call would change long-term memory, a skill or a workspace rules file. */
export function checkSubagentWrite(root: string, toolName: string, input: Record<string, unknown>): string | undefined {
  const rootReal = fs.realpathSync(root);
  for (const key of WRITE_PATHS[toolName] ?? []) {
    const p = input[key];
    if (typeof p !== "string" || !p) continue;
    const real = resolveInside(root, p);
    if (!real) continue; // The workspace guard refuses paths outside the workspace.
    const rel = path.relative(rootReal, real);
    const top = rel.split(path.sep)[0]?.toLowerCase();
    if ((top && PROTECTED_DIRS.has(top)) || path.basename(rel).toLowerCase() === RULES_FILE.toLowerCase()) {
      return `Subagents may not change ${p}: only Alfred changes memory/, ${SKILLS_DIR}/ and ${RULES_FILE} files. Report what should change in your final message instead.`;
    }
  }
  return undefined;
}

function deny(reason: string) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason } };
}

/**
 * Returns a denial reason when a subagent calls a tool only Alfred may use. A
 * role's disallowedTools already hide them, but built-in agent types and forked
 * skills get every tool the main thread has.
 */
export function checkSubagentTool(toolName: string): string | undefined {
  if (!SUBAGENT_DISALLOWED_TOOLS.includes(toolName)) return undefined;
  return `Subagents may not call ${toolName}: only Alfred sends files to the user and starts or stops subagents. Say what you need in your final message instead.`;
}

/** PreToolUse hook: rewrites, admits or denies Agent calls, and denies subagents Alfred's own tools and writes to memory, skills and rules. */
export function subagentGuard(root: string, admission?: AgentAdmission): HookCallbackMatcher {
  return {
    hooks: [
      async (input) => {
        if (input.hook_event_name !== "PreToolUse") return {};
        const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
        if (input.agent_id) {
          const reason = checkSubagentTool(input.tool_name) ?? checkSubagentWrite(root, input.tool_name, toolInput);
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
        const call = checked.input;
        const refused = admission?.admit({
          toolUseId: input.tool_use_id,
          role: call.subagent_type as SubagentRoleName,
          description: String(call.description ?? ""),
          prompt: String(call.prompt ?? ""),
          background: call.run_in_background === true,
        });
        if (refused) {
          log.info(`Agent call not started: ${refused}`);
          return deny(refused);
        }
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: call } };
      },
    ],
  };
}

/** PostToolUseFailure hook: an admitted Agent call that failed frees what admit() reserved. */
export function agentFailureHook(admission: AgentAdmission): HookCallbackMatcher {
  return {
    hooks: [
      async (input) => {
        if (input.hook_event_name === "PostToolUseFailure" && input.tool_name === AGENT_TOOL && !input.agent_id) {
          admission.failedToStart(input.tool_use_id, input.error);
        }
        return {};
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

  /** Role of the subagent started by the Agent call `toolUseId`, while it runs. */
  roleOf(toolUseId: string): string | undefined {
    return this.live.get(toolUseId)?.role;
  }
}
