import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { SDKPartialAssistantMessage } from "@anthropic-ai/claude-agent-sdk";

import { ResponseLedger, TranscriptUsage, subagentTranscript, unitPrices } from "./cost.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alfred-cost-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function line(id: string, model: string, usage: Record<string, unknown>, type = "assistant"): string {
  return JSON.stringify({ type, message: { id, model, usage } });
}

function modelUsage(costUSD: number, t: { input: number; output: number; cacheRead: number; cacheWrite: number; webSearches?: number }) {
  return {
    inputTokens: t.input,
    outputTokens: t.output,
    cacheReadInputTokens: t.cacheRead,
    cacheCreationInputTokens: t.cacheWrite,
    webSearchRequests: t.webSearches ?? 0,
    costUSD,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
  };
}

test("unit prices follow from modelUsage at Anthropic's price ratios, web searches aside", () => {
  // A production query's Sonnet usage, all of it from two subagents, and the cost the SDK reported for it.
  // Its cache writes are weighted 2× (1-hour), so the price is the cost over 44 + 5×39,902 + 0.1×607,136 + 2×133,596 tokens.
  const sonnet = modelUsage(0.8545252, { input: 44, output: 39_902, cacheRead: 607_136, cacheWrite: 133_596 });
  assert.ok(Math.abs((unitPrices({ sonnet }).sonnet ?? 0) - 0.8545252 / 527_459.6) < 1e-12);
  const searching = modelUsage(0.0015 + 0.03, { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, webSearches: 3 });
  assert.ok(Math.abs((unitPrices({ haiku: searching }).haiku ?? 0) - 1e-6) < 1e-12);
  assert.deepEqual(unitPrices({ empty: modelUsage(0, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) }), {});
});

test("a cache write costs 2× the input price, so a result's unit price is the input price and reproduces its cost", () => {
  // Every agent call caches for an hour (#125), and modelUsage does not split the writes by TTL: 1000 writes at 2× $1 per million.
  const writes = modelUsage(0.002, { input: 0, output: 0, cacheRead: 0, cacheWrite: 1000 });
  assert.ok(Math.abs((unitPrices({ sonnet: writes }).sonnet ?? 0) - 1e-6) < 1e-12);

  // The same writes as a stream carries them, with no TTL in the usage: the estimate at that price is the result's cost.
  const ledger = new ResponseLedger();
  ledger.observe(stream({ type: "message_start", message: { id: "w1", model: "sonnet", usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1000 } } }));
  ledger.observe(stream({ type: "message_stop" }));
  assert.ok(Math.abs(ledger.estimate({ sonnet: 1e-6 }).usd - 0.002) < 1e-12);

  // A mixed usage: input 1000, output 500, reads 2000, writes 1000 is 1000 + 5×500 + 0.1×2000 + 2×1000 = 5700 tokens, for $0.0057.
  const mixed = modelUsage(0.0057, { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 1000 });
  const prices = unitPrices({ sonnet: mixed });
  assert.ok(Math.abs((prices.sonnet ?? 0) - 1e-6) < 1e-12);
  const replay = new ResponseLedger();
  replay.observe(stream({ type: "message_start", message: { id: "w2", model: "sonnet", usage: { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 2000, cache_creation_input_tokens: 1000 } } }));
  replay.observe(stream({ type: "message_delta", delta: {}, usage: { output_tokens: 500 } }));
  replay.observe(stream({ type: "message_stop" }));
  assert.ok(Math.abs(replay.estimate(prices).usd - 0.0057) < 1e-12);
});

test("a transcript's usage counts each response once, at its last line, and only whole lines", () => {
  const file = subagentTranscript(tmp, "session-1", "a1");
  assert.equal(file, path.join(tmp, "session-1", "subagents", "agent-a1.jsonl"));
  const usage = new TranscriptUsage(file);
  usage.read();
  assert.equal(usage.cost({}), 0, "a transcript not written yet costs nothing");

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const partial = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000 };
  const final = { ...partial, output_tokens: 400, server_tool_use: { web_search_requests: 2 } };
  fs.writeFileSync(
    file,
    [
      line("m1", "sonnet", partial),
      line("m1", "sonnet", final),
      line("m1", "sonnet", final, "user"),
      line("e1", "<synthetic>", { input_tokens: 0, output_tokens: 0 }),
      "not json with \"usage\"",
      "",
    ].join("\n") + line("m2", "sonnet", partial),
  );
  usage.read();
  // 10 + 5×400 + 2×1000 = 4010 input-token equivalents, plus two searches; m2's line is not finished.
  const first = 4010 * 2e-6 + 0.02;
  assert.ok(Math.abs((usage.cost({ sonnet: 2e-6 }) ?? 0) - first) < 1e-12);
  assert.equal(usage.cost({}), undefined, "no price for a model it used");

  fs.appendFileSync(file, `\n${line("m2", "sonnet", { ...partial, output_tokens: 50 })}\n`);
  usage.read();
  // m2: 10 + 5×50 + 2×1000 = 2260 more.
  assert.ok(Math.abs((usage.cost({ sonnet: 2e-6 }) ?? 0) - (first + 2260 * 2e-6)) < 1e-12);
});

