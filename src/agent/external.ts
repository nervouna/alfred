// External MCP servers: attached only by the owner's file, and each tool only as far as that file offers it.
//
// $STATE_DIR/mcp-servers.json is read at every run start and never written by Alfred; it lives outside the workspace, so
// nothing the agent can write reaches it. It maps a server name to its entry:
//   { "name": { "type": "http", "url": "https://…", "headers": { "Authorization": "env:SOME_VARIABLE" },
//               "tools": [...], "unattended": [...], "subagents": [...], "timeoutMs": 30000,
//               "spend": { "tool": { "priceUsd": 0.04, "maxPerRun": 5 } } } }
// A header value names an environment variable, so no secret is in the file. `tools` is what chat offers, `unattended`
// what task and revision runs also get, `subagents` what subagents may call; the last two default to none and may only
// name tools of `tools`. A subagent of an unattended run needs a name in both. Policy lives in `externalToolGuard`.
// `spend` is about a tool that costs money outside Anthropic: `priceUsd` is the owner's estimate per call, recorded in the
// external spend log (src/spend.ts) for each call that succeeds, and `maxPerRun` caps its calls in one run.

import path from "node:path";

import type { HookCallbackMatcher, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

import { log } from "../log.ts";
import { appendExternalSpend, releaseCall, reserveCall } from "../spend.ts";
import { STATE_DIR, readJson } from "../store.ts";

export const EXTERNAL_SERVERS_FILE = path.join(STATE_DIR, "mcp-servers.json");

/** Alfred's own in-process server, which every run has and the owner's file cannot name. */
export const OWN_SERVER = "alfred";

/** What the owner's file says a tool costs: the estimated price of a call, and how many calls one run may make. Either may be absent. */
export interface ToolSpend {
  priceUsd?: number;
  maxPerRun?: number;
}

export interface ExternalServer {
  name: string;
  url: string;
  /** Header values as read from the environment: never log them or put them in an error. */
  headers: Record<string, string>;
  tools: readonly string[];
  unattended: readonly string[];
  subagents: readonly string[];
  /** By tool name; only tools of `tools`. */
  spend: Readonly<Record<string, ToolSpend>>;
  timeoutMs?: number;
}

/** The file or one of its entries is not valid. The message names the entry and never a header value. */
export class InvalidExternalServers extends Error {}

type Env = Record<string, string | undefined>;

const NAME = /^[A-Za-z0-9_-]+$/;
const ENV_REF = /^env:([A-Za-z_][A-Za-z0-9_]*)$/;
const HEADER_NAME = /^[A-Za-z0-9-]+$/;
const KNOWN = ["type", "url", "headers", "tools", "unattended", "subagents", "spend", "timeoutMs"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolList(name: string, key: string, value: unknown, required: boolean): string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || value.some((t) => typeof t !== "string" || !NAME.test(t))) {
    throw new InvalidExternalServers(`${EXTERNAL_SERVERS_FILE}: "${name}": ${key} must be a list of tool names`);
  }
  if (required && !value.length) throw new InvalidExternalServers(`${EXTERNAL_SERVERS_FILE}: "${name}": ${key} must name at least one tool`);
  return [...new Set(value as string[])];
}

/** The `spend` entry of a server: for each tool it offers, a price and a limit that are numbers fit for them. */
function spendMap(name: string, value: unknown, tools: readonly string[]): Record<string, ToolSpend> {
  const bad = (why: string) => new InvalidExternalServers(`${EXTERNAL_SERVERS_FILE}: "${name}": spend ${why}`);
  if (value === undefined) return {};
  if (!isRecord(value)) throw bad("must be an object with one entry per tool");
  const spend: Record<string, ToolSpend> = {};
  for (const [tool, entry] of Object.entries(value)) {
    if (!tools.includes(tool)) throw bad(`names ${tool}, which tools does not offer`);
    if (!isRecord(entry)) throw bad(`for ${tool} must be an object`);
    const unknown = Object.keys(entry).find((key) => key !== "priceUsd" && key !== "maxPerRun");
    if (unknown) throw bad(`for ${tool} has an unknown field ${unknown}`);
    const { priceUsd, maxPerRun } = entry;
    if (priceUsd !== undefined && (typeof priceUsd !== "number" || !Number.isFinite(priceUsd) || priceUsd < 0)) {
      throw bad(`priceUsd for ${tool} must be a number of at least 0`);
    }
    if (maxPerRun !== undefined && (typeof maxPerRun !== "number" || !Number.isInteger(maxPerRun) || maxPerRun < 1)) {
      throw bad(`maxPerRun for ${tool} must be a whole number of at least 1`);
    }
    spend[tool] = { ...(priceUsd === undefined ? {} : { priceUsd }), ...(maxPerRun === undefined ? {} : { maxPerRun }) };
  }
  return spend;
}

