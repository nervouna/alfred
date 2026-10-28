import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, mock, test } from "node:test";

import type { HookInput, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";

import { RulesSchema } from "../api/schema.ts";
import { Versions } from "../documents/versions.ts";
import { systemPrompt } from "./config.ts";
import {
  DEFAULT_RULES,
  RULES_MAX_BYTES,
  RULES_READ_MAX_BYTES,
  RulesTracker,
  loadRootRules,
  readRulesForOwner,
  rulesChangeNotice,
  rulesCommands,
  rulesDirs,
  rulesDisclosure,
  saveRules,
  seedRules,
  snapshotRules,
  touchedPaths,
  watchRules,
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
  assert.deepEqual(touchedPaths("mcp__alfred__deliver", { path: "reports/a.pdf" }), []);
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

test("snapshotRules and rulesChangeNotice cover every file under skills/", () => {
  const root = workspace({
    "skills/weekly/SKILL.md": "w",
    "skills/weekly/template.md": "t",
    "skills/old/SKILL.md": "o",
    "notes/skills/SKILL.md": "not a skill",
  });
  fs.symlinkSync(path.join(root, "notes"), path.join(root, "skills", "linked"));
  const before = snapshotRules(root);
  assert.deepEqual([...before.keys()].sort(), ["skills/old/SKILL.md", "skills/weekly/SKILL.md", "skills/weekly/template.md"]);

  fs.writeFileSync(path.join(root, "skills/weekly/template.md"), "t2");
  fs.mkdirSync(path.join(root, "skills/brief"));
  fs.writeFileSync(path.join(root, "skills/brief/SKILL.md"), "b");
  fs.rmSync(path.join(root, "skills/old"), { recursive: true });
  assert.equal(
    rulesChangeNotice(before, snapshotRules(root)),
    "已新建 skills/brief/SKILL.md\n已移除 skills/old/SKILL.md\n已更新 skills/weekly/template.md",
  );
});

test("the system prompt applies the explicit-request rule to skills and ranks ALFRED.md above them", () => {
  const prompt = systemPrompt(new Date());
  assert.match(prompt, /skills\/<name>\/SKILL\.md holds the user's own skills/);
  assert.match(prompt, /only when the user explicitly asks in this conversation/);
  assert.match(prompt, /the request and ALFRED\.md win/);
  assert.match(DEFAULT_RULES, /^- skills\/<name>\/SKILL\.md /m);
});

// --- The owner's view and edits: GET /api/rules and rules.save ------------------

const sha256 = (data: string | Buffer): string => crypto.createHash("sha256").update(data).digest("hex");
const EMPTY_VERSION = sha256("");
const rulesPath = (root: string): string => path.join(root, "ALFRED.md");
const save = (root: string, text: string, version: string) => saveRules(root, { type: "rules.save", text, version });

test("readRulesForOwner gives the file's text as it is, the sha256 of its bytes and the prompt's cap", () => {
  const text = "  # 规则\r\n\n- 报告开头先写摘要 😀\n\n";
  const root = workspace({ "ALFRED.md": text });
  const rules = readRulesForOwner(root);
  assert.deepEqual(rules, { text, version: sha256(Buffer.from(text)), maxBytes: RULES_MAX_BYTES });
  assert.equal(RulesSchema.safeParse(rules).success, true);
});

test("readRulesForOwner reads a missing file, a symlink and anything but a regular file as empty text", () => {
  const empty = { text: "", version: EMPTY_VERSION, maxBytes: RULES_MAX_BYTES };
  assert.deepEqual(readRulesForOwner(workspace({})), empty, "missing");

  const link = workspace({ "elsewhere.md": "not the owner's rules" });
  fs.symlinkSync(path.join(link, "elsewhere.md"), rulesPath(link));
  assert.deepEqual(readRulesForOwner(link), empty, "a symlink to a file");

  const dangling = workspace({});
  fs.symlinkSync(path.join(dangling, "nowhere.md"), rulesPath(dangling));
  assert.deepEqual(readRulesForOwner(dangling), empty, "a dangling symlink");

  const dir = workspace({ "ALFRED.md/inside.md": "x" });
  assert.deepEqual(readRulesForOwner(dir), empty, "a directory");
});

test("readRulesForOwner reads a file up to 65536 bytes whole and refuses a longer one", () => {
  const exact = workspace({ "ALFRED.md": "a".repeat(RULES_READ_MAX_BYTES) });
  assert.equal(readRulesForOwner(exact)?.text.length, RULES_READ_MAX_BYTES);
  const over = workspace({ "ALFRED.md": "a".repeat(RULES_READ_MAX_BYTES + 1) });
  assert.equal(readRulesForOwner(over), undefined);
  assert.equal(RULES_READ_MAX_BYTES, 65_536);
});

test("rules.save stores the text as sent, answers the new Rules and a later read agrees", () => {
  const before = "# old\n";
  const root = workspace({ "ALFRED.md": before });
  // Line endings, a missing final newline, leading space and a character outside the BMP are all kept.
  const text = "  # 新规则\r\n- one 😀\r\n- two";
  const saved = save(root, text, sha256(before));
  assert.deepEqual(saved, { ok: true, body: { text, version: sha256(Buffer.from(text)), maxBytes: RULES_MAX_BYTES } });
  assert.equal(fs.readFileSync(rulesPath(root), "utf8"), text);
  assert.deepEqual(readRulesForOwner(root), saved.ok ? saved.body : undefined);
});

test("rules.save creates the file when there is none, against the version of the empty text", () => {
  const root = workspace({});
  assert.equal(save(root, "# first\n", "stale").ok, false);
  assert.equal(fs.existsSync(rulesPath(root)), false, "a stale save creates nothing");
  assert.equal(save(root, "# first\n", EMPTY_VERSION).ok, true);
  assert.equal(fs.readFileSync(rulesPath(root), "utf8"), "# first\n");
});

test("rules.save refuses a version that is not the file's current one with 409, and changes nothing", () => {
  const root = workspace({ "ALFRED.md": "# v1\n" });
  const v1 = sha256("# v1\n");
  assert.equal(save(root, "# v2\n", v1).ok, true);
  for (const version of [v1, "", "stale", v1.toUpperCase(), sha256("# v2\n").slice(1)]) {
    const refused = save(root, "# v3\n", version);
    assert.equal(refused.ok, false, version);
    assert.equal(!refused.ok && refused.status, 409, version);
  }
  assert.equal(fs.readFileSync(rulesPath(root), "utf8"), "# v2\n");
  assert.equal(save(root, "# v3\n", sha256("# v2\n")).ok, true, "the current version is accepted");
});

test("rules.save refuses text over 8 KB of UTF-8 bytes, or with a NUL, with 400, and changes nothing", () => {
  const root = workspace({ "ALFRED.md": "# keep\n" });
  const version = sha256("# keep\n");
  const status = (text: string) => {
    const result = save(root, text, version);
    return result.ok ? 200 : result.status;
  };
  assert.equal(status("a".repeat(RULES_MAX_BYTES + 1)), 400);
  // 2731 characters of 3 bytes each are 8193 bytes: the cap counts bytes, not characters.
  assert.equal(status("规".repeat(Math.floor(RULES_MAX_BYTES / 3) + 1)), 400);
  assert.equal(status("a\0b"), 400);
  assert.equal(status("\0"), 400);
  assert.equal(fs.readFileSync(rulesPath(root), "utf8"), "# keep\n");
  assert.equal(status("a".repeat(RULES_MAX_BYTES)), 200, "exactly 8 KB is accepted");
});

test("rules.save never replaces a symlink or anything but a regular file: 409", () => {
  const link = workspace({ "target.md": "# the target\n" });
  fs.symlinkSync(path.join(link, "target.md"), rulesPath(link));
  // The read side shows empty text and its version, so the version is right and the refusal is the symlink's.
  const refused = save(link, "# mine\n", EMPTY_VERSION);
  assert.deepEqual([refused.ok, !refused.ok && refused.status], [false, 409]);
  assert.equal(fs.lstatSync(rulesPath(link)).isSymbolicLink(), true, "still a link");
  assert.equal(fs.readFileSync(path.join(link, "target.md"), "utf8"), "# the target\n", "the target is untouched");

  const dangling = workspace({});
  fs.symlinkSync(path.join(dangling, "nowhere.md"), rulesPath(dangling));
  assert.equal(save(dangling, "# mine\n", EMPTY_VERSION).ok, false);
  assert.equal(fs.lstatSync(rulesPath(dangling)).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(dangling, "nowhere.md")), false, "nothing was created through the link");

  const dir = workspace({ "ALFRED.md/inside.md": "x" });
  const refusedDir = save(dir, "# mine\n", EMPTY_VERSION);
  assert.deepEqual([refusedDir.ok, !refusedDir.ok && refusedDir.status], [false, 409]);
  assert.equal(fs.statSync(rulesPath(dir)).isDirectory(), true);
});

test("rules.save refuses a file over the read cap with 409: no version of it was ever shown", () => {
  const text = "a".repeat(RULES_READ_MAX_BYTES + 1);
  const root = workspace({ "ALFRED.md": text });
  for (const version of [sha256(text), EMPTY_VERSION]) {
    const refused = save(root, "# mine\n", version);
    assert.deepEqual([refused.ok, !refused.ok && refused.status], [false, 409]);
  }
  assert.equal(fs.readFileSync(rulesPath(root), "utf8"), text);
});

test("a save leaves no temporary file behind", () => {
  const root = workspace({ "ALFRED.md": "# old\n", "notes/a.md": "a" });
  assert.equal(save(root, "# new\n", sha256("# old\n")).ok, true);
  assert.equal(save(root, "x", "stale").ok, false);
  assert.equal(save(root, "a\0b", sha256("# new\n")).ok, false);
  assert.deepEqual(fs.readdirSync(root).sort(), ["ALFRED.md", "notes"]);
});

test("a live run's notice stays silent for the owner's save, with or without a rules file before it", () => {
  const root = workspace({ "ALFRED.md": "# old\n", "reports/a.md": "a" });
  const watch = watchRules(root);
  assert.equal(save(root, "# the owner's\n", sha256("# old\n")).ok, true);
  assert.equal(watch.notice(), undefined);

  const bare = workspace({});
  const created = watchRules(bare);
  assert.equal(save(bare, "# the owner's\n", EMPTY_VERSION).ok, true);
  assert.equal(created.notice(), undefined, "a file the owner created is not the agent's new file");
});

test("a live run's notice still reports what the agent changes, before or after the owner's save", () => {
  const root = workspace({ "ALFRED.md": "# old\n", "notes/ALFRED.md": "n" });

  const alone = watchRules(root);
  fs.writeFileSync(rulesPath(root), "# the agent's\n");
  assert.equal(alone.notice(), "已更新 ALFRED.md");

  const after = watchRules(root);
  assert.equal(save(root, "# the owner's\n", sha256("# the agent's\n")).ok, true);
  fs.writeFileSync(rulesPath(root), "# the agent's again\n");
  assert.equal(after.notice(), "已更新 ALFRED.md", "the agent changed the file after the owner's save");

  const other = watchRules(root);
  assert.equal(save(root, "# the owner's, again\n", sha256("# the agent's again\n")).ok, true);
  fs.writeFileSync(path.join(root, "notes/ALFRED.md"), "n2");
  fs.mkdirSync(path.join(root, "skills/weekly"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills/weekly/SKILL.md"), "s");
  assert.equal(other.notice(), "已更新 notes/ALFRED.md\n已新建 skills/weekly/SKILL.md", "only the owner's own save is left out");
});

test("an owner's save that replaces the agent's change leaves nothing to report, since the file is the owner's text again", () => {
  const root = workspace({ "ALFRED.md": "# old\n" });
  const watch = watchRules(root);
  fs.writeFileSync(rulesPath(root), "# the agent's\n");
  assert.equal(save(root, "# the owner's\n", sha256("# the agent's\n")).ok, true);
  assert.equal(watch.notice(), undefined);
});

test("a save reaches every live run of its workspace, and no run of another, and none that has ended", () => {
  const root = workspace({ "ALFRED.md": "# old\n" });
  const elsewhere = workspace({ "ALFRED.md": "# old\n" });
  const first = watchRules(root);
  const second = watchRules(root);
  const foreign = watchRules(elsewhere);
  const ended = watchRules(root);
  ended.close();
  assert.equal(save(root, "# the owner's\n", sha256("# old\n")).ok, true);
  assert.equal(first.notice(), undefined);
  assert.equal(second.notice(), undefined);
  assert.equal(foreign.notice(), undefined, "the other workspace's file did not change");
  assert.equal(ended.before.get("ALFRED.md"), sha256("# old\n"), "an ended run's snapshot is no longer kept up to date");
  assert.equal(save(root, "# later\n", sha256("# the owner's\n")).ok, true);
  assert.equal(first.before.get("ALFRED.md"), sha256("# the owner's\n"), "notice() ended the run's watch");
});

test("a refused save does not touch a live run's snapshot", () => {
  const root = workspace({ "ALFRED.md": "# old\n" });
  const watch = watchRules(root);
  assert.equal(save(root, "# nope\n", "stale").ok, false);
  assert.equal(save(root, "a\0b", sha256("# old\n")).ok, false);
  assert.equal(watch.before.get("ALFRED.md"), sha256("# old\n"));
  assert.equal(watch.notice(), undefined);
});

/** A Versions that records its commits and either finds nothing to commit or fails. */
function recordingVersions(outcome: "none" | "fail") {
  const commits: [string, { paths?: string[]; force?: string[] } | undefined][] = [];
  const versions = {
    async commit(message: string, opts?: { paths?: string[]; force?: string[] }) {
      commits.push([message, opts]);
      if (outcome === "fail") throw new Error("git is gone");
      return undefined;
    },
  };
  return { commits, versions: versions as unknown as Versions };
}

test("a saved file is committed as `Edit ALFRED.md`, and only a successful save commits", async () => {
  const root = workspace({ "ALFRED.md": "# old\n" });
  const { commits, versions } = recordingVersions("none");
  const commands = rulesCommands({ workspace: root, versions });
  const stale = await commands.save({ type: "rules.save", text: "# x\n", version: "stale" });
  assert.equal(stale.ok, false);
  const tooLong = await commands.save({ type: "rules.save", text: "a".repeat(RULES_MAX_BYTES + 1), version: sha256("# old\n") });
  assert.equal(tooLong.ok, false);
  assert.deepEqual(commits, []);

  const saved = await commands.save({ type: "rules.save", text: "# new\n", version: sha256("# old\n") });
  assert.equal(saved.ok, true);
  assert.deepEqual(commits, [["Edit ALFRED.md", { paths: ["ALFRED.md"] }]]);
});

test("the commit puts the saved text into the workspace's history", async () => {
  const root = workspace({ "ALFRED.md": "# old\n" });
  const gitDir = path.join(tmp, "history.git");
  const history = new Versions({ workspace: root, gitDir });
  await history.init();
  const commands = rulesCommands({ workspace: root, versions: history });
  const saved = await commands.save({ type: "rules.save", text: "# 新\n", version: sha256("# old\n") });
  assert.equal(saved.ok, true);
  const head = await history.head();
  assert.ok(head);
  assert.equal((await history.show(head, "ALFRED.md"))?.toString("utf8"), "# 新\n");
  const subject = execFileSync("git", ["--git-dir", gitDir, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim();
  assert.equal(subject, "Edit ALFRED.md");
});

test("a failing commit is logged and the save still answers with the new Rules", async () => {
  const root = workspace({ "ALFRED.md": "# old\n" });
  const { commits, versions } = recordingVersions("fail");
  const lines = mock.method(console, "error", () => {});
  let saved;
  try {
    saved = await rulesCommands({ workspace: root, versions }).save({ type: "rules.save", text: "# new\n", version: sha256("# old\n") });
  } finally {
    lines.mock.restore();
  }
  assert.deepEqual(saved, { ok: true, body: { text: "# new\n", version: sha256("# new\n"), maxBytes: RULES_MAX_BYTES } });
  assert.equal(fs.readFileSync(rulesPath(root), "utf8"), "# new\n");
  assert.equal(commits.length, 1);
  const logged = lines.mock.calls.map((call) => String(call.arguments[0]));
  assert.ok(logged.some((line) => /WARN .*ALFRED\.md.*git is gone/.test(line)), logged.join("\n"));
});

test("without a history (documents are not wired in) a save only writes the file", async () => {
  const root = workspace({ "ALFRED.md": "# old\n" });
  const saved = await rulesCommands({ workspace: root }).save({ type: "rules.save", text: "# new\n", version: sha256("# old\n") });
  assert.equal(saved.ok, true);
  assert.equal(fs.readFileSync(rulesPath(root), "utf8"), "# new\n");
});

test("the check and the write have no await between them: two saves of one version cannot both succeed", async () => {
  const root = workspace({ "ALFRED.md": "# old\n" });
  const commands = rulesCommands({ workspace: root });
  const version = sha256("# old\n");
  const [a, b] = await Promise.all([
    commands.save({ type: "rules.save", text: "# a\n", version }),
    commands.save({ type: "rules.save", text: "# b\n", version }),
  ]);
  assert.deepEqual([a.ok, b.ok], [true, false]);
  assert.equal(fs.readFileSync(rulesPath(root), "utf8"), "# a\n");
});
