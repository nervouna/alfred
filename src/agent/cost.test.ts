import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { TranscriptUsage, subagentTranscript, unitPrices } from "./cost.ts";

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
  const sonnet = modelUsage(0.8545252, { input: 44, output: 39_902, cacheRead: 607_136, cacheWrite: 133_596 });
  assert.ok(Math.abs((unitPrices({ sonnet }).sonnet ?? 0) - 2e-6) < 1e-12);
  const searching = modelUsage(0.0015 + 0.03, { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, webSearches: 3 });
  assert.ok(Math.abs((unitPrices({ haiku: searching }).haiku ?? 0) - 1e-6) < 1e-12);
  assert.deepEqual(unitPrices({ empty: modelUsage(0, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) }), {});
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
  // 10 + 5×400 + 1.25×1000 = 3260 input-token equivalents, plus two searches; m2's line is not finished.
  const first = 3260 * 2e-6 + 0.02;
  assert.ok(Math.abs((usage.cost({ sonnet: 2e-6 }) ?? 0) - first) < 1e-12);
  assert.equal(usage.cost({}), undefined, "no price for a model it used");

  fs.appendFileSync(file, `\n${line("m2", "sonnet", { ...partial, output_tokens: 50 })}\n`);
  usage.read();
  assert.ok(Math.abs((usage.cost({ sonnet: 2e-6 }) ?? 0) - (first + 1510 * 2e-6)) < 1e-12);
});
