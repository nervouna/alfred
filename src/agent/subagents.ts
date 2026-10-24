// Subagent guard rails and tracking. Which agent type or model an Agent call
// uses follows the SDK; this module enforces the boundaries on every call
// instead: the task admits or queues background calls (background.ts), nested
// ones included, and every subagent (roles, built-in agent types, plugin agents,
// forked skills) gets the shared rules and stays away from memory, skills,
// workspace rules and the user. It also follows which foreground subagents run.

import fs from "node:fs";
import path from "node:path";

import type { HookCallbackMatcher, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { log } from "../log.ts";
import { SUBAGENT_RULES } from "./config.ts";
import { resolveInside } from "./guard.ts";
import { RULES_FILE } from "./rules.ts";
import { SKILLS_DIR } from "./skills.ts";

const AGENT_TOOL = "Agent";
const SEND_FILE_TOOL = "mcp__alfred__send_file";
/** The agent type the SDK uses for an Agent call that names none. */
export const DEFAULT_AGENT_TYPE = "general-purpose";

/**
 * The input an Agent call runs with: as the agent wrote it, with the background
 * made explicit (the SDK's default), so admission knows which calls take a slot.
 */
export function checkAgentCall(input: Record<string, unknown>): Record<string, unknown> {
  return { ...input, run_in_background: input.run_in_background !== false };
}

/** An Agent call from the main thread or a subagent, after checkAgentCall. */
export interface AgentCall {
  toolUseId: string;
  /** The agent type: a role, a built-in type or a plugin's. */
  role: string;
  /** The model the call asks for, overriding its type's default. */
  model?: string;
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
 * Returns a denial reason when a subagent calls send_file: only Alfred talks to
 * the user. A role's disallowedTools already hide it, but built-in agent types
 * and forked skills get every tool the main thread has.
 */
export function checkSubagentTool(toolName: string): string | undefined {
  if (toolName !== SEND_FILE_TOOL) return undefined;
  return "Subagents may not send files: only Alfred talks to the user. Name the file in your final message instead.";
}

/** PreToolUse hook: admits or queues Agent calls from any thread, and denies subagents send_file and writes to memory, skills and rules. */
export function subagentGuard(root: string, admission?: AgentAdmission): HookCallbackMatcher {
  return {
    hooks: [
      async (input) => {
        if (input.hook_event_name !== "PreToolUse") return {};
        const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
        if (input.agent_id) {
          const reason = checkSubagentTool(input.tool_name) ?? checkSubagentWrite(root, input.tool_name, toolInput);
          if (reason) {
            log.warn(`denied ${input.tool_name} in subagent ${input.agent_type ?? input.agent_id}: ${reason}`);
            return deny(reason);
          }
        }
        if (input.tool_name !== AGENT_TOOL) return {};
        const call = checkAgentCall(toolInput);
        const refused = admission?.admit({
          toolUseId: input.tool_use_id,
          role: typeof call.subagent_type === "string" && call.subagent_type ? call.subagent_type : DEFAULT_AGENT_TYPE,
          model: typeof call.model === "string" && call.model ? call.model : undefined,
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
        if (input.hook_event_name === "PostToolUseFailure" && input.tool_name === AGENT_TOOL) {
          admission.failedToStart(input.tool_use_id, input.error);
        }
        return {};
      },
    ],
  };
}

/** SubagentStart hook: every subagent, whatever its type or however it started, gets the shared subagent rules. */
export function subagentRulesHook(): HookCallbackMatcher {
  return {
    hooks: [
      async (input) => {
        if (input.hook_event_name !== "SubagentStart") return {};
        return { hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: SUBAGENT_RULES } };
      },
    ],
  };
}

export interface LiveSubagent {
  role: string;
  description: string;
  startedAt: number;
  /** The tool call that started it: an Agent call, or the Skill call of a forked skill. */
  toolUseId?: string;
}

/**
 * Follows the SDK's task messages to know which foreground subagents run,
 * forked skills included. Background ones are BackgroundRuns' business.
 */
export class SubagentTracker {
  private readonly live = new Map<string, LiveSubagent>();

  observe(m: SDKMessage, now = Date.now()): void {
    if (m.type === "result") {
      // Foreground subagents never outlive the turn; a turn cut short (spend cap, max turns) may leave no notification.
      this.live.clear();
    } else if (m.type === "system" && m.subtype === "task_started") {
      if (m.is_backgrounded || (m.task_type !== undefined && m.task_type !== "local_agent")) return;
      this.live.set(m.task_id, { role: m.subagent_type ?? DEFAULT_AGENT_TYPE, description: m.description, startedAt: now, toolUseId: m.tool_use_id });
    } else if (m.type === "system" && m.subtype === "task_updated") {
      if (m.patch.is_backgrounded) this.live.delete(m.task_id);
    } else if (m.type === "system" && m.subtype === "task_notification") {
      this.live.delete(m.task_id);
    }
  }

  get running(): LiveSubagent[] {
    return [...this.live.values()];
  }

  /** Type of the foreground subagent started by the tool call `toolUseId`, while it runs. */
  roleOf(toolUseId: string): string | undefined {
    for (const s of this.live.values()) if (s.toolUseId === toolUseId) return s.role;
    return undefined;
  }
}
