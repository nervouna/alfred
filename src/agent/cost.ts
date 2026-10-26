// What a background subagent costs, and what a run's responses cost before a result reports them. The SDK reports cost per
// query and per model, not per subagent, and the usage on a subagent's streamed messages is the usage at the start of each
// response: their output_tokens are not final. A response's final usage is in the subagent's transcript, so its cost comes
// from there, priced at the rate the query's own modelUsage implies for the model. Calls the subagent's tools make on their own
// (WebFetch summaries on a small model, for one) are not in its transcript; they count for the task only.
//
// A result reports the cost of the responses its turn carried. A run that ends without a result for its last turn (a stop,
// or its task paused or ended) has responses that no result reported: its stream carried them (see ResponseLedger), and they
// are priced at the rate the last results implied for their model (unitPrices).

import fs from "node:fs";
import path from "node:path";

import type { ModelUsage, SDKPartialAssistantMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * Anthropic's prices relative to the input-token price: output 5×, cache reads 0.1×, cache writes 1.25× with the 5-minute TTL
 * and 2× with the 1-hour TTL.
 */
const WEIGHTS = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 };
/** Server-side web search, per request. */
const WEB_SEARCH_USD = 0.01;
const MAX_LINE_BYTES = 1024 * 1024;

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  /** Cache writes with the 5-minute TTL. */
  cacheWrite: number;
  /** Cache writes with the 1-hour TTL. */
  cacheWrite1h: number;
  webSearches: number;
}

function weighted(u: Omit<Usage, "webSearches">): number {
  return (
    u.input * WEIGHTS.input +
    u.output * WEIGHTS.output +
    u.cacheRead * WEIGHTS.cacheRead +
    u.cacheWrite * WEIGHTS.cacheWrite +
    u.cacheWrite1h * WEIGHTS.cacheWrite1h
  );
}

/** USD of a usage at `price` per input-token equivalent, web searches included. */
function priceUsage(u: Usage, price: number): number {
  return weighted(u) * price + u.webSearches * WEB_SEARCH_USD;
}

/** USD per input-token equivalent of each model, from a result's modelUsage. */
export function unitPrices(modelUsage: Record<string, ModelUsage>): Record<string, number> {
  const prices: Record<string, number> = {};
  for (const [model, u] of Object.entries(modelUsage)) {
    // modelUsage does not split the cache writes by TTL, so they are weighted at the 5-minute rate.
    const tokens = weighted({ input: u.inputTokens, output: u.outputTokens, cacheRead: u.cacheReadInputTokens, cacheWrite: u.cacheCreationInputTokens, cacheWrite1h: 0 });
    if (tokens > 0) prices[model] = Math.max(0, u.costUSD - u.webSearchRequests * WEB_SEARCH_USD) / tokens;
  }
  return prices;
}

/** A response's usage as the API gives it, in a stream or a transcript. A count that is not a number is zero. */
interface ApiUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_creation?: unknown;
  server_tool_use?: unknown;
}

const count = (v: unknown): number => (typeof v === "number" ? v : 0);

/**
 * A response's usage. Cache writes are split by TTL where the usage gives the split (`cache_creation`); a write without a
 * TTL counts with `unsplitTtl`.
 */
function usageOf(u: ApiUsage | undefined, unsplitTtl: "5m" | "1h"): Usage {
  const split = (u?.cache_creation ?? {}) as Record<string, unknown>;
  const fiveMinutes = count(split.ephemeral_5m_input_tokens);
  const oneHour = count(split.ephemeral_1h_input_tokens);
  const unsplit = Math.max(0, count(u?.cache_creation_input_tokens) - fiveMinutes - oneHour);
  return {
    input: count(u?.input_tokens),
    output: count(u?.output_tokens),
    cacheRead: count(u?.cache_read_input_tokens),
    cacheWrite: fiveMinutes + (unsplitTtl === "5m" ? unsplit : 0),
    cacheWrite1h: oneHour + (unsplitTtl === "1h" ? unsplit : 0),
    webSearches: count((u?.server_tool_use as Record<string, unknown> | null | undefined)?.web_search_requests),
  };
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
    this.responses.set(m.id, { model: m.model, usage: usageOf(m.usage, "5m") });
  }

  /** USD at `prices` (per input-token equivalent, by model); undefined while a model it used has no price. */
  cost(prices: Readonly<Record<string, number>>): number | undefined {
    let usd = 0;
    for (const { model, usage } of this.responses.values()) {
      // Claude Code's own placeholder replies (model "<synthetic>") cost nothing.
      if (model.startsWith("<")) continue;
      const price = prices[model];
      if (price === undefined) return undefined;
      usd += priceUsage(usage, price);
    }
    return usd;
  }
}

/**
 * The responses a run's stream carried that no result has reported. A response opens with message_start, which gives its id,
 * its model and its input and cache counts; its message_delta gives the output tokens and web searches it ended with, which
 * replace the start's. A result settles the responses before it, since its cost covers the turn they belong to. A stream is
 * told apart by its parent (a subagent's responses carry its Agent call's id), so streams that interleave do not mix.
 */
export class ResponseLedger {
  private readonly responses = new Map<string, { model: string; usage: Usage }>();
  /** The response each stream is in the middle of, by parent ("" for the main agent). */
  private readonly open = new Map<string, string>();

  /** Takes one of the run's messages; anything but a stream event changes nothing. */
  observe(m: SDKPartialAssistantMessage): void {
    const stream = m.parent_tool_use_id ?? "";
    const { event } = m;
    if (event.type === "message_start") {
      this.responses.set(event.message.id, { model: event.message.model, usage: usageOf(event.message.usage, "1h") });
      this.open.set(stream, event.message.id);
    } else if (event.type === "message_delta") {
      const response = this.responses.get(this.open.get(stream) ?? "");
      if (!response) return;
      // A stream event never throws here: a message without its usage counts nothing.
      response.usage.output = count(event.usage?.output_tokens);
      const tools = event.usage?.server_tool_use;
      if (tools) response.usage.webSearches = count(tools.web_search_requests);
    } else if (event.type === "message_stop") {
      this.open.delete(stream);
    }
  }

  /** A result arrived: the responses carried so far are reported by it. */
  settle(): void {
    this.responses.clear();
  }

  /**
   * What the unreported responses cost at `prices` (see unitPrices), in total and by model. A model with no price adds nothing
   * and is listed in `unpriced`. Claude Code's placeholder replies (model "<synthetic>") cost nothing, as in TranscriptUsage.
   */
  estimate(prices: Readonly<Record<string, number>>): { usd: number; byModel: Record<string, number>; unpriced: string[] } {
    let usd = 0;
    const byModel: Record<string, number> = {};
    const unpriced = new Set<string>();
    for (const { model, usage } of this.responses.values()) {
      // A response without a model cannot be priced; it is skipped rather than failing the run's cleanup.
      if (!model || model.startsWith("<")) continue;
      const price = prices[model];
      if (price === undefined) {
        unpriced.add(model);
        continue;
      }
      const spent = priceUsage(usage, price);
      usd += spent;
      byModel[model] = (byModel[model] ?? 0) + spent;
    }
    return { usd, byModel, unpriced: [...unpriced] };
  }
}
