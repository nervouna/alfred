import assert from "node:assert/strict";
import { test } from "node:test";

import { sanitizeFileName } from "./files.ts";

test("sanitizeFileName strips paths and unsafe characters", () => {
  assert.equal(sanitizeFileName("../../etc/passwd", "x"), "passwd");
  assert.equal(sanitizeFileName("..\\..\\win.ini", "x"), "win.ini");
  assert.equal(sanitizeFileName('a<b>:c"d|e?f*.txt', "x"), "a_b__c_d_e_f_.txt");
  assert.equal(sanitizeFileName(".bashrc", "x"), "_.bashrc");
  assert.equal(sanitizeFileName("..", "fallback.bin"), "fallback.bin");
  assert.equal(sanitizeFileName(undefined, "fallback.bin"), "fallback.bin");
  assert.equal(sanitizeFileName("报告 2026.pdf", "x"), "报告 2026.pdf");
  assert.equal(sanitizeFileName("ALFRED.md", "x"), "_ALFRED.md");
  assert.equal(sanitizeFileName("notes/alfred.md", "x"), "_alfred.md");
});

test("sanitizeFileName cuts a long name to 240 bytes at a code point and keeps its extension", () => {
  const chinese = sanitizeFileName(`${"报".repeat(90)}.pdf`, "x");
  assert.equal(chinese, `${"报".repeat(78)}.pdf`);
  assert.ok(Buffer.byteLength(chinese) <= 240);
  assert.equal(sanitizeFileName(`${"a".repeat(250)}.pdf`, "x"), `${"a".repeat(236)}.pdf`);
  const emoji = sanitizeFileName(`a${"😀".repeat(70)}.txt`, "x");
  assert.equal(emoji, `a${"😀".repeat(58)}.txt`, "no surrogate pair is split");
  assert.ok(Buffer.byteLength(sanitizeFileName(`.${"报".repeat(90)}`, "x")) <= 241, "the hidden-file prefix stays within the room left");
  assert.equal(sanitizeFileName(`${"报".repeat(70)}.${"x".repeat(60)}`, "x"), `${"报".repeat(70)}.${"x".repeat(29)}`, "an overlong extension is cut like the stem");
});
