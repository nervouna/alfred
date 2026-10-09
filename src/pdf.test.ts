import assert from "node:assert/strict";
import { test } from "node:test";

import { markdownToHtml } from "./pdf.ts";

test("markdownToHtml renders GFM tables and takes the title from the first H1", () => {
  const html = markdownToHtml("# 报告 <草稿>\n\n| a | b |\n| - | - |\n| 1 | 2 |\n", "fallback");
  assert.match(html, /<title>报告 &lt;草稿&gt;<\/title>/);
  assert.match(html, /<table>/);
  assert.match(html, /<td>2<\/td>/);
  assert.match(html, /@page|font-family/);
});

test("markdownToHtml falls back to the given title without an H1", () => {
  assert.match(markdownToHtml("plain text", "notes"), /<title>notes<\/title>/);
});
