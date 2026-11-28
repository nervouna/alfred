// What a bot's chat run is offered: always the file tools, Skill, the question tool and deliver, move_file and render_pdf;
// beyond them only what the bot's `tools` name, and still only what the owner's external tool policy offers.

import type { Bot } from "../api/schema.ts";
import { FILE_TOOLS } from "./config.ts";
import type { ExternalServer } from "./external.ts";
import { OWN_SERVER } from "./external.ts";

const WEB_TOOLS = ["WebSearch", "WebFetch"];
const IMAGE_TOOL = `mcp__${OWN_SERVER}__generate_image`;
/** The tools Alfred's own server gives every bot's run. */
const BOT_ALFRED_TOOLS = ["mcp__alfred__deliver", "mcp__alfred__move_file", "mcp__alfred__render_pdf"];

export interface BotToolOffer {
  /** The built-in tools: file tools, Skill, and what the bot names of WebSearch, WebFetch and Agent (which brings TaskStop). */
  builtin: string[];
  /** Alfred's own tools: deliver, move_file and render_pdf, and generate_image when the bot names it. */
  alfred: string[];
  /** Whether Alfred's own generate_image is named; a configured server's image tool may still replace it. */
  generateImage: boolean;
  /** Whether the Agent tool, with TaskStop and the subagent roles, is offered. */
  agent: boolean;
  /** The configured servers, narrowed to the tools the bot names: a server it names nothing of keeps none. */
  servers: ExternalServer[];
  /** Names in `bot.tools` that are none of the above, for the log. */
  ignored: string[];
}

/** The configured server of a full tool name `mcp__<server>__<tool>`, by the longest server prefix: a server name may end in "_". */
function serverOfFullName(servers: readonly ExternalServer[], name: string): { server: ExternalServer; tool: string } | undefined {
  let found: { server: ExternalServer; tool: string } | undefined;
  for (const server of servers) {
    const prefix = `mcp__${server.name}__`;
    if (name.startsWith(prefix) && (!found || prefix.length > `mcp__${found.server.name}__`.length)) found = { server, tool: name.slice(prefix.length) };
  }
  return found;
}

/** What `bot.tools` gives a run, given the servers the owner configured (before any policy of theirs narrows a call further). */
export function botToolOffer(bot: Pick<Bot, "tools">, configured: readonly ExternalServer[]): BotToolOffer {
  const named = new Set(bot.tools);
  const ignored: string[] = [];
  const wholeServers = new Set<string>();
  const toolsOf = new Map<string, Set<string>>();
  for (const name of bot.tools) {
    if (WEB_TOOLS.includes(name) || name === "Agent" || name === IMAGE_TOOL) continue;
    const whole = configured.find((s) => name === `mcp__${s.name}`);
    if (whole) {
      wholeServers.add(whole.name);
      continue;
    }
    const full = serverOfFullName(configured, name);
    if (full && full.server.name !== OWN_SERVER) {
      toolsOf.set(full.server.name, (toolsOf.get(full.server.name) ?? new Set()).add(full.tool));
      continue;
    }
    ignored.push(name);
  }
  const agent = named.has("Agent");
  const keep = (server: ExternalServer, tools: readonly string[]) =>
    wholeServers.has(server.name) ? [...tools] : tools.filter((tool) => toolsOf.get(server.name)?.has(tool));
  return {
    builtin: [...FILE_TOOLS, ...WEB_TOOLS.filter((t) => named.has(t)), "Skill", ...(agent ? ["Agent", "TaskStop"] : [])],
    alfred: [...BOT_ALFRED_TOOLS, ...(named.has(IMAGE_TOOL) ? [IMAGE_TOOL] : [])],
    generateImage: named.has(IMAGE_TOOL),
    agent,
    servers: configured
      .filter((server) => server.name !== OWN_SERVER)
      .map((server) => ({ ...server, tools: keep(server, server.tools), unattended: keep(server, server.unattended), subagents: keep(server, server.subagents) })),
    ignored,
  };
}