/** Checks the parsed file and reads each header from `env`. Throws InvalidExternalServers naming the entry. */
export function parseExternalServers(raw: unknown, env: Env = process.env): ExternalServer[] {
  const bad = (name: string, why: string) => new InvalidExternalServers(`${EXTERNAL_SERVERS_FILE}: "${name}": ${why}`);
  if (!isRecord(raw)) throw new InvalidExternalServers(`${EXTERNAL_SERVERS_FILE}: must be an object with one entry per server`);
  const servers: ExternalServer[] = [];
  for (const [name, entry] of Object.entries(raw)) {
    if (!NAME.test(name) || name.includes("__")) throw bad(name, "the name may hold only letters, digits, - and single _");
    if (name.toLowerCase() === OWN_SERVER) throw bad(name, `the name ${OWN_SERVER} is reserved for Alfred's own tools`);
    if (!isRecord(entry)) throw bad(name, "must be an object");
    const unknown = Object.keys(entry).find((key) => !KNOWN.includes(key));
    if (unknown) throw bad(name, `unknown field ${unknown}`);
    if (entry.type !== "http") throw bad(name, 'type must be "http"');
    let url: URL | undefined;
    try {
      url = typeof entry.url === "string" ? new URL(entry.url) : undefined;
    } catch {
      // Reported below.
    }
    if (!url) throw bad(name, "url must be a URL");
    if (url.protocol !== "https:") throw bad(name, "url must be https");
    if (url.username || url.password) throw bad(name, "url must not hold credentials; use headers");
    const headers: Record<string, string> = {};
    if (entry.headers !== undefined && !isRecord(entry.headers)) throw bad(name, "headers must be an object");
    for (const [header, ref] of Object.entries(entry.headers ?? {})) {
      const variable = typeof ref === "string" ? ENV_REF.exec(ref)?.[1] : undefined;
      if (!HEADER_NAME.test(header) || !variable) throw bad(name, `header ${header} must be a value of the form env:VARIABLE_NAME`);
      const value = env[variable];
      if (!value) throw bad(name, `header ${header} names ${variable}, which is not set`);
      headers[header] = value;
    }
    const tools = toolList(name, "tools", entry.tools, true);
    const unattended = toolList(name, "unattended", entry.unattended, false);
    const subagents = toolList(name, "subagents", entry.subagents, false);
    for (const [key, list] of [["unattended", unattended], ["subagents", subagents]] as const) {
      const extra = list.find((t) => !tools.includes(t));
      if (extra) throw bad(name, `${key} names ${extra}, which tools does not offer`);
    }
    const spend = spendMap(name, entry.spend, tools);
    const { timeoutMs } = entry;
    if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1000)) {
      throw bad(name, "timeoutMs must be a whole number of at least 1000");
    }
    servers.push({ name, url: url.href, headers, tools, unattended, subagents, spend, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  }
  return servers;
}

/** Reads the owner's file: no file means no external servers. Throws InvalidExternalServers (or the read's own error) when it is malformed. */
export function loadExternalServers(file: string = EXTERNAL_SERVERS_FILE, env: Env = process.env): ExternalServer[] {
  let raw: unknown;
  try {
    raw = readJson<unknown>(file);
  } catch (err) {
    if (err instanceof SyntaxError) throw new InvalidExternalServers(`${file}: not valid JSON`);
    throw err;
  }
  return raw === undefined ? [] : parseExternalServers(raw, env);
}

/**
 * The servers a run starts with. A file that went bad after startup offers nothing (Alfred refuses to start on one, so this
 * is an edit made while it runs) and the run carries on without external tools.
 */
export function externalServersForRun(): ExternalServer[] {
  try {
    return loadExternalServers();
  } catch (err) {
    log.error(`external MCP servers not attached: ${err instanceof Error ? err.message : "unreadable"}`);
    return [];
  }
}

/** What the main thread of a run may call on `server`. */
function mainTools(server: ExternalServer, unattended: boolean): readonly string[] {
  return unattended ? server.unattended : server.tools;
}

/** What a subagent of a run may call on `server`: what the configuration names for subagents, and for an unattended run also what that run is offered. */
function subagentTools(server: ExternalServer, unattended: boolean): readonly string[] {
  return unattended ? server.subagents.filter((t) => server.unattended.includes(t)) : server.subagents;
}

/** The servers to hand the SDK for this run and the tool names to allow: a server none of whose tools the run is offered is left out. */
export function externalOffer(servers: readonly ExternalServer[], unattended: boolean): { mcpServers: Record<string, McpServerConfig>; allowedTools: string[] } {
  const mcpServers: Record<string, McpServerConfig> = {};
  const allowedTools: string[] = [];
  for (const server of servers) {
    const tools = mainTools(server, unattended);
    if (!tools.length) continue;
    mcpServers[server.name] = {
      type: "http",
      url: server.url,
      ...(Object.keys(server.headers).length ? { headers: server.headers } : {}),
      ...(server.timeoutMs === undefined ? {} : { timeout: server.timeoutMs }),
    };
    allowedTools.push(...tools.map((t) => `mcp__${server.name}__${t}`));
  }
  return { mcpServers, allowedTools };
}

