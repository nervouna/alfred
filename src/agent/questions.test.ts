import assert from "node:assert/strict";
import { test } from "node:test";

import type { HookInput } from "@anthropic-ai/claude-agent-sdk";

import type { Question } from "../api/schema.ts";
import { QUESTION_STOPPED, QUESTION_TOOL, SUBAGENT_QUESTION_DENIAL, answersFromReply, parseQuestionInput, questionHook, questionText } from "./questions.ts";
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

test("one question is its header and text, a numbered line per option, and how to answer", () => {
  assert.equal(
    questionText([FORMAT]),
    ["【报告格式】报告用哪种格式？", "1. 短表格：一张对比表", "2. 长文章：完整分析", "回复编号或直接打字回答。"].join("\n"),
  );
});

test("a multi-select question says several numbers may be sent, and an option without a description is a bare label", () => {
  assert.equal(
    questionText([VENDORS]),
    ["【供应商】要对比哪些供应商？", "1. Hetzner：欧洲，价格最低", "2. Vultr", "3. DigitalOcean：文档好", "可以回复多个编号，用空格分开。"].join("\n"),
  );
});

test("several questions are numbered blocks, answered together by one message", () => {
  assert.equal(
    questionText([FORMAT, VENDORS]),
    [
      "问题 1/2",
      "【报告格式】报告用哪种格式？",
      "1. 短表格：一张对比表",
      "2. 长文章：完整分析",
      "",
      "问题 2/2",
      "【供应商】要对比哪些供应商？",
      "1. Hetzner：欧洲，价格最低",
      "2. Vultr",
      "3. DigitalOcean：文档好",
      "",
      "直接打字回答，这一条消息会作为所有问题的答案。",
    ].join("\n"),
  );
});

test("with one question, a reply of only option numbers is the labels of those options", () => {
  assert.deepEqual(answersFromReply("2", [FORMAT]), { [FORMAT.question]: "长文章" });
  assert.deepEqual(answersFromReply(" 1\n", [FORMAT]), { [FORMAT.question]: "短表格" });
  assert.deepEqual(answersFromReply("２", [FORMAT]), { [FORMAT.question]: "长文章" }, "a full-width digit");
  assert.deepEqual(answersFromReply("1 3", [VENDORS]), { [VENDORS.question]: "Hetzner, DigitalOcean" }, "joined with a comma and a space");
  assert.deepEqual(answersFromReply("3,1", [VENDORS]), { [VENDORS.question]: "DigitalOcean, Hetzner" }, "in the order given");
  assert.deepEqual(answersFromReply("1，2、3", [VENDORS]), { [VENDORS.question]: "Hetzner, Vultr, DigitalOcean" });
  assert.deepEqual(answersFromReply("2 2", [VENDORS]), { [VENDORS.question]: "Vultr" }, "a number given twice counts once");
  assert.deepEqual(answersFromReply("2", [VENDORS]), { [VENDORS.question]: "Vultr" }, "one number on a multi-select question");
});

test("anything else is free text: several numbers on a single-select question, a number with no option, words", () => {
  assert.deepEqual(answersFromReply("1 2", [FORMAT]), { [FORMAT.question]: "1 2" });
  assert.deepEqual(answersFromReply("3", [FORMAT]), { [FORMAT.question]: "3" }, "only two options");
  assert.deepEqual(answersFromReply("0", [FORMAT]), { [FORMAT.question]: "0" });
  assert.deepEqual(answersFromReply("1 5", [VENDORS]), { [VENDORS.question]: "1 5" }, "one number is no option");
  assert.deepEqual(answersFromReply("选 1", [FORMAT]), { [FORMAT.question]: "选 1" });
  assert.deepEqual(answersFromReply("  都行，你定  ", [FORMAT]), { [FORMAT.question]: "都行，你定" }, "trimmed");
  assert.deepEqual(answersFromReply("1.5", [FORMAT]), { [FORMAT.question]: "1.5" });
});

test("with several questions the reply is free text, given as the answer to each of them", () => {
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
