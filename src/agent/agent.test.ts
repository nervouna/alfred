import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { checkToolInput, resolveInside } from "./guard.ts";
import { buildPrompt } from "./handler.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-guard-")));
const root = path.join(tmp, "workspace");
const outside = path.join(tmp, "outside");
fs.mkdirSync(path.join(root, "notes"), { recursive: true });
fs.mkdirSync(outside);
fs.writeFileSync(path.join(root, "notes", "a.md"), "a");
fs.writeFileSync(path.join(outside, "secret.txt"), "s");
fs.symlinkSync(outside, path.join(root, "escape"));
fs.symlinkSync(path.join(outside, "missing"), path.join(root, "dangling"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("resolveInside accepts workspace paths, including ones that do not exist yet", () => {
  assert.equal(resolveInside(root, "notes/a.md"), path.join(root, "notes", "a.md"));
  assert.equal(resolveInside(root, path.join(root, "reports", "new.md")), path.join(root, "reports", "new.md"));
  assert.equal(resolveInside(root, "."), root);
});

test("resolveInside rejects traversal, absolute escapes and symlink escapes", () => {
  assert.equal(resolveInside(root, "../outside/secret.txt"), undefined);
  assert.equal(resolveInside(root, "/etc/passwd"), undefined);
  assert.equal(resolveInside(root, "escape/secret.txt"), undefined);
  assert.equal(resolveInside(root, "escape/new.txt"), undefined);
  assert.equal(resolveInside(root, "dangling"), undefined);
  assert.equal(resolveInside(root, `${root}-sibling/x`), undefined);
});

test("checkToolInput guards file tools, Glob and Grep, and ignores other tools", () => {
  assert.equal(checkToolInput(root, "Read", { file_path: "notes/a.md" }), undefined);
  assert.match(checkToolInput(root, "Write", { file_path: "/tmp/x" }) ?? "", /outside the workspace/);
  assert.match(checkToolInput(root, "Edit", {}) ?? "", /needs a file_path/);
  assert.equal(checkToolInput(root, "Glob", { pattern: "**/*.md" }), undefined);
  assert.match(checkToolInput(root, "Glob", { pattern: "../**/*" }) ?? "", /may not contain/);
  assert.match(checkToolInput(root, "Glob", { pattern: "/etc/**" }) ?? "", /outside/);
  assert.match(checkToolInput(root, "Grep", { pattern: "x", path: "/Users" }) ?? "", /outside/);
  assert.equal(checkToolInput(root, "Grep", { pattern: "x", path: "notes" }), undefined);
  assert.equal(checkToolInput(root, "WebFetch", { url: "https://example.com" }), undefined);
});

test("buildPrompt lists attachments, quotes and voice transcripts", () => {
  assert.equal(buildPrompt("hi", { attachments: [], voice: false }), "hi");
  const prompt = buildPrompt("总结一下", { attachments: ["inbox/2026-10-10/a.pdf"], quotedText: "line1\nline2", voice: true });
  assert.match(prompt, /- inbox\/2026-10-10\/a\.pdf/);
  assert.match(prompt, /> line1\n> line2/);
  assert.match(prompt, /\(Voice message, server transcript\)\n总结一下$/);
});
