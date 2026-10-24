import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { BotContext } from "../bot.ts";

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
  const ctx = {} as BotContext;
  const runs = {
    task: agentOptions({ ctx, userId: "owner", model: "sonnet" }),
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
  const options = agentOptions({ ctx: {} as BotContext, userId: "owner", model: "sonnet" });
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
  const options = agentOptions({ ctx: {} as BotContext, userId: "owner", model: "sonnet", subagents: false });
  assert.ok(Array.isArray(options.tools) && !options.tools.includes("Agent"));
  assert.ok(!options.allowedTools?.includes("Agent"));
  assert.equal(options.agents, undefined);
  assert.doesNotMatch(String(options.systemPrompt), /# Delegating to subagents/);
});

test("tasks load the baked and workspace skill plugins and offer every skill they hold through the Skill tool", async () => {
  const { BAKED_PLUGIN_DIR, WORKSPACE_PLUGIN_DIR } = await import("./skills.ts");
  for (const subagents of [true, false]) {
    prepareWorkspace();
    const options = agentOptions({ ctx: {} as BotContext, userId: "owner", model: "sonnet", subagents });
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
  const options = agentOptions({ ctx: {} as BotContext, userId: "owner", model: "sonnet" });
  assert.deepEqual(options.agents?.writer?.skills, ["alfred:html-report"]);
  assert.equal(options.agents?.researcher?.skills, undefined);
});

test("the system prompt does not depend on which skills exist", () => {
  prepareWorkspace();
  const prompt = () => String(agentOptions({ ctx: {} as BotContext, userId: "owner", model: "sonnet" }).systemPrompt).replace(/^Today is .*$/m, "");
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
