import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";

import { query, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

import { appOutbound } from "../channels.ts";

// store.ts reads these at import time, so set them before loading the modules under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-external-")));
process.env.ALFRED_WORKSPACE = path.join(tmp, "workspace");
process.env.ALFRED_STATE_DIR = path.join(tmp, "state");
process.env.ALFRED_ANTHROPIC_API_KEY = "sk-test";
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { EXTERNAL_SERVERS_FILE, InvalidExternalServers, checkExternalTool, externalToolGuard, loadExternalServers, parseExternalServers } = await import("./external.ts");
const { agentOptions, prepareWorkspace } = await import("./handler.ts");

const SECRET = "s3cret-token-value";
process.env.ALFRED_MCP_TEST_AUTH = `Bearer ${SECRET}`;

const entry = {
  type: "http",
  url: "https://mcp.example.com/mcp",
  headers: { Authorization: "env:ALFRED_MCP_TEST_AUTH" },
  tools: ["search", "post", "read"],
  unattended: ["search", "read"],
  subagents: ["read"],
  timeoutMs: 20000,
};

function writeFile(content: unknown): void {
  fs.mkdirSync(path.dirname(EXTERNAL_SERVERS_FILE), { recursive: true });
  fs.writeFileSync(EXTERNAL_SERVERS_FILE, typeof content === "string" ? content : JSON.stringify(content));
}

afterEach(() => fs.rmSync(EXTERNAL_SERVERS_FILE, { force: true }));

const servers = () => parseExternalServers({ ext: entry });

function runHook(unattended: boolean, tool_name: string, extra: object = {}) {
  const hook = externalToolGuard(servers(), { unattended }).hooks[0]!;
  const input = { hook_event_name: "PreToolUse", tool_name, tool_input: { q: 1 }, tool_use_id: "t", session_id: "s", transcript_path: "", cwd: "", ...extra };
  return hook(input as never, "t", { signal: new AbortController().signal });
}

test("a tool the file offers is allowed in chat, and an unlisted tool of the same server is denied", () => {
  assert.equal(checkExternalTool(servers(), "mcp__ext__search", false, false), undefined);
  assert.equal(checkExternalTool(servers(), "mcp__ext__post", false, false), undefined);
  assert.match(checkExternalTool(servers(), "mcp__ext__delete", false, false) ?? "", /not offered to this run/);
});

test("a tool of a server that is not configured is denied, and Alfred's own tools are left to their own rules", () => {
  assert.match(checkExternalTool(servers(), "mcp__other__search", false, false) ?? "", /no such server/);
  assert.equal(checkExternalTool(servers(), "mcp__alfred__deliver", false, false), undefined);
  assert.equal(checkExternalTool(servers(), "Read", true, true), undefined);
  assert.match(checkExternalTool([], "mcp__ext__search", false, false) ?? "", /no such server/);
});

test("a subagent may call only the tools the file names for subagents", () => {
  assert.equal(checkExternalTool(servers(), "mcp__ext__read", true, false), undefined);
  assert.match(checkExternalTool(servers(), "mcp__ext__search", true, false) ?? "", /not offered to subagents/);
  assert.match(checkExternalTool(servers(), "mcp__ext__post", true, false) ?? "", /not offered to subagents/);
});

test("an unattended run gets only the tools named unattended, and its subagents only those named in both lists", () => {
  assert.equal(checkExternalTool(servers(), "mcp__ext__search", false, true), undefined);
  assert.match(checkExternalTool(servers(), "mcp__ext__post", false, true) ?? "", /not offered to unattended runs/);
  assert.equal(checkExternalTool(servers(), "mcp__ext__read", true, true), undefined);
  assert.match(checkExternalTool(servers(), "mcp__ext__search", true, true) ?? "", /not offered to subagents/);
  const bare = parseExternalServers({ ext: { type: "http", url: "https://mcp.example.com/mcp", tools: ["search"] } });
  assert.match(checkExternalTool(bare, "mcp__ext__search", false, true) ?? "", /not offered/);
  assert.match(checkExternalTool(bare, "mcp__ext__search", true, false) ?? "", /not offered/);
});

test("the hook denies with a reason and tells a subagent call by its agent_id", async () => {
  assert.deepEqual(await runHook(false, "mcp__ext__search"), {});
  const denied = (await runHook(false, "mcp__ext__search", { agent_id: "a1", agent_type: "researcher" })) as {
    hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
  };
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /subagents/);
  const unattended = (await runHook(true, "mcp__ext__post")) as { hookSpecificOutput: { permissionDecision: string } };
  assert.equal(unattended.hookSpecificOutput.permissionDecision, "deny");
});

test("the name alfred, other bad names, and an http:// URL are refused at load, naming the entry", () => {
  writeFile({ alfred: entry });
  assert.throws(() => loadExternalServers(), (err) => err instanceof InvalidExternalServers && /"alfred": the name alfred is reserved/.test(err.message));
  writeFile({ Alfred: entry });
  assert.throws(() => loadExternalServers(), /reserved/);
  writeFile({ ext: { ...entry, url: "http://mcp.example.com/mcp" } });
  assert.throws(() => loadExternalServers(), (err) => err instanceof InvalidExternalServers && /"ext": url must be https/.test(err.message));
  writeFile({ a__b: entry });
  assert.throws(() => loadExternalServers(), /"a__b"/);
});

