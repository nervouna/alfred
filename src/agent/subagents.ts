// Subagent guard rails and tracking. Which agent type or model an Agent call
// uses follows the SDK; this module enforces the boundaries on every call
// instead: the task admits or queues background calls (background.ts), nested
// ones included, and every subagent (roles, built-in agent types, plugin agents,
// forked skills) gets the shared rules and stays away from memory, skills,
// workspace rules and the user. It also follows which foreground subagents run.

import type { HookCallbackMatcher, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { log } from "../log.ts";
import { SUBAGENT_RULES } from "./config.ts";
import { readOnlyWrite } from "./guard.ts";
import type { ReadOnlyPaths } from "./guard.ts";
import { RULES_FILE } from "./rules.ts";
import { SKILLS_DIR } from "./skills.ts";
import { TASK_TOOL_NAMES } from "./task-tools.ts";

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

/**
 * The say on Agent calls of a run nobody watches (a scheduled task): foreground subagents work as in chat, but the
 * run ends with its report and would cut a background subagent short, so those are denied with a reason the
 * agent can act on.
 */
export const unattendedAdmission: AgentAdmission = {
  admit: (call) =>
    call.background
      ? "This run is unattended, so background subagents are not available. Call the Agent tool again with run_in_background: false and wait for the result."
      : undefined,
  failedToStart() {},
};

/** What only Alfred's main thread changes, and only when the owner asks: long-term memory, skills and the workspace rules files. */
export const PROTECTED_PATHS: ReadOnlyPaths = { dirs: ["memory", SKILLS_DIR], names: [RULES_FILE] };

/** Returns a denial reason when a subagent's tool call would change long-term memory, a skill or a workspace rules file. */
export function checkSubagentWrite(root: string, toolName: string, input: Record<string, unknown>): string | undefined {
  const p = readOnlyWrite(root, toolName, input, PROTECTED_PATHS);
  if (p === undefined) return undefined;
  return `Subagents may not change ${p}: only Alfred changes memory/, ${SKILLS_DIR}/ and ${RULES_FILE} files. Report what should change in your final message instead.`;
}

function deny(reason: string) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason } };
}

/**
 * Returns a denial reason when a subagent calls send_file or a task tool: only Alfred talks to the user, and
 * only Alfred manages the owner's tasks, with the owner's tap. A role's tool list already leaves them out, but
 * built-in agent types and forked skills get every tool the main thread has.
 */
export function checkSubagentTool(toolName: string): string | undefined {
  if (toolName === SEND_FILE_TOOL) return "Subagents may not send files: only Alfred talks to the user. Name the file in your final message instead.";
  if (TASK_TOOL_NAMES.includes(toolName)) {
    return "Subagents may not manage the owner's tasks: only Alfred does, and only when the owner asks. Do not try again; leave it out of your work.";
  }
  return undefined;
}

/** PreToolUse hook: admits or queues Agent calls from any thread, and denies subagents send_file, the task tools and writes to memory, skills and rules. */
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
