// What a bot's chat run is built from: its record's model, budget and tools, and the system prompt with its context.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";

import type { Bot } from "../api/schema.ts";
import { appOutbound } from "../channels.ts";

// store.ts reads these at import time, so set them before loading the modules under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-bot-options-")));
const workspace = path.join(tmp, "workspace");
process.env.ALFRED_WORKSPACE = workspace;
process.env.ALFRED_STATE_DIR = path.join(tmp, "state");
process.env.ALFRED_ANTHROPIC_API_KEY = "sk-test";
process.env.ALFRED_WORKBENCH = "";
process.env.ALFRED_WORKBENCH_URL = "";
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { agentOptions, prepareWorkspace } = await import("./handler.ts");
const { MODELS, systemPrompt } = await import("./config.ts");
const { EXTERNAL_SERVERS_FILE } = await import("./external.ts");
const { ensureBotHome } = await import("../bots/home.ts");
const { TaskStore } = await import("../tasks/store.ts");
const { RULES_MAX_BYTES } = await import("./rules.ts");

const BOT: Bot = {
  id: "tax",
  name: "报税助手",
  description: "Helps the owner with tax filing",
  instructions: "Answer only about tax. Keep working notes in your notes folder.",
  model: "haiku",
  runBudgetUsd: 0.5,
  tools: [],
  createdAt: "2026-11-28T08:00:00.000Z",
  updatedAt: "2026-11-28T08:00:00.000Z",
};
const bot = (tools: string[]): Bot => ({ ...BOT, tools });
const ask = async () => ({ cancelled: true as const });
const FILE_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep"];

const entry = (tools: string[]) => ({ type: "http", url: "https://mcp.example.com/mcp", tools, unattended: [], subagents: tools });

function writeServers(content: unknown): void {
  fs.mkdirSync(path.dirname(EXTERNAL_SERVERS_FILE), { recursive: true });
  fs.writeFileSync(EXTERNAL_SERVERS_FILE, JSON.stringify(content));
}

afterEach(() => fs.rmSync(EXTERNAL_SERVERS_FILE, { force: true }));

function botOptions(tools: string[], more: Partial<Parameters<typeof agentOptions>[0]> = {}) {
  prepareWorkspace();
  ensureBotHome(workspace, BOT.id);
  return agentOptions({ out: appOutbound(), model: "opus", ask, bot: bot(tools), ...more });
}

test("a bot's run takes its model and run budget from the record, whatever model the caller names", () => {
  const options = botOptions([]);
  assert.equal(options.model, MODELS.haiku);
  assert.equal(options.maxBudgetUsd, 0.5);
  assert.equal(options.cwd, workspace);
  assert.equal(options.permissionMode, "dontAsk");
  assert.notEqual(agentOptions({ out: appOutbound(), model: "opus", ask }).maxBudgetUsd, 0.5, "Alfred's budget is the setting's");
});

