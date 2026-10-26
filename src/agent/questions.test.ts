import assert from "node:assert/strict";
import { test } from "node:test";

import type { HookInput } from "@anthropic-ai/claude-agent-sdk";

import type { Question } from "../api/schema.ts";
import { QUESTION_STOPPED, QUESTION_TOOL, SUBAGENT_QUESTION_DENIAL, answersFromReply, parseQuestionInput, questionHook } from "./questions.ts";
import type { QuestionOutcome } from "./questions.ts";

const FORMAT: Question = {
  question: "报告用哪种格式？",
  header: "报告格式",
  options: [
    { label: "短表格", description: "一张对比表" },
    { label: "长文章", description: "完整分析" },
  ],
  multiSelect: false,
};
const VENDORS: Question = {
  question: "要对比哪些供应商？",
  header: "供应商",
  options: [
    { label: "Hetzner", description: "欧洲，价格最低" },
    { label: "Vultr", description: "" },
    { label: "DigitalOcean", description: "文档好" },
  ],
  multiSelect: true,
};

test("a plain message answers a question with its text, trimmed, and a number is not read as an option", () => {
  assert.deepEqual(answersFromReply("  都行，你定  ", [FORMAT]), { [FORMAT.question]: "都行，你定" });
  assert.deepEqual(answersFromReply("2", [FORMAT]), { [FORMAT.question]: "2" });
  assert.deepEqual(answersFromReply("1 3", [VENDORS]), { [VENDORS.question]: "1 3" });
  assert.deepEqual(answersFromReply("长文章", [FORMAT]), { [FORMAT.question]: "长文章" });
});

test("with several questions the text is given as the answer to each of them", () => {
  assert.deepEqual(answersFromReply("1", [FORMAT, VENDORS]), { [FORMAT.question]: "1", [VENDORS.question]: "1" });
  assert.deepEqual(answersFromReply("都按默认", [FORMAT, VENDORS]), { [FORMAT.question]: "都按默认", [VENDORS.question]: "都按默认" });
});

test("the tool's input is read as the contract's questions; a preview is dropped and a missing multiSelect is false", () => {
  const input = {
    questions: [{ question: "q?", header: "h", options: [{ label: "a", description: "x", preview: "<b>" }, { label: "b", description: "y" }] }],
  };
  assert.deepEqual(parseQuestionInput(input), {
    ok: true,
    questions: [{ question: "q?", header: "h", options: [{ label: "a", description: "x" }, { label: "b", description: "y" }], multiSelect: false }],
  });
});

test("input that is not one to four questions of two to four options, or that repeats a question, is refused with a reason", () => {
  assert.equal(parseQuestionInput({}).ok, false);
  assert.equal(parseQuestionInput({ questions: [] }).ok, false);
  assert.equal(parseQuestionInput({ questions: [{ ...FORMAT, options: [FORMAT.options[0]] }] }).ok, false);
  assert.equal(parseQuestionInput({ questions: Array.from({ length: 5 }, (_, i) => ({ ...FORMAT, question: `q${i}?` })) }).ok, false);
  const repeated = parseQuestionInput({ questions: [FORMAT, FORMAT] });
  assert.equal(repeated.ok, false);
  assert.match(repeated.ok ? "" : repeated.error, /different/);
});

function preToolUse(over: Record<string, unknown> = {}): HookInput {
  return {
    hook_event_name: "PreToolUse",
    session_id: "s",
    transcript_path: "/dev/null",
    cwd: "/",
    tool_name: QUESTION_TOOL,
    tool_input: { questions: [FORMAT] },
    tool_use_id: "toolu_1",
    ...over,
  } as HookInput;
}

interface Decided {
  hookEventName: string;
  permissionDecision?: string;
  permissionDecisionReason?: string;
  updatedInput?: unknown;
}

async function decide(ask: (q: Question[], signal: AbortSignal) => Promise<QuestionOutcome>, input: HookInput, signal = new AbortController().signal) {
  const matcher = questionHook(ask);
  const hook = matcher.hooks[0];
  assert.ok(hook);
  const out = await hook(input, "toolu_1", { signal });
  return "hookSpecificOutput" in out ? (out.hookSpecificOutput as Decided | undefined) : undefined;
}

test("the hook allows the call with the answers added to the tool's input, and waits for longer than a day", async () => {
  assert.ok((questionHook(async () => ({ cancelled: true })).timeout ?? 0) > 86_400, "a question waits as long as the owner takes");
  const seen: Question[][] = [];
  const out = await decide(async (questions) => (seen.push(questions), { answers: { [FORMAT.question]: "长文章" } }), preToolUse());
  assert.deepEqual(seen, [[FORMAT]]);
  assert.deepEqual(out, {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    updatedInput: { questions: [FORMAT], answers: { [FORMAT.question]: "长文章" } },
  });
});

test("the hook denies a cancelled question with the reason the agent is given", async () => {
  const out = await decide(async () => ({ cancelled: true }), preToolUse());
  assert.deepEqual(out, { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: QUESTION_STOPPED });
  assert.equal(QUESTION_STOPPED, "The user stopped the run");
});

test("the hook hands the call's abort signal to the asker", async () => {
  const abort = new AbortController();
  let seen: AbortSignal | undefined;
  await decide(async (_q, signal) => ((seen = signal), { cancelled: true }), preToolUse(), abort.signal);
  assert.equal(seen, abort.signal);
});

test("a subagent's call is denied at once, without asking, and the reason tells it to go through the main agent", async () => {
  let asked = 0;
  const out = await decide(async () => (asked++, { cancelled: true }), preToolUse({ agent_id: "agent-1", agent_type: "general-purpose" }));
  assert.equal(asked, 0);
  assert.deepEqual(out, { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: SUBAGENT_QUESTION_DENIAL });
  assert.match(SUBAGENT_QUESTION_DENIAL, /Tell the main agent what you need to know/);
  assert.match(SUBAGENT_QUESTION_DENIAL, /it will ask/);
});

test("input that does not fit is denied with the reason, and other tools and events are left alone", async () => {
  let asked = 0;
  const ask = async () => (asked++, { cancelled: true as const });
  const bad = await decide(ask, preToolUse({ tool_input: { questions: [] } }));
  assert.equal(bad?.permissionDecision, "deny");
  assert.match(bad?.permissionDecisionReason ?? "", /AskUserQuestion/);
  assert.equal(await decide(ask, preToolUse({ tool_name: "Read", tool_input: { file_path: "a.md" } })), undefined);
  assert.equal(await decide(ask, preToolUse({ hook_event_name: "PostToolUse" })), undefined);
  assert.equal(asked, 0);
});
