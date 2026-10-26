import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { appOutbound } from "../channels.ts";

// store.ts reads these at import time, so set them before loading the modules under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-options-")));
process.env.ALFRED_WORKSPACE = path.join(tmp, "workspace");
process.env.ALFRED_STATE_DIR = path.join(tmp, "state");
process.env.ALFRED_ANTHROPIC_API_KEY = "sk-test";
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { agentOptions, prepareWorkspace } = await import("./handler.ts");
const { extractionOptions } = await import("./memory-scan.ts");

test("tasks and memory scans turn off Claude Code's own auto memory, bundled skills and every hook or shell command a skill declares", () => {
  prepareWorkspace();
  const runs = {
    task: agentOptions({ out: appOutbound(), model: "sonnet" }),
    scan: extractionOptions(0.1, new AbortController()),
  };
  for (const [kind, options] of Object.entries(runs)) {
    assert.deepEqual(options.settingSources, [], kind);
    assert.deepEqual(
      options.settings,
      {
        autoMemoryEnabled: false,
        disableBundledSkills: true,
        enabledPlugins: { "cc-plugin-plugin-authoring@builtin": false },
        disableSkillShellExecution: true,
        disableAllHooks: true,
      },
      kind,
    );
  }
});

test("tasks offer the subagent roles with their default models, and no role can send files or start subagents", async () => {
  const { MODELS, SUBAGENT_ROLES, SUBAGENT_RULES } = await import("./config.ts");
  prepareWorkspace();
  const options = agentOptions({ out: appOutbound(), model: "sonnet" });
  assert.ok(options.tools && Array.isArray(options.tools) && options.tools.includes("Agent"));
  assert.ok(options.allowedTools?.includes("Agent"));
  const agents = options.agents ?? {};
  assert.deepEqual(Object.keys(agents).sort(), Object.keys(SUBAGENT_ROLES).sort());
  for (const [name, role] of Object.entries(SUBAGENT_ROLES)) {
    const agent = agents[name];
    assert.ok(agent, name);
    assert.equal(agent.model, MODELS[role.model], name);
    assert.equal(agent.maxTurns, role.maxTurns, name);
    assert.ok(!agent.tools?.includes("mcp__alfred__send_file"), `${name} lists send_file`);
    assert.ok(!agent.tools?.includes("Agent"), `${name} lists Agent`);
    assert.ok(agent.disallowedTools?.includes("mcp__alfred__send_file"), `${name} does not disallow send_file`);
    assert.ok(agent.disallowedTools?.includes("Agent"), `${name} does not disallow Agent`);
    assert.equal(agent.prompt, role.focus, `${name}: the shared rules come from the SubagentStart hook`);
  }
  assert.ok(!Object.values(agents).some((a) => a.prompt.includes(SUBAGENT_RULES)));
  assert.equal(options.hooks?.SubagentStart?.length, 1, "every subagent gets the shared rules");
  assert.match(String(options.systemPrompt), /# Delegating to subagents/);
});

test("tasks without subagents drop the Agent tool, the roles and the delegation rules", () => {
  prepareWorkspace();
  const options = agentOptions({ out: appOutbound(), model: "sonnet", subagents: false });
  assert.ok(Array.isArray(options.tools) && !options.tools.includes("Agent"));
  assert.ok(!options.allowedTools?.includes("Agent"));
  assert.equal(options.agents, undefined);
  assert.doesNotMatch(String(options.systemPrompt), /# Delegating to subagents/);
});

test("tasks load the baked and workspace skill plugins and offer every skill they hold through the Skill tool", async () => {
  const { BAKED_PLUGIN_DIR, WORKSPACE_PLUGIN_DIR } = await import("./skills.ts");
  for (const subagents of [true, false]) {
    prepareWorkspace();
    const options = agentOptions({ out: appOutbound(), model: "sonnet", subagents });
    assert.deepEqual(options.plugins, [
      { type: "local", path: BAKED_PLUGIN_DIR },
      { type: "local", path: WORKSPACE_PLUGIN_DIR, skipMcpDiscovery: true },
    ]);
    assert.equal(options.skills, "all");
    assert.ok(Array.isArray(options.tools) && options.tools.includes("Skill"));
    assert.ok(options.allowedTools?.includes("Skill"));
  }
  assert.equal(fs.readlinkSync(path.join(WORKSPACE_PLUGIN_DIR, "skills")), path.join(tmp, "workspace", "skills"));
});

test("the writer starts with the html-report skill", () => {
  prepareWorkspace();
  const options = agentOptions({ out: appOutbound(), model: "sonnet" });
  assert.deepEqual(options.agents?.writer?.skills, ["alfred:html-report"]);
  assert.equal(options.agents?.researcher?.skills, undefined);
});

test("the system prompt does not depend on which skills exist", () => {
  prepareWorkspace();
  const prompt = () => String(agentOptions({ out: appOutbound(), model: "sonnet" }).systemPrompt).replace(/^Today is .*$/m, "");
  const before = prompt();
  const skill = path.join(tmp, "workspace", "skills", "weekly-brief");
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: weekly-brief\ndescription: Weekly brief\n---\nSteps.\n");
  try {
    assert.equal(prompt(), before);
  } finally {
    fs.rmSync(skill, { recursive: true, force: true });
  }
});

test("a run that can ask offers AskUserQuestion, answered in a hook that waits as long as the owner takes, with dontAsk kept", async () => {
  const { QUESTION_HOOK_TIMEOUT_SECONDS } = await import("./questions.ts");
  prepareWorkspace();
  const ask = async () => ({ cancelled: true as const });
  const options = agentOptions({ out: appOutbound(), model: "sonnet", ask });
  assert.ok(Array.isArray(options.tools) && options.tools.includes("AskUserQuestion"));
  assert.ok(!options.allowedTools?.includes("AskUserQuestion"), "the hook decides, not an allow rule");
  assert.equal(options.permissionMode, "dontAsk");
  // The CLI offers AskUserQuestion only when there is a permission prompt surface. The hook answers the tool before it
  // is asked, so the callback is a stop for anything that would otherwise ask: it denies everything.
  assert.equal(typeof options.canUseTool, "function");
  const denied = await options.canUseTool?.("AskUserQuestion", {}, { signal: new AbortController().signal, toolUseID: "toolu_1", requestId: "r1" });
  assert.equal(denied?.behavior, "deny");
  assert.equal((await options.canUseTool?.("Bash", { command: "ls" }, { signal: new AbortController().signal, toolUseID: "toolu_2", requestId: "r2" }))?.behavior, "deny");
  const matchers = options.hooks?.PreToolUse ?? [];
  const asking = matchers.filter((m) => m.timeout !== undefined);
  assert.equal(asking.length, 1, "one matcher carries the question hook");
  assert.equal(asking[0]?.timeout, QUESTION_HOOK_TIMEOUT_SECONDS);
  assert.ok(QUESTION_HOOK_TIMEOUT_SECONDS > 86_400);
});

test("a run that cannot ask, such as the smoke test's, does not offer AskUserQuestion", () => {
  prepareWorkspace();
  const options = agentOptions({ out: appOutbound(), model: "sonnet" });
  assert.ok(Array.isArray(options.tools) && !options.tools.includes("AskUserQuestion"));
  assert.ok(!options.hooks?.PreToolUse?.some((m) => m.timeout !== undefined));
  assert.equal(options.canUseTool, undefined);
  assert.doesNotMatch(String(options.systemPrompt), /AskUserQuestion/);
});

test("the system prompt says the owner talks through the app, and when to ask: a choice that blocks progress", () => {
  prepareWorkspace();
  const prompt = String(agentOptions({ out: appOutbound(), model: "sonnet", ask: async () => ({ cancelled: true as const }) }).systemPrompt);
  assert.match(prompt, /talk to you through the app on their phone/);
  assert.match(prompt, /AskUserQuestion/);
  assert.match(prompt, /never for things you can decide/);
});

test("the reply rules are for the app: HTML reports are sent as they are, a PDF only on request or to keep", () => {
  prepareWorkspace();
  const prompt = String(agentOptions({ out: appOutbound(), model: "sonnet" }).systemPrompt);
  const section = /# Replying in the app\n([\s\S]*?)\n\n/.exec(prompt)?.[1] ?? "";
  assert.ok(section, "the section is there");
  assert.match(section, /Simplified Chinese/);
  assert.match(section, /phone screen/);
  assert.match(section, /under about 1500 characters/);
  assert.match(section, /Markdown renders in the app, and an image shows when it is a file in the workspace/);
  assert.match(section, /self-contained HTML file with its charts drawn as inline SVG, sent as it is with send_file/);
  assert.match(section, /inline scripts and SVG charts work, with no network access/);
  assert.match(section, /PDF with render_pdf only when the user asks for one, or for a document meant to be kept or forwarded/);
  assert.match(section, /ambiguous/);
  assert.doesNotMatch(prompt, /never send (an )?HTML/i);
  assert.deepEqual(prompt.match(/^# Replying in .*$/gm), ["# Replying in the app"], "one reply section, and it is the app's");
});

test("an unattended run, such as a scheduled task's, keeps no session, has its own budget, offers no questions and may not write memory, rules or skills", async () => {
  const { MAX_BUDGET_USD } = await import("./config.ts");
  prepareWorkspace();
  const options = agentOptions({ out: appOutbound(), model: "haiku", task: { budgetUsd: 0.5 } });
  assert.equal(options.persistSession, false);
  assert.equal(options.maxBudgetUsd, 0.5);
  assert.equal(options.model, "claude-haiku-5-5");
  assert.equal(options.resume, undefined);
  assert.ok(Array.isArray(options.tools) && !options.tools.includes("AskUserQuestion"));
  assert.ok(options.tools.includes("Agent"), "foreground subagents work as in chat");

  const chat = agentOptions({ out: appOutbound(), model: "haiku" });
  assert.equal(chat.persistSession, undefined);
  assert.equal(chat.maxBudgetUsd, MAX_BUDGET_USD);
});

/** The tools of Alfred's in-process MCP server in these options, by name. */
function alfredTools(options: ReturnType<typeof agentOptions>): string[] {
  const server = options.mcpServers?.alfred as unknown as { instance: { _registeredTools: Record<string, unknown> } };
  return Object.keys(server.instance._registeredTools);
}

let taskStores = 0;
/** A task store of its own in the temp dir. */
async function taskStore() {
  const { TaskStore } = await import("../tasks/store.ts");
  const { EventLog } = await import("../events.ts");
  const n = taskStores++;
  return new TaskStore({ file: path.join(tmp, `tasks-${n}.json`), events: new EventLog(path.join(tmp, `events-${n}.jsonl`)) });
}

test("the task tools are offered to a run that can ask and has a task store, and to no other run", async () => {
  const { TASK_TOOL_NAMES } = await import("./task-tools.ts");
  prepareWorkspace();
  const tasks = await taskStore();
  const ask = async () => ({ cancelled: true as const });
  const names = TASK_TOOL_NAMES.map((name) => name.replace("mcp__alfred__", ""));
  const base = ["send_file", "move_file", "render_pdf", "generate_image"];

  const chat = agentOptions({ out: appOutbound(), model: "sonnet", ask, tasks });
  assert.deepEqual(alfredTools(chat), [...base, ...names]);
  for (const name of TASK_TOOL_NAMES) assert.ok(chat.allowedTools?.includes(name), name);
  assert.match(String(chat.systemPrompt), /^# Tasks$/m);

  const others = {
    "a run of a task, whatever it is given": agentOptions({ out: appOutbound(), model: "sonnet", ask, tasks, task: { budgetUsd: 1 } }),
    "a run without a task store": agentOptions({ out: appOutbound(), model: "sonnet", ask }),
    "a run that cannot ask, so could not confirm": agentOptions({ out: appOutbound(), model: "sonnet", tasks }),
  };
  for (const [what, options] of Object.entries(others)) {
    assert.deepEqual(alfredTools(options), base, what);
    assert.ok(!options.allowedTools?.some((name) => name.includes("task_")), what);
    assert.doesNotMatch(String(options.systemPrompt), /^# Tasks$/m, what);
  }
});

test("a run that waits on the owner's tap is not cut off after a day: the tools' server waits as long as a question does", async () => {
  const { QUESTION_HOOK_TIMEOUT_SECONDS } = await import("./questions.ts");
  prepareWorkspace();
  const tasks = await taskStore();
  const server = (o: ReturnType<typeof agentOptions>) => o.mcpServers?.alfred as unknown as { timeout?: number };
  const chat = agentOptions({ out: appOutbound(), model: "sonnet", ask: async () => ({ cancelled: true as const }), tasks });
  assert.equal(server(chat).timeout, QUESTION_HOOK_TIMEOUT_SECONDS * 1000);
  assert.equal(server(agentOptions({ out: appOutbound(), model: "sonnet" })).timeout, undefined, "the other runs keep the SDK's default");
});

test("the Tasks section is short and says: only on request, the tap is the owner's, the zone, the models, and pause without asking", async () => {
  prepareWorkspace();
  const tasks = await taskStore();
  const prompt = String(agentOptions({ out: appOutbound(), model: "sonnet", ask: async () => ({ cancelled: true as const }), tasks }).systemPrompt);
  const section = /^# Tasks\n([\s\S]*?)(?:\n\n|(?![\s\S]))/m.exec(prompt)?.[1] ?? "";
  assert.ok(section, "the section is there");
  assert.ok(section.split(/\s+/).length <= 120, `${section.split(/\s+/).length} words`);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.match(section, /only when the owner asks for scheduled or recurring work, never on your own initiative/);
  assert.match(section, /waits for the owner's tap in the app/);
  assert.match(section, /say what you proposed and what happened/);
  assert.match(section, /do not repeat the question/);
  assert.ok(section.includes(zone), "names the owner's zone");
  assert.match(section, /haiku or sonnet/);
  assert.match(section, /per-run cap/);
  assert.match(section, /[Pp]ause or end .* without asking/);
});