test("with no tools named a bot is offered the file tools, Skill, AskUserQuestion, deliver, move_file and render_pdf, and nothing else", () => {
  const options = botOptions([]);
  assert.deepEqual(options.tools, [...FILE_TOOLS, "Skill", "AskUserQuestion"]);
  assert.deepEqual(options.allowedTools, [...FILE_TOOLS, "Skill", "mcp__alfred__deliver", "mcp__alfred__move_file", "mcp__alfred__render_pdf"]);
  assert.equal(options.agents, undefined, "no Agent tool, so no roles");
  assert.deepEqual(Object.keys(options.mcpServers ?? {}), ["alfred"]);
  assert.doesNotMatch(String(options.systemPrompt), /# Delegating to subagents/);
});

test("the tools a bot names are added: WebSearch, WebFetch, Agent with TaskStop and the roles, and Alfred's generate_image", () => {
  const options = botOptions(["WebSearch", "WebFetch", "Agent", "mcp__alfred__generate_image"]);
  assert.deepEqual(options.tools, [...FILE_TOOLS, "WebSearch", "WebFetch", "Skill", "Agent", "TaskStop", "AskUserQuestion"]);
  for (const name of ["WebSearch", "WebFetch", "Agent", "TaskStop", "mcp__alfred__generate_image"]) assert.ok(options.allowedTools?.includes(name), name);
  assert.deepEqual(Object.keys(options.agents ?? {}).sort(), ["collector", "researcher", "writer"]);
  assert.match(String(options.systemPrompt), /# Delegating to subagents/);

  const web = botOptions(["WebSearch"]);
  assert.ok(web.allowedTools?.includes("WebSearch") && !web.allowedTools.includes("WebFetch") && !web.allowedTools.includes("Agent"));
  assert.ok(!web.allowedTools?.includes("mcp__alfred__generate_image"));
});

test("a bot gets no task tools and no spend_query, though the same call gives Alfred both", () => {
  prepareWorkspace();
  const tasks = new TaskStore();
  const alfred = agentOptions({ out: appOutbound(), model: "sonnet", ask, tasks });
  assert.ok(alfred.allowedTools?.includes("mcp__alfred__task_list"));
  assert.ok(alfred.allowedTools?.includes("mcp__alfred__spend_query"));
  const options = botOptions(["Agent"], { tasks });
  assert.ok(!options.allowedTools?.some((name) => name.startsWith("mcp__alfred__task_")));
  assert.ok(!options.allowedTools?.includes("mcp__alfred__spend_query"));
  assert.doesNotMatch(String(options.systemPrompt), /# Tasks/);
});

test("a name in bot.tools that is none of the tools is ignored and reported once", () => {
  const ignored: string[][] = [];
  const options = botOptions(["WebSearch", "bogus", "mcp__missing__x", "mcp__alfred__spend_query", "mcp__alfred__deliver"], { onIgnoredTools: (names) => ignored.push(names) });
  assert.deepEqual(ignored, [["bogus", "mcp__missing__x", "mcp__alfred__spend_query", "mcp__alfred__deliver"]]);
  assert.ok(!options.allowedTools?.some((name) => ["bogus", "mcp__missing__x", "mcp__alfred__spend_query"].includes(name)));
  assert.equal(options.allowedTools?.filter((name) => name === "mcp__alfred__deliver").length, 1);
  botOptions(["WebSearch"], { onIgnoredTools: (names) => ignored.push(names) });
  assert.equal(ignored.length, 1, "nothing is reported when every name matches");
});

test("external MCP tools come by full name or by `mcp__<server>` for the whole server, and only the configured policy's tools", async () => {
  writeServers({ ext: entry(["search", "post", "read"]), other: entry(["list", "get"]), idle: entry(["x"]) });
  const none = botOptions([]);
  assert.deepEqual(Object.keys(none.mcpServers ?? {}), ["alfred"], "a server the bot names nothing of is not attached");

  const options = botOptions(["mcp__ext__search", "mcp__other"]);
  assert.deepEqual(Object.keys(options.mcpServers ?? {}).sort(), ["alfred", "ext", "other"]);
  const external = (options.allowedTools ?? []).filter((name) => name.startsWith("mcp__") && !name.startsWith("mcp__alfred__")).sort();
  assert.deepEqual(external, ["mcp__ext__search", "mcp__other__get", "mcp__other__list"]);

  // The guard still decides per call, and a tool the bot did not name is denied even though the server is configured.
  const hook = (options.hooks?.PreToolUse ?? []).flatMap((m) => m.hooks);
  const call = async (tool_name: string) => {
    const input = { hook_event_name: "PreToolUse", tool_name, tool_input: {}, tool_use_id: "t", session_id: "s", transcript_path: "", cwd: "" };
    const outputs = await Promise.all(hook.map((h) => h(input as never, "t", { signal: new AbortController().signal })));
    return outputs.some((out) => "hookSpecificOutput" in out && (out.hookSpecificOutput as { permissionDecision?: string }).permissionDecision === "deny");
  };
  assert.equal(await call("mcp__ext__search"), false);
  assert.equal(await call("mcp__ext__post"), true);
  assert.equal(await call("mcp__other__list"), false);
  assert.equal(await call("mcp__idle__x"), true);
});

test("a bot's write scope is the guard's: its home, memory/ and .trash/", async () => {
  const options = botOptions([]);
  const hook = (options.hooks?.PreToolUse ?? []).flatMap((m) => m.hooks);
  const verdict = async (file_path: string) => {
    const input = { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path }, tool_use_id: "t", session_id: "s", transcript_path: "", cwd: "" };
    const outputs = await Promise.all(hook.map((h) => h(input as never, "t", { signal: new AbortController().signal })));
    return outputs.some((out) => "hookSpecificOutput" in out && (out.hookSpecificOutput as { permissionDecision?: string }).permissionDecision === "deny");
  };
  assert.equal(await verdict("bots/tax/notes/a.md"), false);
  assert.equal(await verdict("memory/a.md"), false);
  assert.equal(await verdict("notes/a.md"), true);
  assert.equal(await verdict("bots/other/a.md"), true);
});

const NOW = new Date("2026-11-29T10:00:00Z");
const SENTENCE = " The folder bots/ belongs to the owner's other assistants: you may read it but not change it.";

test("the system prompt of a bot names the bot, gives its description and the owner's instructions, and its home and write scope", () => {
  const prompt = systemPrompt(NOW, { bot: BOT });
  assert.match(prompt, /^You are 报税助手, one of the owner's assistants in the Alfred app\. They talk to you through the app on their phone/);
  assert.doesNotMatch(prompt, /You are Alfred/);
  const role = prompt.slice(prompt.indexOf("# Your role"));
  assert.match(role, /^# Your role\nHelps the owner with tax filing\n\nThe owner's instructions for 报税助手\./);
  assert.match(role, /<owner-instructions>\nAnswer only about tax\. Keep working notes in your notes folder\.\n<\/owner-instructions>/);
  const workspaceSection = prompt.slice(prompt.indexOf("# Workspace"), prompt.indexOf("# Replying in the app"));
  assert.match(workspaceSection, /Your home is bots\/tax\/: files you keep go there, reports in bots\/tax\/reports\/ and notes in bots\/tax\/notes\//);
  assert.match(workspaceSection, /You may write only your home, memory\/ and \.trash\//);
  assert.doesNotMatch(workspaceSection, /belongs to the owner's other assistants/);
});

test("a bot's own ALFRED.md follows the root one in its prompt, cut at the same 8 KB; the memory index is the shared one", () => {
  prepareWorkspace();
  ensureBotHome(workspace, BOT.id);
  fs.writeFileSync(path.join(workspace, "bots", "tax", "ALFRED.md"), "# Tax rules\nUse EUR everywhere.\n");
  fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "memory", "home-country.md"),
    "---\nname: Home country\ndescription: The owner files taxes in Portugal\ntype: user\nupdated: 2026-11-28\n---\nPortugal.\n",
  );
  const options = agentOptions({ out: appOutbound(), model: "sonnet", ask, bot: BOT });
  const prompt = String(options.systemPrompt);
  const root = prompt.indexOf('<workspace-rules path="ALFRED.md">');
  const own = prompt.indexOf('<workspace-rules path="bots/tax/ALFRED.md">');
  assert.ok(root > 0 && own > root, "the bot's file follows the root file");
  assert.match(prompt, /Use EUR everywhere\./);
  assert.match(prompt, /<memory-index>[\s\S]*Home country[\s\S]*<\/memory-index>/);
  const alfred = String(agentOptions({ out: appOutbound(), model: "sonnet", ask }).systemPrompt);
  assert.doesNotMatch(alfred, /Use EUR everywhere/, "Alfred's prompt has none of it");
  assert.match(alfred, /<memory-index>[\s\S]*Home country[\s\S]*<\/memory-index>/);

  fs.writeFileSync(path.join(workspace, "bots", "tax", "ALFRED.md"), `${"x".repeat(RULES_MAX_BYTES + 100)}\n`);
  assert.match(String(agentOptions({ out: appOutbound(), model: "sonnet", ask, bot: BOT }).systemPrompt), new RegExp(`Cut off at ${RULES_MAX_BYTES} bytes`));
  fs.rmSync(path.join(workspace, "bots", "tax", "ALFRED.md"));
  assert.doesNotMatch(String(agentOptions({ out: appOutbound(), model: "sonnet", ask, bot: BOT }).systemPrompt), /bots\/tax\/ALFRED\.md">/);
});

test("Alfred's prompt without a bot context is what it was, with one sentence about bots/", () => {
  const prompt = systemPrompt(NOW);
  assert.equal(prompt, systemPrompt(NOW, { bot: undefined, botRules: undefined }));
  assert.equal(prompt.split(SENTENCE).length, 2, "the sentence is there once");
  const legacy = prompt.replace(SENTENCE, "");
  assert.match(
    legacy,
    /^You are Alfred, a personal research assistant for one person\. They talk to you through the app on their phone and see only your final reply, never your tool calls\.\n\nToday is /,
  );
  assert.ok(
    legacy.includes(
      "# Workspace\nYour working directory is the workspace, and nothing outside it is accessible. Files the user sends are saved under inbox/<date>/; when a message lists attached files, read them with the Read tool, which handles images and PDFs. Long-term memory lives in memory/ (see Long-term memory below). Where everything else goes is set by the workspace rules below.\n\n# Replying in the app",
    ),
  );
  assert.equal(legacy.split("bots/").length, 1, "no other mention of bots/");
});