test("other malformed entries stop the load with the entry's name", () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ ext: { ...entry, type: "stdio" } }, /"ext": type must be "http"/],
    [{ ext: { ...entry, headers: { Authorization: "Bearer literal" } } }, /"ext": header Authorization must be a value of the form env:/],
    [{ ext: { ...entry, headers: { Authorization: "env:ALFRED_MCP_NOT_SET" } } }, /"ext": header Authorization names ALFRED_MCP_NOT_SET, which is not set/],
    [{ ext: { ...entry, tools: [] } }, /"ext": tools must name at least one tool/],
    [{ ext: { ...entry, subagents: ["delete"] } }, /"ext": subagents names delete/],
    [{ ext: { ...entry, unattended: ["delete"] } }, /"ext": unattended names delete/],
    [{ ext: { ...entry, timeoutMs: 5 } }, /"ext": timeoutMs/],
    [{ ext: { ...entry, extra: 1 } }, /"ext": unknown field extra/],
    [{ ext: { ...entry, url: "https://u:p@mcp.example.com/" } }, /"ext": url must not hold credentials/],
    [[], /must be an object/],
  ];
  for (const [content, message] of cases) {
    writeFile(content);
    assert.throws(() => loadExternalServers(), message);
  }
  writeFile("{ not json");
  assert.throws(() => loadExternalServers(), /not valid JSON/);
});

test("no file means no external servers, and the options carry only Alfred's own server and tools", () => {
  assert.deepEqual(loadExternalServers(), []);
  prepareWorkspace();
  const options = agentOptions({ out: appOutbound(), model: "sonnet" });
  assert.deepEqual(Object.keys(options.mcpServers ?? {}), ["alfred"]);
  assert.ok(!options.allowedTools?.some((t) => t.startsWith("mcp__") && !t.startsWith("mcp__alfred__")));
  assert.equal(options.mcpServersDelivery, "initialize");
  writeFile({});
  const empty = agentOptions({ out: appOutbound(), model: "sonnet" });
  assert.deepEqual(empty.allowedTools, options.allowedTools);
  assert.deepEqual(Object.keys(empty.mcpServers ?? {}), ["alfred"]);
});

test("agentOptions attaches the configured server and allows its tools by run type", () => {
  writeFile({ ext: entry });
  prepareWorkspace();
  const external = (o: ReturnType<typeof agentOptions>) => (o.allowedTools ?? []).filter((t) => t.startsWith("mcp__ext__"));
  const chat = agentOptions({ out: appOutbound(), model: "sonnet" });
  assert.deepEqual(external(chat), ["mcp__ext__search", "mcp__ext__post", "mcp__ext__read"]);
  assert.deepEqual(chat.mcpServers?.ext, { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: `Bearer ${SECRET}` }, timeout: 20000 });
  assert.equal(chat.mcpServersDelivery, "initialize");
  for (const unattended of [{ task: { budgetUsd: 1 } }, { revision: { budgetUsd: 1 } }]) {
    const run = agentOptions({ out: appOutbound(), model: "sonnet", ...unattended });
    assert.deepEqual(external(run), ["mcp__ext__search", "mcp__ext__read"]);
  }
  writeFile({ ext: { ...entry, unattended: [] } });
  const quiet = agentOptions({ out: appOutbound(), model: "sonnet", task: { budgetUsd: 1 } });
  assert.deepEqual(external(quiet), []);
  assert.deepEqual(Object.keys(quiet.mcpServers ?? {}), ["alfred"]);
});

test("a file that went bad while Alfred runs offers no external tools to the run", () => {
  writeFile({ ext: { ...entry, url: "http://mcp.example.com/" } });
  prepareWorkspace();
  const options = agentOptions({ out: appOutbound(), model: "sonnet" });
  assert.deepEqual(Object.keys(options.mcpServers ?? {}), ["alfred"]);
});

test("a header value is read from the environment and appears neither in a log line nor in the spawned process's arguments", async () => {
  writeFile({ ext: entry });
  prepareWorkspace();
  const lines: string[] = [];
  const realError = console.error;
  const realLog = console.log;
  console.error = (...a: unknown[]) => void lines.push(a.join(" "));
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  let spawned: SpawnOptions | undefined;
  try {
    // A denial and a bad file both log.
    await runHook(false, "mcp__ext__post", { agent_id: "a" });
    writeFile({ ext: { ...entry, url: "http://mcp.example.com/" } });
    agentOptions({ out: appOutbound(), model: "sonnet" });
    writeFile({ ext: entry });
    const options = agentOptions({ out: appOutbound(), model: "sonnet" });
    try {
      const q = query({
        prompt: "hi",
        options: {
          ...options,
          spawnClaudeCodeProcess: (spawnOptions) => {
            spawned = spawnOptions;
            throw new Error("not spawned in tests");
          },
        },
      });
      await q.next();
    } catch {
      // The spawn is refused on purpose: only its arguments matter.
    }
  } finally {
    console.error = realError;
    console.log = realLog;
  }
  assert.ok(spawned, "the SDK reached the spawn");
  assert.ok(!spawned.args.some((a) => a.includes(SECRET)), "no header value in argv");
  assert.ok(!spawned.args.includes("--mcp-config"), "the servers are not sent on the command line");
  assert.ok(!lines.join("\n").includes(SECRET), "no header value in the log");
});
