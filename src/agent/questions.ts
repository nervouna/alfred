// Structured questions: the SDK's AskUserQuestion tool, answered by the owner.
//
// The tool has no answer of its own in a headless run: under dontAsk the CLI denies it before canUseTool
// is ever asked (and the CLI offers the tool only when a canUseTool is set at all: see denyPermissionPrompts).
// So the main agent's call is held in a PreToolUse hook, which allows it with the owner's
// answers added to its input (the way the tool's own UI hands them over) or denies it when the question is
// cancelled. A subagent's call is denied at once: only Alfred talks to the owner. The handler owns the
// open questions (handler.ts); this module has the hook and how a plain message answers.

import type { CanUseTool, HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { QuestionSchema } from "../api/schema.ts";
import type { Question } from "../api/schema.ts";
import { log } from "../log.ts";

export const QUESTION_TOOL = "AskUserQuestion";
/** What the agent is told when a stop cancelled its question. */
export const QUESTION_STOPPED = "The user stopped the run";
export const SUBAGENT_QUESTION_DENIAL =
  "Subagents may not ask the user: only Alfred talks to the user. Tell the main agent what you need to know in your final message, and it will ask.";
/** How long the hook may wait for the owner: a week, which is no limit in practice (the SDK's default would cut a question off). */
export const QUESTION_HOOK_TIMEOUT_SECONDS = 7 * 24 * 3600;

/** How a question ends: with the owner's answers by question text, or cancelled by a stop. */
export type QuestionOutcome = { answers: Record<string, string> } | { cancelled: true };

/** Holds a question until the owner answers it or it is cancelled; `signal` aborts when the tool call is interrupted. */
export type AskOwner = (questions: Question[], signal: AbortSignal) => Promise<QuestionOutcome>;

// The tool's input as the contract has it. A missing multiSelect is a single-select question, and an option's preview is dropped.
const ToolInputSchema = z.object({
  questions: z
    .array(QuestionSchema.extend({ multiSelect: z.boolean().default(false) }))
    .min(1, "must have at least 1 question")
    .max(4, "must have at most 4 questions"),
});

export type ParsedQuestions = { ok: true; questions: Question[] } | { ok: false; error: string };

/** The questions in the AskUserQuestion input, or why it does not fit. Answers are keyed by a question's text, so the texts must differ. */
export function parseQuestionInput(input: unknown): ParsedQuestions {
  const parsed = ToolInputSchema.safeParse(input);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const where = issue && issue.path.length > 0 ? `${issue.path.map(String).join(".")}: ` : "";
    return { ok: false, error: `${where}${issue?.message ?? "invalid input"}` };
  }
  const { questions } = parsed.data;
  if (new Set(questions.map((q) => q.question)).size !== questions.length) {
    return { ok: false, error: "the text of each question must be different, because answers are keyed by it" };
  }
  return { ok: true, questions };
}

/** The answers a plain message gives: its text, trimmed, is the free-text answer to each question. */
export function answersFromReply(reply: string, questions: Question[]): Record<string, string> {
  const text = reply.trim();
  return Object.fromEntries(questions.map((q) => [q.question, text]));
}

/**
 * canUseTool for runs that can ask. It never decides anything: without one the CLI says AskUserQuestion is
 * disabled, and that is its only job. dontAsk denies what it does not allow before the callback is asked, and the
 * hook answers AskUserQuestion, so if it is ever asked something has gone around both, and it denies.
 */
export const denyPermissionPrompts: CanUseTool = async (toolName) => {
  log.warn(`${toolName} reached canUseTool: denied, since Alfred grants no permission by prompt`);
  return { behavior: "deny", message: `${toolName} is not allowed.` };
};

function decision(permissionDecision: "allow" | "deny", rest: { permissionDecisionReason?: string; updatedInput?: Record<string, unknown> }) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision, ...rest } };
}

/**
 * PreToolUse hook for the AskUserQuestion tool. The main agent's call waits in `ask` for the owner, however long
 * that takes, and is allowed with the answers or denied when cancelled. A subagent's call, and input that does not
 * fit the tool, are denied with a reason the agent can act on.
 */
export function questionHook(ask: AskOwner): HookCallbackMatcher {
  return {
    timeout: QUESTION_HOOK_TIMEOUT_SECONDS,
    hooks: [
      async (input, _toolUseId, { signal }) => {
        if (input.hook_event_name !== "PreToolUse" || input.tool_name !== QUESTION_TOOL) return {};
        if (input.agent_id) {
          log.warn(`denied ${QUESTION_TOOL} in subagent ${input.agent_type ?? input.agent_id}: only Alfred asks`);
          return decision("deny", { permissionDecisionReason: SUBAGENT_QUESTION_DENIAL });
        }
        const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
        const parsed = parseQuestionInput(toolInput);
        if (!parsed.ok) {
          log.warn(`denied ${QUESTION_TOOL}: ${parsed.error}`);
          return decision("deny", { permissionDecisionReason: `${QUESTION_TOOL} input is invalid: ${parsed.error}.` });
        }
        const outcome = await ask(parsed.questions, signal);
        if ("cancelled" in outcome) return decision("deny", { permissionDecisionReason: QUESTION_STOPPED });
        return decision("allow", { updatedInput: { ...toolInput, answers: outcome.answers } });
      },
    ],
  };
}