test("a transcript's cache write with the 1-hour TTL, or with none, is weighted 2×, and one with the 5-minute TTL 1.25×", () => {
  const file = subagentTranscript(tmp, "session-2", "a2");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const split = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 } };
  const unsplit = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 50 };
  fs.writeFileSync(file, `${line("m1", "sonnet", split)}\n${line("m2", "sonnet", unsplit)}\n`);
  const usage = new TranscriptUsage(file);
  usage.read();
  // m1: 100 at 1.25 and 200 at 2; m2's 50 have no TTL, so they count at the 1-hour rate, as a stream's do.
  assert.ok(Math.abs((usage.cost({ sonnet: 1 }) ?? 0) - (125 + 400 + 100)) < 1e-9);
});

/** A stream message of the main agent, or of a subagent with its Agent call's id. */
function stream(event: object, parent: string | null = null): SDKPartialAssistantMessage {
  return { type: "stream_event", event, parent_tool_use_id: parent, uuid: "00000000-0000-4000-8000-000000000000", session_id: "s" } as SDKPartialAssistantMessage;
}

test("a ledger prices the responses no result reported, from each response's final output and TTL split, and a result settles them", () => {
  const ledger = new ResponseLedger();
  // Input, cache and TTL come with message_start; the output tokens and web searches of a response come with its message_delta.
  ledger.observe(
    stream({
      type: "message_start",
      message: { id: "r1", model: "sonnet", usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 200 } } },
    }),
  );
  ledger.observe(stream({ type: "message_delta", delta: {}, usage: { output_tokens: 50, server_tool_use: null } }));
  ledger.observe(stream({ type: "message_stop" }));
  // 100 + 5×50 + 0.1×1000 + 2×200 = 850 input-token equivalents.
  assert.ok(Math.abs(ledger.estimate({ sonnet: 1e-6 }).usd - 0.00085) < 1e-12);

  // A subagent's response interleaves with the main agent's, which has no price: the subagent's is priced, with two searches.
  ledger.observe(stream({ type: "message_start", message: { id: "r2", model: "haiku", usage: { input_tokens: 5, output_tokens: 1 } } }));
  ledger.observe(
    stream({ type: "message_start", message: { id: "s1", model: "sonnet", usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 0 } } } }, "toolu_x"),
  );
  ledger.observe(stream({ type: "message_delta", delta: {}, usage: { output_tokens: 20, server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 } } }, "toolu_x"));
  ledger.observe(stream({ type: "message_delta", delta: {}, usage: { output_tokens: 7, server_tool_use: null } }));
  ledger.observe(stream({ type: "message_stop" }, "toolu_x"));
  ledger.observe(stream({ type: "message_stop" }));
  const estimate = ledger.estimate({ sonnet: 1e-6 });
  // The subagent's: 10 + 5×20 + 1.25×1000 = 1360 input-token equivalents, plus two searches. The haiku response adds nothing.
  assert.ok(Math.abs(estimate.usd - 0.00085 - (0.00136 + 0.02)) < 1e-12);
  assert.deepEqual(estimate.unpriced, ["haiku"]);
  assert.deepEqual(Object.keys(estimate.byModel), ["sonnet"]);

  ledger.settle();
  assert.deepEqual(ledger.estimate({ sonnet: 1e-6 }), { usd: 0, byModel: {}, unpriced: [] });
});

test("a ledger counts a cache write whose TTL the usage does not give as a 1-hour one", () => {
  const ledger = new ResponseLedger();
  ledger.observe(stream({ type: "message_start", message: { id: "u1", model: "sonnet", usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 300 } } }));
  ledger.observe(stream({ type: "message_stop" }));
  // 300 cache writes at 2× the input price.
  assert.ok(Math.abs(ledger.estimate({ sonnet: 1 }).usd - 600) < 1e-9);
});
