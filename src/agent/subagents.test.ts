import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { HookInput, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { SUBAGENT_RULES } from "./config.ts";
import { SubagentTracker, checkAgentCall, checkSubagentTool, checkSubagentWrite, subagentGuard, subagentRulesHook } from "./subagents.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-subagents-")));
fs.mkdirSync(path.join(root, "memory"));
fs.mkdirSync(path.join(root, "reports"));
fs.mkdirSync(path.join(root, "skills"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

test("checkAgentCall passes any agent type, model and option through and runs in the background by default", () => {
  const call = {
    description: "VPS 价格对比",
    prompt: "Compare ...",
    subagent_type: "general-purpose",
    model: "opus",
    effort: "max",
    name: "vps",
    isolation: "worktree",
  };
  assert.deepEqual(checkAgentCall(call), { ...call, run_in_background: true });
  assert.deepEqual(checkAgentCall({ description: "d", prompt: "p" }), { description: "d", prompt: "p", run_in_background: true }, "no type named");
  const fg = checkAgentCall({ description: "d", prompt: "p", subagent_type: "collector", run_in_background: false });
  assert.equal(fg.run_in_background, false, "the foreground when asked for");
});

test("checkSubagentWrite refuses memory/, skills/ and every ALFRED.md, and allows other workspace paths", () => {
  const denied: [string, Record<string, unknown>][] = [
    ["Write", { file_path: "memory/user.md" }],
    ["Edit", { file_path: path.join(root, "memory", "MEMORY.md") }],
    ["Write", { file_path: "memory" }],
    ["Write", { file_path: "ALFRED.md" }],
    ["Edit", { file_path: "reports/ALFRED.md" }],
    ["Write", { file_path: "reports/alfred.md" }],
    ["mcp__alfred__move_file", { from: "notes/a.md", to: "memory/a.md" }],
    ["mcp__alfred__render_pdf", { source: "reports/a.md", output: "memory/a.pdf" }],
    ["mcp__alfred__generate_image", { prompt: "x", output: "memory/x.jpg" }],
    ["Write", { file_path: "skills/weekly/SKILL.md" }],
    ["Edit", { file_path: path.join(root, "skills", "weekly", "template.html") }],
    ["mcp__alfred__move_file", { from: "skills/weekly", to: ".trash/weekly" }],
  ];
  for (const [tool, input] of denied) {
    assert.match(checkSubagentWrite(root, tool, input) ?? "", /only Alfred changes/, `${tool} ${JSON.stringify(input)}`);
  }
  assert.equal(checkSubagentWrite(root, "Write", { file_path: "reports/2026-10-25/vps.md" }), undefined);
  assert.equal(checkSubagentWrite(root, "Write", { file_path: "notes/memory.md" }), undefined);
  assert.equal(checkSubagentWrite(root, "Write", { file_path: "notes/skills/SKILL.md" }), undefined);
  assert.equal(checkSubagentWrite(root, "Read", { file_path: "memory/user.md" }), undefined, "reading memory is fine");
});

function preToolUse(tool_name: string, tool_input: Record<string, unknown>, agent?: { id: string; type: string }): HookInput {
  return {
    hook_event_name: "PreToolUse",
    session_id: "s",
    transcript_path: "/dev/null",
    cwd: root,
    tool_name,
    tool_input,
    tool_use_id: "toolu_1",
    ...(agent ? { agent_id: agent.id, agent_type: agent.type } : {}),
  };
}

async function decide(input: HookInput) {
  const hook = subagentGuard(root).hooks[0];
  assert.ok(hook);
  const out = await hook(input, "toolu_1", { signal: new AbortController().signal });
  return "hookSpecificOutput" in out ? out.hookSpecificOutput : undefined;
}

test("subagentGuard denies a subagent's memory write and lets the main thread make it", async () => {
  const write = { file_path: "memory/user.md", content: "x" };
  const sub = await decide(preToolUse("Write", write, { id: "agent-1", type: "researcher" }));
  assert.equal(sub && "permissionDecision" in sub ? sub.permissionDecision : undefined, "deny");
  assert.equal(await decide(preToolUse("Write", write)), undefined);
  assert.equal(await decide(preToolUse("Write", { file_path: "reports/a.md" }, { id: "agent-1", type: "writer" })), undefined);
});

test("checkSubagentTool refuses only send_file", () => {
  assert.match(checkSubagentTool("mcp__alfred__send_file") ?? "", /only Alfred talks to the user/);
  for (const tool of ["Agent", "TaskStop", "Read", "Write", "Skill", "WebFetch", "mcp__alfred__render_pdf"]) assert.equal(checkSubagentTool(tool), undefined, tool);
});

test("subagentGuard denies send_file and skill writes to every subagent, built-in types and forked skills included", async () => {
  for (const type of ["researcher", "general-purpose", "alfred:scout"]) {
    const send = await decide(preToolUse("mcp__alfred__send_file", { path: "reports/a.pdf" }, { id: "agent-1", type }));
    assert.equal(send && "permissionDecision" in send ? send.permissionDecision : undefined, "deny", `${type} send_file`);
    const skillWrite = await decide(preToolUse("Write", { file_path: "skills/x/SKILL.md", content: "x" }, { id: "agent-1", type }));
    assert.equal(skillWrite && "permissionDecision" in skillWrite ? skillWrite.permissionDecision : undefined, "deny", `${type} skills/`);
    assert.equal(await decide(preToolUse("TaskStop", { task_id: "t" }, { id: "agent-1", type })), undefined, `${type} TaskStop`);
  }
  assert.equal(await decide(preToolUse("mcp__alfred__send_file", { path: "reports/a.pdf" })), undefined, "the main thread sends files");
  assert.equal(await decide(preToolUse("Write", { file_path: "skills/x/SKILL.md", content: "x" })), undefined, "the main thread writes skills");
});

test("subagentGuard lets Agent calls of any type and model through, from the main thread and from subagents", async () => {
  const call = { description: "d", prompt: "p", subagent_type: "Explore", model: "haiku", effort: "low" };
  for (const agent of [undefined, { id: "agent-1", type: "general-purpose" }]) {
    const out = await decide(preToolUse("Agent", call, agent));
    assert.ok(out && "updatedInput" in out, String(agent?.type));
    assert.equal(out.permissionDecision, "allow");
    assert.deepEqual(out.updatedInput, { ...call, run_in_background: true });
  }
});

test("SubagentTracker follows foreground subagents through the SDK's task messages, forked skills included", () => {
  const tracker = new SubagentTracker();
  const started = (task_id: string, extra: Record<string, unknown>) =>
    ({ type: "system", subtype: "task_started", task_id, task_type: "local_agent", is_backgrounded: false, ...extra }) as unknown as SDKMessage;
  const notified = (task_id: string) => ({ type: "system", subtype: "task_notification", task_id, status: "completed" }) as unknown as SDKMessage;

  tracker.observe(started("t1", { tool_use_id: "a", subagent_type: "researcher", description: "线程一" }), 1000);
  tracker.observe(started("t2", { tool_use_id: "s", subagent_type: "general-purpose", description: "html-report" }), 2000);
  tracker.observe(started("t3", { tool_use_id: "b", subagent_type: "collector", description: "后台", is_backgrounded: true }), 2000);
  tracker.observe(started("t4", { tool_use_id: "c", description: "shell", task_type: "local_bash" }), 2000);
  assert.deepEqual(tracker.running, [
    { role: "researcher", description: "线程一", startedAt: 1000, toolUseId: "a" },
    { role: "general-purpose", description: "html-report", startedAt: 2000, toolUseId: "s" },
  ]);
  assert.equal(tracker.roleOf("s"), "general-purpose", "a forked skill's steps are attributed by its Skill call");
  assert.equal(tracker.roleOf("b"), undefined, "background subagents are not tracked here");

  tracker.observe(notified("t1"), 3000);
  assert.deepEqual(tracker.running.map((s) => s.description), ["html-report"]);
  tracker.observe({ type: "system", subtype: "task_updated", task_id: "t2", patch: { is_backgrounded: true } } as unknown as SDKMessage);
  assert.deepEqual(tracker.running, [], "a subagent moved to the background leaves");

  tracker.observe(started("t5", { tool_use_id: "w", subagent_type: "writer", description: "报告" }), 5000);
  tracker.observe({ type: "result", subtype: "error_max_budget_usd" } as unknown as SDKMessage, 6000);
  assert.deepEqual(tracker.running, [], "a turn that ends without a notification ends its foreground subagents");
});

test("subagentRulesHook gives every subagent the shared rules", async () => {
  const hook = subagentRulesHook().hooks[0];
  assert.ok(hook);
  const out = await hook(
    { hook_event_name: "SubagentStart", session_id: "s", transcript_path: "/dev/null", cwd: root, agent_id: "a1", agent_type: "general-purpose" },
    undefined,
    { signal: new AbortController().signal },
  );
  assert.ok("hookSpecificOutput" in out && out.hookSpecificOutput?.hookEventName === "SubagentStart");
  assert.equal(out.hookSpecificOutput.additionalContext, SUBAGENT_RULES);
});

test("subagentGuard asks the task to admit each Agent call, nested ones included, and relays a refusal", async () => {
  const calls: unknown[] = [];
  const admission = {
    admit: (call: unknown) => (calls.push(call), calls.length === 2 ? "queued as run k7m2qa" : undefined),
    failedToStart: () => {},
  };
  const hook = subagentGuard(root, admission).hooks[0];
  assert.ok(hook);
  const run = async (input: Record<string, unknown>, agent?: { id: string; type: string }) => {
    const out = await hook(preToolUse("Agent", input, agent), "toolu_1", { signal: new AbortController().signal });
    return "hookSpecificOutput" in out ? out.hookSpecificOutput : undefined;
  };
  const first = await run({ description: "a", prompt: "p", subagent_type: "researcher" });
  assert.equal(first && "permissionDecision" in first ? first.permissionDecision : undefined, "allow");
  const second = await run({ description: "b", prompt: "q", subagent_type: "collector", run_in_background: false });
  assert.equal(second && "permissionDecision" in second ? second.permissionDecision : undefined, "deny");
  assert.equal(second && "permissionDecisionReason" in second ? second.permissionDecisionReason : undefined, "queued as run k7m2qa");
  const nested = await run({ description: "c", prompt: "r", model: "opus" }, { id: "agent-1", type: "general-purpose" });
  assert.equal(nested && "permissionDecision" in nested ? nested.permissionDecision : undefined, "allow");
  assert.deepEqual(calls, [
    { toolUseId: "toolu_1", role: "researcher", model: undefined, description: "a", prompt: "p", background: true },
    { toolUseId: "toolu_1", role: "collector", model: undefined, description: "b", prompt: "q", background: false },
    { toolUseId: "toolu_1", role: "general-purpose", model: "opus", description: "c", prompt: "r", background: true },
  ]);
});