/** A denial reason when `toolName` is an MCP tool that is not Alfred's own and this run or thread is not offered, else undefined. */
export function checkExternalTool(servers: readonly ExternalServer[], toolName: string, inSubagent: boolean, unattended: boolean): string | undefined {
  if (!toolName.startsWith("mcp__") || toolName.startsWith(`mcp__${OWN_SERVER}__`)) return undefined;
  const [, serverName, ...rest] = toolName.split("__");
  const tool = rest.join("__");
  const server = servers.find((s) => s.name === serverName);
  if (!server) return `${toolName} is not offered: no such server is configured.`;
  const offered = inSubagent ? subagentTools(server, unattended) : mainTools(server, unattended);
  if (offered.includes(tool)) return undefined;
  const where = inSubagent ? "to subagents" : unattended ? "to unattended runs" : "to this run";
  return `${toolName} is not offered ${where}: the owner's configuration does not name it for that.`;
}

/** The server, the tool and what the file says the tool costs, for a call of `toolName` on a configured server. */
function spendOf(servers: readonly ExternalServer[], toolName: string): { server: string; tool: string; spend: ToolSpend } | undefined {
  if (!toolName.startsWith("mcp__") || toolName.startsWith(`mcp__${OWN_SERVER}__`)) return undefined;
  const [, serverName, ...rest] = toolName.split("__");
  const tool = rest.join("__");
  const spend = servers.find((s) => s.name === serverName)?.spend[tool];
  return spend && serverName ? { server: serverName, tool, spend } : undefined;
}

/**
 * PreToolUse hook: denies any MCP tool of an external server that the owner's configuration does not offer to this run or, for a
 * subagent, to subagents. A call that is offered is also counted against the tool's `maxPerRun` in the run `runId` (a subagent's
 * calls count in the run that started it) and denied, with a reason that says not to retry, once the run has made that many.
 */
export function externalToolGuard(servers: readonly ExternalServer[], options: { unattended: boolean; runId?: string }): HookCallbackMatcher {
  return {
    hooks: [
      async (input) => {
        if (input.hook_event_name !== "PreToolUse") return {};
        const reason = checkExternalTool(servers, input.tool_name, Boolean(input.agent_id), options.unattended) ?? checkRunLimit(servers, input.tool_name, options.runId);
        if (!reason) return {};
        log.warn(`denied ${input.tool_name}${input.agent_id ? ` in subagent ${input.agent_type ?? input.agent_id}` : ""}: ${reason}`);
        return {
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
        };
      },
    ],
  };
}

/** A denial reason when this run has already made the `maxPerRun` calls the file allows of the tool; otherwise the call is counted. */
function checkRunLimit(servers: readonly ExternalServer[], toolName: string, runId: string | undefined): string | undefined {
  const found = spendOf(servers, toolName);
  const max = found?.spend.maxPerRun;
  if (!found || max === undefined || runId === undefined) return undefined;
  if (reserveCall(runId, toolName, max)) return undefined;
  return `${toolName} has reached its limit of ${max} call${max === 1 ? "" : "s"} in this run, because each call costs money. Do not retry it, in this run or through a subagent: go on without it, or say in your reply that the limit stopped you.`;
}

/**
 * PostToolUse and PostToolUseFailure hooks of the tools that have a price: a call that succeeded is appended to the external
 * spend log with the tool's `priceUsd` (an estimate); one that failed leaves no entry and is given back to the run's
 * `maxPerRun` count. `runId` is the run the calls belong to.
 */
export function externalSpendHooks(servers: readonly ExternalServer[], runId: string): { postToolUse: HookCallbackMatcher; postToolUseFailure: HookCallbackMatcher } {
  return {
    postToolUse: {
      hooks: [
        async (input) => {
          if (input.hook_event_name !== "PostToolUse") return {};
          const found = spendOf(servers, input.tool_name);
          if (!found) return {};
          if ((input.tool_response as { isError?: unknown } | null)?.isError === true) {
            releaseCall(runId, input.tool_name);
            return {};
          }
          if (found.spend.priceUsd !== undefined) {
            appendExternalSpend({ at: new Date().toISOString(), runId, server: found.server, tool: found.tool, units: 1, usd: found.spend.priceUsd, estimated: true });
          }
          return {};
        },
      ],
    },
    postToolUseFailure: {
      hooks: [
        async (input) => {
          if (input.hook_event_name === "PostToolUseFailure" && spendOf(servers, input.tool_name)) releaseCall(runId, input.tool_name);
          return {};
        },
      ],
    },
  };
}
