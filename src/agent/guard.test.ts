// The guard's write scope: each row of #274's "Who writes where" table, as the guard decides it per tool call.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { checkToolInput, scopeViolation } from "./guard.ts";
import type { WriteScope } from "./guard.ts";
import { writeScope } from "./subagents.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-guard-")));
for (const dir of ["bots/tax/notes", "bots/other/notes", "memory", "skills/weekly", "notes", "reports", ".trash", "images"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
after(() => fs.rmSync(root, { recursive: true, force: true }));

type Call = [string, Record<string, unknown>];

function denied(scope: WriteScope, calls: Call[], pattern: RegExp): void {
  for (const [tool, input] of calls) assert.match(checkToolInput(root, tool, input, scope) ?? "", pattern, `${tool} ${JSON.stringify(input)}`);
}

function allowed(scope: WriteScope, calls: Call[]): void {
  for (const [tool, input] of calls) assert.equal(checkToolInput(root, tool, input, scope), undefined, `${tool} ${JSON.stringify(input)}`);
}

test("Alfred's chat writes everything in the workspace but bots/, which it may read", () => {
  const scope = writeScope({});
  denied(
    scope,
    [
      ["Write", { file_path: "bots/tax/notes/a.md" }],
      ["Edit", { file_path: path.join(root, "bots", "other", "ALFRED.md") }],
      ["Write", { file_path: "Bots/tax/new.md" }],
      ["mcp__alfred__move_file", { from: "notes/a.md", to: "bots/tax/notes/a.md" }],
      ["mcp__alfred__move_file", { from: "bots/tax/notes/a.md", to: ".trash/a.md" }],
      ["mcp__alfred__render_pdf", { source: "notes/a.md", output: "bots/tax/a.pdf" }],
      ["mcp__alfred__generate_image", { prompt: "x", output: "bots/tax/x.jpg" }],
    ],
    /bots\/ may be read but not changed/,
  );
  allowed(scope, [
    ["Write", { file_path: "notes/a.md" }],
    ["Write", { file_path: "ALFRED.md" }],
    ["Write", { file_path: "memory/user.md" }],
    ["Write", { file_path: "skills/weekly/SKILL.md" }],
    ["Write", { file_path: "notes/bots/a.md" }],
    ["Read", { file_path: "bots/tax/notes/a.md" }],
    ["Glob", { pattern: "bots/**/*.md" }],
    ["mcp__alfred__generate_image", { prompt: "x" }],
  ]);
});

test("Alfred's unattended runs keep memory/, skills/ and every ALFRED.md read-only and bots/ with them", () => {
  const scope = writeScope({ unattended: true });
  denied(
    scope,
    [
      ["Write", { file_path: "bots/tax/notes/a.md" }],
      ["Write", { file_path: "memory/user.md" }],
      ["Write", { file_path: "skills/weekly/SKILL.md" }],
      ["Edit", { file_path: "reports/ALFRED.md" }],
    ],
    /read-only/,
  );
  allowed(scope, [["Write", { file_path: "reports/tasks/x/a.md" }]]);
});

test("a bot's chat writes only its home, memory/ and .trash/; elsewhere the reason names where it may write", () => {
  const scope = writeScope({ botId: "tax" });
  allowed(scope, [
    ["Write", { file_path: "bots/tax/notes/a.md" }],
    ["Write", { file_path: path.join(root, "bots", "tax", "reports", "new", "r.md") }],
    ["Edit", { file_path: "Bots/Tax/inbox/f.txt" }],
    ["Write", { file_path: "memory/user.md" }],
    ["mcp__alfred__move_file", { from: "bots/tax/notes/a.md", to: ".trash/a.md" }],
    ["mcp__alfred__render_pdf", { source: "bots/tax/reports/r.md" }],
    ["mcp__alfred__generate_image", { prompt: "x", output: "bots/tax/images/x.jpg" }],
    ["Read", { file_path: "notes/a.md" }],
    ["Read", { file_path: "bots/other/notes/a.md" }],
    ["Grep", { pattern: "x", path: "reports" }],
  ]);
  denied(
    scope,
    [
      ["Write", { file_path: "notes/x.md" }],
      ["Write", { file_path: "reports/r.md" }],
      ["Edit", { file_path: "bots/other/notes/a.md" }],
      ["Write", { file_path: "bots/taxes/a.md" }],
      ["Write", { file_path: "bots/a.md" }],
      ["Write", { file_path: "images/x.jpg" }],
      ["Write", { file_path: "bots/tax/../other/a.md" }],
      ["mcp__alfred__move_file", { from: "bots/tax/notes/a.md", to: "notes/a.md" }],
      ["mcp__alfred__move_file", { from: "notes/a.md", to: ".trash/a.md" }],
      ["mcp__alfred__render_pdf", { source: "bots/tax/reports/r.md", output: "reports/r.pdf" }],
      ["mcp__alfred__render_pdf", { source: "reports/r.md" }],
      ["mcp__alfred__generate_image", { prompt: "x" }],
      ["mcp__alfred__save_media", { url: "https://example.com/x.png" }],
      ["mcp__alfred__save_media", { url: "https://example.com/x.png", output: "images/x.png" }],
    ],
    /outside where this run may write: only bots\/tax\/, memory\/, \.trash\/ may be changed/,
  );
});

test("a bot's chat never writes skills/ or an ALFRED.md outside its own home, and its own bots/<id>/ALFRED.md is writable", () => {
  const scope = writeScope({ botId: "tax" });
  denied(
    scope,
    [
      ["Write", { file_path: "skills/weekly/SKILL.md" }],
      ["Write", { file_path: "ALFRED.md" }],
      ["Write", { file_path: "notes/ALFRED.md" }],
      ["Write", { file_path: "memory/ALFRED.md" }],
      ["Write", { file_path: "bots/other/ALFRED.md" }],
    ],
    /read-only|outside where this run may write/,
  );
  // memory/ is writable but an ALFRED.md there is still not, and the reason says why.
  assert.match(checkToolInput(root, "Write", { file_path: "memory/ALFRED.md" }, scope) ?? "", /ALFRED\.md files may be read but not changed/);
  assert.match(checkToolInput(root, "Write", { file_path: "skills/weekly/SKILL.md" }, scope) ?? "", /outside where this run may write/);
  allowed(scope, [
    ["Write", { file_path: "bots/tax/ALFRED.md" }],
    ["Edit", { file_path: "bots/tax/notes/ALFRED.md" }],
  ]);
});

test("the scope is general: allowed prefixes, read-only folders and names, and the prefixes they do not apply under", () => {
  const scope: WriteScope = { allow: ["notes", "reports/drafts"], readOnly: { dirs: ["notes"], names: ["lock.txt"] }, except: ["notes/free"] };
  assert.equal(scopeViolation(root, "Write", { file_path: "reports/drafts/a.md" }, scope), undefined);
  assert.equal(scopeViolation(root, "Write", { file_path: "notes/free/a.md" }, scope), undefined);
  assert.equal(scopeViolation(root, "Write", { file_path: "notes/free/lock.txt" }, scope), undefined, "an exception frees names too");
  assert.match(scopeViolation(root, "Write", { file_path: "notes/a.md" }, scope)?.reason ?? "", /read-only/);
  assert.match(scopeViolation(root, "Write", { file_path: "reports/lock.txt" }, scope)?.reason ?? "", /outside where this run may write/);
  assert.match(scopeViolation(root, "Write", { file_path: "reports/a.md" }, scope)?.reason ?? "", /only notes\/, reports\/drafts\//);
  assert.equal(scopeViolation(root, "Write", { file_path: "reports/a.md" }, {}), undefined, "no field set is the whole workspace");
  assert.equal(scopeViolation(root, "Read", { file_path: "reports/a.md" }, scope), undefined, "reads are not writes");
});

test("a symlink out of a bot's home does not let it write elsewhere", () => {
  fs.symlinkSync(path.join(root, "notes"), path.join(root, "bots", "tax", "link"));
  denied(writeScope({ botId: "tax" }), [["Write", { file_path: "bots/tax/link/a.md" }]], /outside where this run may write/);
});
