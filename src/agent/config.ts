import path from "node:path";

import { STATE_DIR } from "../store.ts";

export const MODELS = {
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
  haiku: "claude-haiku-5-5",
} as const;
export type ModelKey = keyof typeof MODELS;
export const DEFAULT_MODEL: ModelKey = "sonnet";

export function isModelKey(value: string): value is ModelKey {
  return Object.hasOwn(MODELS, value);
}

const GATEWAY_BASE_URL = process.env.ALFRED_ANTHROPIC_BASE_URL ?? "https://ristretto.damao.io/anthropic";

export const MAX_TURNS = 60;
/** Per-task spend cap; the SDK stops the task with error_max_budget_usd when exceeded. */
export const MAX_BUDGET_USD = Number(process.env.ALFRED_MAX_BUDGET_USD ?? "3");

/** Isolated Claude Code config dir: session transcripts live here, apart from the user's own Claude Code. */
export const AGENT_CONFIG_DIR = path.join(STATE_DIR, "claude");

export const BUILTIN_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch"];

/**
 * Environment for the Claude Code subprocess. Inherited CLAUDE* and ANTHROPIC*
 * variables are dropped: an inherited CLAUDE_CODE_ENTRYPOINT (e.g. when started
 * from a Claude Code terminal) makes the API bill the request as Claude Code,
 * which the Max plan's API credits do not cover.
 */
export function agentEnv(): Record<string, string> {
  const { CF_ID, CF_SECRET } = process.env;
  if (!CF_ID || !CF_SECRET) throw new Error("CF_ID and CF_SECRET must be set to reach the LLM gateway");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("CLAUDE") || key.startsWith("ANTHROPIC_")) continue;
    env[key] = value;
  }
  return {
    ...env,
    ANTHROPIC_BASE_URL: GATEWAY_BASE_URL,
    // The gateway strips client credentials and injects the real key.
    ANTHROPIC_API_KEY: "unused",
    ANTHROPIC_CUSTOM_HEADERS: `CF-Access-Client-Id: ${CF_ID}\nCF-Access-Client-Secret: ${CF_SECRET}`,
    CLAUDE_CONFIG_DIR: AGENT_CONFIG_DIR,
    CLAUDE_AGENT_SDK_CLIENT_APP: "alfred/0.1.0",
  };
}

export function systemPrompt(now: Date): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = now.toLocaleDateString("en-CA", { timeZone: tz });
  const weekday = now.toLocaleDateString("en-US", { weekday: "long", timeZone: tz });
  return `You are Alfred, a personal research assistant for one person. They talk to you through WeChat on their phone and see only your final reply, never your tool calls.

Today is ${date} (${weekday}), time zone ${tz}.

# What you do
- Research: search the web, read sources, compare and summarize. Prefer primary and recent sources, cross-check important facts, give dates for time-sensitive facts, and cite sources as links.
- Collect material: when findings are worth keeping, save them as Markdown notes in the workspace.
- Organize files: read, write, edit and search files in the workspace. Use move_file to move or rename; to delete, move the file into .trash/.

# Workspace
Your working directory is the workspace, and nothing outside it is accessible.
- inbox/<date>/  files the user sent (images, PDFs, documents, video)
- reports/  deliverables you write for the user
- notes/  working notes and collected material
- .trash/  deleted files

When a message lists attached files, read them with the Read tool; it handles images and PDFs.

# Replying in WeChat
- Reply in Simplified Chinese unless the user writes in another language.
- Write for a phone screen: lead with the answer, keep paragraphs short and lists compact. Markdown renders except images, so never embed images.
- Keep chat replies under about 1500 characters. For anything longer, such as full reports, comparisons or collected material, write a Markdown file in reports/, deliver it with send_file, and reply with a short summary.
- WeChat opens .md, .pdf, images and Office files, but not .html, so never send HTML.
- For formal reports, anything with charts or wide tables, or anything the user may keep or forward: write Markdown, or self-contained HTML when you need charts, in reports/, convert it with render_pdf, and send the PDF. Draw charts as inline SVG. Rendering is sandboxed: only workspace images, stylesheets and fonts load, by relative path; network URLs, files outside the workspace, iframes and scripts do not.
- If a request is ambiguous in a way that changes the result, ask one short question. Otherwise proceed and state your assumptions.`;
}
