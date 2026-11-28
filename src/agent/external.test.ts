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

// Spend: the price of a call and the most calls a run may make.

const { EXTERNAL_SPEND_LOG, readExternalSpend } = await import("../spend.ts");
const { externalSpendHooks } = await import("./external.ts");

const priced = { ...entry, subagents: ["read", "post"], spend: { post: { priceUsd: 0.04, maxPerRun: 2 }, search: { priceUsd: 0 }, read: { maxPerRun: 1 } } };
const pricedServers = () => parseExternalServers({ ext: priced });

afterEach(() => fs.rmSync(EXTERNAL_SPEND_LOG, { force: true }));

function preInput(tool_name: string, extra: object = {}) {
  return { hook_event_name: "PreToolUse", tool_name, tool_input: {}, tool_use_id: "t", session_id: "s", transcript_path: "", cwd: "", ...extra };
}

function pre(runId: string, tool_name: string, extra: object = {}) {
  const hook = externalToolGuard(pricedServers(), { unattended: false, runId }).hooks[0]!;
  return hook(preInput(tool_name, extra) as never, "t", { signal: new AbortController().signal });
}

const denied = (out: unknown): boolean => (out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision === "deny";

function post(hooks: ReturnType<typeof externalSpendHooks>, tool_name: string, ok: boolean, response: unknown = "done") {
  const input = ok
    ? { hook_event_name: "PostToolUse", tool_name, tool_input: {}, tool_response: response, tool_use_id: "t" }
    : { hook_event_name: "PostToolUseFailure", tool_name, tool_input: {}, error: "boom", tool_use_id: "t" };
  const matcher = ok ? hooks.postToolUse : hooks.postToolUseFailure;
  return matcher.hooks[0]!({ session_id: "s", transcript_path: "", cwd: "", ...input } as never, "t", { signal: new AbortController().signal });
}

test("price and limit are read per tool, and a value that does not fit stops the load naming the entry", () => {
  assert.deepEqual(pricedServers()[0]?.spend, { post: { priceUsd: 0.04, maxPerRun: 2 }, search: { priceUsd: 0 }, read: { maxPerRun: 1 } });
  assert.deepEqual(servers()[0]?.spend, {}, "a file without spend prices nothing");
  const cases: Array<[unknown, RegExp]> = [
    [{ post: { priceUsd: -1 } }, /"ext": spend priceUsd for post must be a number of at least 0/],
    [{ post: { priceUsd: "0.04" } }, /"ext": spend priceUsd for post/],
    [{ post: { maxPerRun: 0 } }, /"ext": spend maxPerRun for post must be a whole number of at least 1/],
    [{ post: { maxPerRun: 1.5 } }, /"ext": spend maxPerRun for post/],
    [{ delete: { priceUsd: 1 } }, /"ext": spend names delete, which tools does not offer/],
    [{ post: { price: 1 } }, /"ext": spend for post has an unknown field price/],
    [{ post: 5 }, /"ext": spend for post must be an object/],
    [[], /"ext": spend must be an object/],
  ];
  for (const [spend, message] of cases) {
    writeFile({ ext: { ...entry, spend } });
    assert.throws(() => loadExternalServers(), message);
  }
});

test("a call that succeeded is appended with the tool's price, and a failed call leaves no entry", async () => {
  const hooks = externalSpendHooks(pricedServers(), "run-a");
  await post(hooks, "mcp__ext__post", false);
  assert.deepEqual(readExternalSpend(), [], "a failed call");
  await post(hooks, "mcp__ext__post", true, { isError: true, content: [] });
  assert.deepEqual(readExternalSpend(), [], "a result that reports an error");
  await post(hooks, "mcp__ext__post", true);
  await post(hooks, "mcp__ext__post", true, [{ type: "text", text: "ok" }]);
  const [first, second, ...rest] = readExternalSpend();
  assert.equal(rest.length, 0);
  assert.deepEqual({ ...first, at: "" }, { at: "", runId: "run-a", server: "ext", tool: "post", units: 1, usd: 0.04, estimated: true });
  assert.ok(second && !Number.isNaN(Date.parse(second.at)));
  // No price, no entry; a price of 0 is still a call on record; a tool of another server or Alfred's own is none of this hook's business.
  await post(hooks, "mcp__ext__read", true);
  await post(hooks, "mcp__ext__search", true);
  await post(hooks, "mcp__ext__unknown", true);
  await post(hooks, "mcp__alfred__deliver", true);
  assert.deepEqual(readExternalSpend().map((e) => [e.tool, e.usd]), [["post", 0.04], ["post", 0.04], ["search", 0]]);
});

test("maxPerRun denies the next call of the run with a reason that says not to retry, in a subagent too", async () => {
  assert.ok(!denied(await pre("run-b", "mcp__ext__post")));
  assert.ok(!denied(await pre("run-b", "mcp__ext__post", { agent_id: "a1", agent_type: "researcher" })), "a subagent's call counts in the run's count");
  const third = await pre("run-b", "mcp__ext__post");
  assert.ok(denied(third));
  const reason = (third as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /limit of 2 calls in this run/);
  assert.match(reason, /Do not retry/);
  assert.ok(denied(await pre("run-b", "mcp__ext__post", { agent_id: "a1" })), "the subagent is stopped as well");
  assert.ok(!denied(await pre("run-c", "mcp__ext__post")), "another run has its own count");
  assert.ok(!denied(await pre("run-b", "mcp__ext__search")), "a tool without a limit is not stopped");
});

test("a call that failed is given back to the run's count, and a call the guard denies for other reasons is not counted", async () => {
  const hooks = externalSpendHooks(pricedServers(), "run-d");
  assert.ok(!denied(await pre("run-d", "mcp__ext__read")));
  assert.ok(denied(await pre("run-d", "mcp__ext__read")), "limit of 1 reached");
  await post(hooks, "mcp__ext__read", false);
  assert.ok(!denied(await pre("run-d", "mcp__ext__read")), "the failed call was given back");
  const unattended = externalToolGuard(pricedServers(), { unattended: true, runId: "run-e" }).hooks[0]!;
  const input = preInput("mcp__ext__post");
  assert.ok(denied(await unattended(input as never, "t", { signal: new AbortController().signal })), "not offered to unattended runs");
  assert.ok(!denied(await pre("run-e", "mcp__ext__post")), "and that denial used none of the run's calls");
});

test("agentOptions wires the guard's limit and the spend hooks to the run's record", async () => {
  writeFile({ ext: priced });
  prepareWorkspace();
  const { RunRecorder } = await import("../runs.ts");
  const recorder = new RunRecorder({ kind: "task", title: "spend wiring" });
  const options = agentOptions({ out: appOutbound(), model: "sonnet", run: recorder });
  const fire = async (event: "PreToolUse" | "PostToolUse" | "PostToolUseFailure", input: object) => {
    const results: unknown[] = [];
    for (const matcher of options.hooks?.[event] ?? []) {
      for (const hook of matcher.hooks) results.push(await hook({ hook_event_name: event, session_id: "s", transcript_path: "", cwd: "", ...input } as never, "t", { signal: new AbortController().signal }));
    }
    return results;
  };
  const call = { tool_name: "mcp__ext__post", tool_input: {}, tool_use_id: "t" };
  assert.ok(!(await fire("PreToolUse", call)).some(denied));
  await fire("PostToolUse", { ...call, tool_response: "ok" });
  assert.ok(!(await fire("PreToolUse", call)).some(denied));
  await fire("PostToolUse", { ...call, tool_response: "ok" });
  assert.ok((await fire("PreToolUse", call)).some(denied), "the third call of the run is denied");
  assert.deepEqual(readExternalSpend().map((e) => e.runId), [recorder.id, recorder.id]);
  recorder.finish("done");
});

// A server name ending in "_" makes the tool name carry three underscores; the server is matched by its prefix, not by splitting.

test("a server named ext_ is offered its tools, and its calls are allowed in the guard", () => {
  const underscored = parseExternalServers({ ext_: entry });
  assert.equal(checkExternalTool(underscored, "mcp__ext___search", false, false), undefined);
  assert.equal(checkExternalTool(underscored, "mcp__ext___post", true, false), "mcp__ext___post is not offered to subagents: the owner's configuration does not name it for that.");
  assert.match(checkExternalTool(underscored, "mcp__ext___delete", false, false) ?? "", /not offered to this run/);
  assert.match(checkExternalTool(underscored, "mcp__ext__search", false, false) ?? "", /no such server/);
});

test("the spend of a call of ext_ is recorded under ext_, and a longer name wins over a shorter one", async () => {
  const both = parseExternalServers({
    ext: { ...entry, spend: { search: { priceUsd: 0.1 } } },
    ext_: { ...entry, spend: { search: { priceUsd: 0.5 } } },
  });
  const hooks = externalSpendHooks(both, "run-underscore");
  await post(hooks, "mcp__ext___search", true);
  await post(hooks, "mcp__ext__search", true);
  assert.deepEqual(readExternalSpend().map((e) => [e.server, e.tool, e.usd]), [["ext_", "search", 0.5], ["ext", "search", 0.1]]);
});

test("maxPerRun counts the calls of ext_, and the limit denies its next call", async () => {
  const limited = parseExternalServers({ ext_: { ...entry, spend: { search: { priceUsd: 0.2, maxPerRun: 1 } } } });
  const guard = externalToolGuard(limited, { unattended: false, runId: "run-ext_" }).hooks[0]!;
  const call = (tool_name: string) => guard(preInput(tool_name) as never, "t", { signal: new AbortController().signal });
  assert.ok(!denied(await call("mcp__ext___search")));
  assert.ok(denied(await call("mcp__ext___search")), "the second call of the run is over its limit");
});
