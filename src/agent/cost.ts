// What a background subagent costs. The SDK reports cost per query and per
// model, not per subagent, and the usage on a subagent's streamed messages is
// the usage at the start of each response: their output_tokens are not final.
// A response's final usage is in the subagent's transcript, so its cost comes
// from there, priced at the rate the query's own modelUsage implies for the
// model. Calls the subagent's tools make on their own (WebFetch summaries on a
// small model, for one) are not in its transcript; they count for the task only.

import fs from "node:fs";
import path from "node:path";

import type { ModelUsage } from "@anthropic-ai/claude-agent-sdk";

/** Anthropic's prices relative to the input-token price: output 5×, cache reads 0.1×, cache writes 1.25× (5-minute TTL). */
const WEIGHTS = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
/** Server-side web search, per request. */
const WEB_SEARCH_USD = 0.01;
const MAX_LINE_BYTES = 1024 * 1024;

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  webSearches: number;
}

function weighted(u: Omit<Usage, "webSearches">): number {
  return u.input * WEIGHTS.input + u.output * WEIGHTS.output + u.cacheRead * WEIGHTS.cacheRead + u.cacheWrite * WEIGHTS.cacheWrite;
}

/** USD per input-token equivalent of each model, from a result's modelUsage. */
export function unitPrices(modelUsage: Record<string, ModelUsage>): Record<string, number> {
  const prices: Record<string, number> = {};
  for (const [model, u] of Object.entries(modelUsage)) {
    const tokens = weighted({ input: u.inputTokens, output: u.outputTokens, cacheRead: u.cacheReadInputTokens, cacheWrite: u.cacheCreationInputTokens });
    if (tokens > 0) prices[model] = Math.max(0, u.costUSD - u.webSearchRequests * WEB_SEARCH_USD) / tokens;
  }
  return prices;
}

/** A subagent's transcript in the session's directory under `projectDir`. */
export function subagentTranscript(projectDir: string, sessionId: string, agentId: string): string {
  return path.join(projectDir, sessionId, "subagents", `agent-${agentId}.jsonl`);
}

/** The usage of a subagent's responses, read from its transcript as it grows. */
export class TranscriptUsage {
  private readonly file: string;
  private offset = 0;
  /** By response id: a response's content blocks are lines of their own, and the last one carries its final usage. */
  private readonly responses = new Map<string, { model: string; usage: Usage }>();

  constructor(file: string) {
    this.file = file;
  }

  /** Reads the lines appended since the last call. A missing file is a transcript not written yet. */
  read(): void {
    let fd: number;
    try {
      fd = fs.openSync(this.file, "r");
    } catch {
      return;
    }
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= this.offset) return;
      const buf = Buffer.alloc(size - this.offset);
      fs.readSync(fd, buf, 0, buf.length, this.offset);
      // Only whole lines: the last one may still be being written.
      const end = buf.lastIndexOf(0x0a);
      if (end < 0) return;
      this.offset += end + 1;
      for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
        if (line.length <= MAX_LINE_BYTES && line.includes('"usage"')) this.take(line);
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  private take(line: string): void {
    let entry: { type?: unknown; message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown> } };
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    const m = entry.message;
    if (entry.type !== "assistant" || typeof m?.id !== "string" || typeof m.model !== "string" || !m.usage) return;
    const n = (v: unknown) => (typeof v === "number" ? v : 0);
    const u = m.usage;
    this.responses.set(m.id, {
      model: m.model,
      usage: {
        input: n(u.input_tokens),
        output: n(u.output_tokens),
        cacheRead: n(u.cache_read_input_tokens),
        cacheWrite: n(u.cache_creation_input_tokens),
        webSearches: n((u.server_tool_use as Record<string, unknown> | undefined)?.web_search_requests),
      },
    });
  }

  /** USD at `prices` (per input-token equivalent, by model); undefined while a model it used has no price. */
  cost(prices: Readonly<Record<string, number>>): number | undefined {
    let usd = 0;
    for (const { model, usage } of this.responses.values()) {
      // Claude Code's own placeholder replies (model "<synthetic>") cost nothing.
      if (model.startsWith("<")) continue;
      const price = prices[model];
      if (price === undefined) return undefined;
      usd += weighted(usage) * price + usage.webSearches * WEB_SEARCH_USD;
    }
    return usd;
  }
}
