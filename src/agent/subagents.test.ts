import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { HookInput, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { SubagentTracker, checkAgentCall, checkSubagentTool, checkSubagentWrite, subagentGuard } from "./subagents.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-subagents-")));
fs.mkdirSync(path.join(root, "memory"));
fs.mkdirSync(path.join(root, "reports"));
fs.mkdirSync(path.join(root, "skills"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

test("checkAgentCall keeps the brief and the role, drops model and effort, and runs in the background by default", () => {
  const checked = checkAgentCall({
    description: "VPS 价格对比",
    prompt: "Compare ...",
    subagent_type: "researcher",
    model: "opus",
    effort: "max",
    name: "vps",
    isolation: "worktree",
  });
  assert.deepEqual(checked, {
    input: { description: "VPS 价格对比", prompt: "Compare ...", subagent_type: "researcher", run_in_background: true },
  });
  const fg = checkAgentCall({ description: "d", prompt: "p", subagent_type: "collector", run_in_background: false });
  assert.ok("input" in fg && fg.input.run_in_background === false, "the foreground when asked for");
});

test("checkAgentCall denies calls without a role or with a built-in agent type", () => {
  for (const subagent_type of [undefined, "general-purpose", "Explore", "fork", "toString"]) {
    const checked = checkAgentCall({ description: "x", prompt: "y", subagent_type });
    assert.ok("deny" in checked, String(subagent_type));
    assert.match(checked.deny, /collector, researcher, writer/);
  }
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

test("checkSubagentTool refuses only the tools that are Alfred's alone", () => {
  for (const tool of ["mcp__alfred__send_file", "Agent", "TaskStop"]) assert.match(checkSubagentTool(tool) ?? "", /only Alfred/, tool);
  for (const tool of ["Read", "Write", "Skill", "WebFetch", "mcp__alfred__render_pdf"]) assert.equal(checkSubagentTool(tool), undefined, tool);
});

test("subagentGuard denies Alfred's own tools to every subagent, built-in types and forked skills included", async () => {
  const calls: [string, Record<string, unknown>][] = [
    ["mcp__alfred__send_file", { path: "reports/a.pdf" }],
    ["Agent", { description: "d", prompt: "p", subagent_type: "researcher" }],
    ["TaskStop", { task_id: "t" }],
  ];
  for (const type of ["researcher", "general-purpose", "alfred:scout"]) {
    for (const [tool, input] of calls) {
      const out = await decide(preToolUse(tool, input, { id: "agent-1", type }));
      assert.equal(out && "permissionDecision" in out ? out.permissionDecision : undefined, "deny", `${type} ${tool}`);
    }
    const skillWrite = await decide(preToolUse("Write", { file_path: "skills/x/SKILL.md", content: "x" }, { id: "agent-1", type }));
    assert.equal(skillWrite && "permissionDecision" in skillWrite ? skillWrite.permissionDecision : undefined, "deny", `${type} skills/`);
  }
  assert.equal(await decide(preToolUse("mcp__alfred__send_file", { path: "reports/a.pdf" })), undefined, "the main thread sends files");
  assert.equal(await decide(preToolUse("Write", { file_path: "skills/x/SKILL.md", content: "x" })), undefined, "the main thread writes skills");
});

test("subagentGuard rewrites Agent calls from the main thread and denies unknown roles", async () => {
  const ok = await decide(preToolUse("Agent", { description: "d", prompt: "p", subagent_type: "collector", model: "opus" }));
  assert.ok(ok && "updatedInput" in ok);
  assert.equal(ok.permissionDecision, "allow");
  assert.deepEqual(ok.updatedInput, { description: "d", prompt: "p", subagent_type: "collector", run_in_background: true });

  const bad = await decide(preToolUse("Agent", { description: "d", prompt: "p", subagent_type: "general-purpose" }));
  assert.equal(bad && "permissionDecision" in bad ? bad.permissionDecision : undefined, "deny");
});

test("SubagentTracker follows Agent calls in the main thread until their results arrive", () => {
  const tracker = new SubagentTracker();
  const agentCall = (id: string, role: string, description: string) =>
    ({
      type: "assistant",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_use", id, name: "Agent", input: { subagent_type: role, description, prompt: "..." } }] },
    }) as unknown as SDKMessage;
  const result = (id: string, parent: string | null = null) =>
    ({ type: "user", parent_tool_use_id: parent, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "done" }] } }) as unknown as SDKMessage;

  tracker.observe(agentCall("a", "researcher", "线程一"), 1000);
  tracker.observe(agentCall("b", "collector", "线程二"), 2000);
  assert.deepEqual(tracker.running, [
    { role: "researcher", description: "线程一", startedAt: 1000 },
    { role: "collector", description: "线程二", startedAt: 2000 },
  ]);
  tracker.observe(result("a", "b"), 3000);
  assert.equal(tracker.running.length, 2, "a tool result inside a subagent ends nothing");
  tracker.observe(result("a"), 3000);
  assert.deepEqual(tracker.running.map((s) => s.description), ["线程二"]);
  tracker.observe(result("b"), 4000);
  assert.deepEqual(tracker.running, []);

  tracker.observe(agentCall("c", "writer", "报告"), 5000);
  tracker.observe({ type: "result", subtype: "error_max_budget_usd" } as unknown as SDKMessage, 6000);
  assert.deepEqual(tracker.running, [], "a turn that ends without the Agent call's result ends its subagent");
});

test("subagentGuard asks the task to admit each Agent call and relays a refusal", async () => {
  const calls: unknown[] = [];
  const admission = {
    admit: (call: unknown) => (calls.push(call), calls.length > 1 ? "queued as run k7m2qa" : undefined),
    failedToStart: () => {},
  };
  const hook = subagentGuard(root, admission).hooks[0];
  assert.ok(hook);
  const run = async (input: Record<string, unknown>) => {
    const out = await hook(preToolUse("Agent", input), "toolu_1", { signal: new AbortController().signal });
    return "hookSpecificOutput" in out ? out.hookSpecificOutput : undefined;
  };
  const first = await run({ description: "a", prompt: "p", subagent_type: "researcher" });
  assert.equal(first && "permissionDecision" in first ? first.permissionDecision : undefined, "allow");
  const second = await run({ description: "b", prompt: "q", subagent_type: "collector", run_in_background: false });
  assert.equal(second && "permissionDecision" in second ? second.permissionDecision : undefined, "deny");
  assert.equal(second && "permissionDecisionReason" in second ? second.permissionDecisionReason : undefined, "queued as run k7m2qa");
  assert.deepEqual(calls, [
    { toolUseId: "toolu_1", role: "researcher", description: "a", prompt: "p", background: true },
    { toolUseId: "toolu_1", role: "collector", description: "b", prompt: "q", background: false },
  ]);
});
