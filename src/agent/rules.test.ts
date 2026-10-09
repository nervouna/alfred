import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { HookInput, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";

import { systemPrompt } from "./config.ts";
import {
  DEFAULT_RULES,
  RULES_MAX_BYTES,
  RulesTracker,
  loadRootRules,
  rulesChangeNotice,
  rulesDirs,
  rulesDisclosure,
  seedRules,
  snapshotRules,
  touchedPaths,
} from "./rules.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-rules-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
/** A fresh workspace with the given files, relative path to content. */
function workspace(files: Record<string, string>): string {
  const root = path.join(tmp, `ws${n++}`);
  fs.mkdirSync(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

function rels(files: { rel: string }[]): string[] {
  return files.map((f) => f.rel);
}

test("seedRules writes the default root ALFRED.md once and never overwrites it", () => {
  const root = workspace({});
  assert.equal(seedRules(root), true);
  assert.equal(fs.readFileSync(path.join(root, "ALFRED.md"), "utf-8"), DEFAULT_RULES);
  fs.writeFileSync(path.join(root, "ALFRED.md"), "# mine");
  assert.equal(seedRules(root), false);
  assert.equal(fs.readFileSync(path.join(root, "ALFRED.md"), "utf-8"), "# mine");
});

test("the root ALFRED.md appears in the system prompt", () => {
  const root = workspace({});
  seedRules(root);
  const prompt = systemPrompt(new Date("2026-10-10T12:00:00Z"), { rootRules: loadRootRules(root) });
  assert.match(prompt, /<workspace-rules path="ALFRED\.md">\n# Workspace rules\n/);
  assert.match(prompt, /- reports\/ {2}deliverables written for the user/);
  assert.match(systemPrompt(new Date()), /There is no root ALFRED\.md right now\./);
});

test("rulesDirs runs from the root to the touched directory and ignores paths outside", () => {
  const root = workspace({ "notes/p/a.md": "a" });
  assert.deepEqual(rulesDirs(root, "notes/p/a.md"), [root, path.join(root, "notes"), path.join(root, "notes/p")]);
  assert.deepEqual(rulesDirs(root, "notes/p"), [root, path.join(root, "notes"), path.join(root, "notes/p")]);
  assert.deepEqual(rulesDirs(root, path.join(root, "reports/new/x.md")), [root, path.join(root, "reports"), path.join(root, "reports/new")]);
  assert.deepEqual(rulesDirs(root, "."), [root]);
  assert.deepEqual(rulesDirs(root, ".trash/notes/a.md"), [root]);
  assert.deepEqual(rulesDirs(root, "../x.md"), []);
  assert.deepEqual(rulesDirs(root, "/etc/hosts"), []);
});

test("nested rules are disclosed only along the touched path, root first", () => {
  const root = workspace({
    "ALFRED.md": "root rules",
    "reports/ALFRED.md": "reports rules",
    "notes/ALFRED.md": "notes rules",
    "notes/p/ALFRED.md": "project rules",
    "notes/p/a.md": "a",
  });
  const tracker = new RulesTracker(root);
  assert.equal(tracker.loadRoot()?.text, "root rules");
  assert.deepEqual(rels(tracker.take(["notes/p/a.md"])), ["notes/ALFRED.md", "notes/p/ALFRED.md"]);
  const reports = tracker.take([path.join(root, "reports/summary.md")]);
  assert.deepEqual(rels(reports), ["reports/ALFRED.md"]);
  assert.equal(reports[0]?.text, "reports rules");
});

test("a file disclosed earlier in the run is not repeated; a changed file is disclosed again", () => {
  const root = workspace({ "reports/ALFRED.md": "v1", "reports/a.md": "a" });
  const tracker = new RulesTracker(root);
  tracker.loadRoot();
  assert.deepEqual(rels(tracker.take(["reports/a.md"])), ["reports/ALFRED.md"]);
  assert.deepEqual(tracker.take(["reports/a.md", "reports/b.md", "reports"]), []);

  const file = path.join(root, "reports/ALFRED.md");
  fs.writeFileSync(file, "v2 rules");
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  const again = tracker.take(["reports/b.md"]);
  assert.deepEqual(rels(again), ["reports/ALFRED.md"]);
  assert.equal(again[0]?.text, "v2 rules");

  // A new run starts with nothing disclosed.
  assert.deepEqual(rels(new RulesTracker(root).take(["reports/a.md"])), ["reports/ALFRED.md"]);
});

test("symlinked rules files and paths that leave the workspace are ignored", () => {
  const root = workspace({ "notes/ALFRED.md": "notes rules", "reports/a.md": "a" });
  const outside = workspace({ "ALFRED.md": "outside rules", "sub/ALFRED.md": "outside sub rules" });
  fs.symlinkSync(path.join(root, "notes/ALFRED.md"), path.join(root, "reports/ALFRED.md"));
  fs.symlinkSync(outside, path.join(root, "escape"));
  fs.symlinkSync(path.join(outside, "ALFRED.md"), path.join(root, "ALFRED.md"));
  const tracker = new RulesTracker(root);
  assert.equal(tracker.loadRoot(), undefined);
  assert.deepEqual(tracker.take(["reports/a.md"]), []);
  assert.deepEqual(tracker.take(["escape/sub/x.md", path.join(outside, "sub/x.md"), "../x"]), []);
  // Reading the link does not count as seeing the file it points to.
  tracker.recordToolUse("Read", { file_path: "reports/ALFRED.md" });
  assert.deepEqual(rels(tracker.take(["notes/a.md"])), ["notes/ALFRED.md"]);
});

test("rules files under .trash/ never apply", () => {
  const root = workspace({ ".trash/ALFRED.md": "dead", ".trash/p/ALFRED.md": "dead too" });
  assert.deepEqual(new RulesTracker(root).take([".trash/p/a.md"]), []);
});

test("rules text is capped", () => {
  const root = workspace({ "reports/ALFRED.md": "规".repeat(RULES_MAX_BYTES) });
  const [rules] = new RulesTracker(root).take(["reports/a.md"]);
  assert.ok(rules?.truncated);
  assert.ok(Buffer.byteLength(rules.text) <= RULES_MAX_BYTES);
  assert.doesNotMatch(rules.text, /�/);
});

test("touchedPaths maps each file tool to the paths it works in", () => {
  assert.deepEqual(touchedPaths("Read", { file_path: "/ws/reports/a.md" }), ["/ws/reports/a.md"]);
  assert.deepEqual(touchedPaths("Write", { file_path: "reports/a.md" }), ["reports/a.md"]);
  assert.deepEqual(touchedPaths("Edit", {}), []);
  assert.deepEqual(touchedPaths("Glob", { pattern: "reports/2026/**/*.md" }), ["reports/2026"]);
  assert.deepEqual(touchedPaths("Glob", { pattern: "*.md", path: "notes" }), ["notes"]);
  assert.deepEqual(touchedPaths("Glob", { pattern: "**/*.md" }), ["."]);
  assert.deepEqual(touchedPaths("Glob", { pattern: "/ws/notes/*.md" }), ["/ws/notes"]);
  assert.deepEqual(touchedPaths("Grep", { pattern: "x" }), ["."]);
  assert.deepEqual(touchedPaths("Grep", { pattern: "x", path: "notes/p" }), ["notes/p"]);
  assert.deepEqual(touchedPaths("Grep", { pattern: "x", glob: "reports/**/*.md" }), ["reports"]);
  assert.deepEqual(touchedPaths("Grep", { pattern: "x", path: "notes", glob: "*.md" }), ["notes"]);
  assert.deepEqual(touchedPaths("Grep", { pattern: "x", glob: "!reports/**" }), ["."]);
  // Content mode returns file lines, so the matched files' directories count as touched.
  const content = "reports/2026/a.md:3:番茄\nreports/2026/a.md-4-context\n--\nnotes/b.md:1:x: y\n";
  assert.deepEqual(touchedPaths("Grep", { pattern: "x" }, { mode: "content", content }), [".", "reports/2026", "notes"]);
  const files = { mode: "files_with_matches", filenames: ["reports/a.md"], numFiles: 1 };
  assert.deepEqual(touchedPaths("Grep", { pattern: "x" }, files), ["."]);
  assert.deepEqual(touchedPaths("mcp__alfred__move_file", { from: "notes/a.md", to: ".trash/a.md" }), ["notes/a.md", ".trash/a.md"]);
  assert.deepEqual(touchedPaths("mcp__alfred__render_pdf", { source: "reports/a.md" }), ["reports/a.md"]);
  assert.deepEqual(touchedPaths("mcp__alfred__generate_image", { prompt: "p" }), ["images"]);
  assert.deepEqual(touchedPaths("mcp__alfred__generate_image", { prompt: "p", output: "reports/cover.jpg" }), ["reports/cover.jpg"]);
  assert.deepEqual(touchedPaths("WebFetch", { url: "https://example.com" }), []);
  assert.deepEqual(touchedPaths("mcp__alfred__send_file", { path: "reports/a.pdf" }), []);
});

function hookInput(
  event: "PostToolUse" | "PostToolUseFailure",
  tool: string,
  input: Record<string, unknown>,
  response: unknown = {},
): HookInput {
  const base = { session_id: "s", transcript_path: "/t", cwd: "/w", tool_name: tool, tool_input: input, tool_use_id: "t1" };
  return event === "PostToolUse"
    ? { ...base, hook_event_name: event, tool_response: response }
    : { ...base, hook_event_name: event, error: "failed" };
}

async function runHook(tracker: RulesTracker, input: HookInput): Promise<string | undefined> {
  const [hook] = rulesDisclosure(tracker).hooks;
  assert.ok(hook);
  const out = (await hook(input, "t1", { signal: new AbortController().signal })) as SyncHookJSONOutput;
  const specific = out.hookSpecificOutput;
  if (!specific) return undefined;
  assert.equal(specific.hookEventName, input.hook_event_name);
  return "additionalContext" in specific ? specific.additionalContext : undefined;
}

test("the hook injects undisclosed rules as additionalContext, also after a failed call", async () => {
  const root = workspace({ "ALFRED.md": "root", "reports/ALFRED.md": "开头加三行摘要", "notes/ALFRED.md": "notes" });
  const tracker = new RulesTracker(root);
  tracker.loadRoot();
  assert.equal(await runHook(tracker, hookInput("PostToolUse", "WebSearch", { query: "x" })), undefined);
  assert.equal(await runHook(tracker, hookInput("PostToolUse", "Read", { file_path: "ALFRED.md" })), undefined);
  const context = await runHook(tracker, hookInput("PostToolUse", "Write", { file_path: path.join(root, "reports/a.md") }));
  assert.match(context ?? "", /<workspace-rules path="reports\/ALFRED\.md">\n开头加三行摘要\n<\/workspace-rules>/);
  assert.doesNotMatch(context ?? "", /notes/);
  assert.equal(await runHook(tracker, hookInput("PostToolUse", "Edit", { file_path: "reports/a.md" })), undefined);
  assert.match((await runHook(tracker, hookInput("PostToolUseFailure", "Read", { file_path: "notes/missing.md" }))) ?? "", /notes\/ALFRED\.md/);
});

test("a workspace-wide Grep discloses the rules of the files whose lines it returned", async () => {
  const root = workspace({ "reports/ALFRED.md": "reports rules", "notes/ALFRED.md": "notes rules" });
  const tracker = new RulesTracker(root);
  const response = { mode: "content", numFiles: 0, filenames: [], content: "reports/a.md:3:番茄" };
  const context = await runHook(tracker, hookInput("PostToolUse", "Grep", { pattern: "番茄", output_mode: "content" }, response));
  assert.match(context ?? "", /path="reports\/ALFRED\.md"/);
  assert.doesNotMatch(context ?? "", /notes/);
});

test("reading or writing a rules file counts as seeing it", async () => {
  const root = workspace({ "reports/ALFRED.md": "old", "notes/ALFRED.md": "notes" });
  const tracker = new RulesTracker(root);
  fs.writeFileSync(path.join(root, "reports/ALFRED.md"), "new rule written by the agent");
  assert.equal(await runHook(tracker, hookInput("PostToolUse", "Write", { file_path: "reports/ALFRED.md" })), undefined);
  assert.deepEqual(tracker.take(["reports/a.md"]), []);
  assert.equal(await runHook(tracker, hookInput("PostToolUse", "Read", { file_path: "notes/alfred.md" })), undefined);
  assert.deepEqual(tracker.take(["notes/a.md"]), []);
});

test("snapshotRules and rulesChangeNotice report created, changed and removed rules files", () => {
  const root = workspace({ "ALFRED.md": "root", "reports/ALFRED.md": "r", "notes/ALFRED.md": "n", ".trash/ALFRED.md": "t" });
  fs.symlinkSync(path.join(root, "notes"), path.join(root, "linked"));
  const before = snapshotRules(root);
  assert.deepEqual([...before.keys()].sort(), ["ALFRED.md", "notes/ALFRED.md", "reports/ALFRED.md"]);
  assert.equal(rulesChangeNotice(before, snapshotRules(root)), undefined);

  fs.writeFileSync(path.join(root, "reports/ALFRED.md"), "r2");
  fs.mkdirSync(path.join(root, "notes/p"));
  fs.writeFileSync(path.join(root, "notes/p/ALFRED.md"), "p");
  fs.renameSync(path.join(root, "notes/ALFRED.md"), path.join(root, ".trash/notes-ALFRED.md"));
  assert.equal(rulesChangeNotice(before, snapshotRules(root)), "已移除 notes/ALFRED.md\n已新建 notes/p/ALFRED.md\n已更新 reports/ALFRED.md");
});
