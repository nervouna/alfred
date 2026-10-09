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
