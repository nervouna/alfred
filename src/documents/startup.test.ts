import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// runs.ts and the event log read STATE_DIR at import time, so set it before loading the modules under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-startup-")));
process.env.ALFRED_STATE_DIR = path.join(tmp, "state");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { EventLog } = await import("../events.ts");
const { startDocuments } = await import("./startup.ts");
const { VERSION_MAX_BYTES } = await import("./versions.ts");
const { readDocumentFile } = await import("./store.ts");

let cases = 0;

/** A workspace, a git dir, a documents file and an event log of their own, laid out as in production. */
function fixture() {
  const dir = path.join(tmp, `case-${cases++}`);
  const workspace = path.join(dir, "workspace");
  const gitDir = path.join(dir, "workbench", "versions.git");
  const file = path.join(dir, "workbench", "documents.json");
  const events = new EventLog(path.join(dir, "events", "events.jsonl"));
  fs.mkdirSync(workspace, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", [`--git-dir=${gitDir}`, `--work-tree=${workspace}`, ...args], { encoding: "utf8" }).trim();
  const start = () => startDocuments({ workspace, gitDir, file, events });
  const put = (rel: string, content: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(workspace, rel)), { recursive: true });
    fs.writeFileSync(path.join(workspace, rel), content);
  };
  /** An outbound or inbound message event, as the handler records it. */
  const say = (message: { channel?: "app" | "wechat"; direction?: "in" | "out"; files?: string[]; text?: string; at: string; runId?: string; taskId?: string }) =>
    events.append("message.created", {
      id: crypto.randomUUID(),
      channel: message.channel ?? "app",
      direction: message.direction ?? "out",
      text: message.text ?? "",
      files: (message.files ?? []).map((p) => ({ path: p })),
      at: message.at,
      ...(message.runId ? { runId: message.runId } : {}),
      ...(message.taskId ? { taskId: message.taskId } : {}),
    });
  const documentEvents = () => events.readSince(0).filter((e) => e.type === "document.updated").length;
  const subjects = () => git("log", "--format=%s").split("\n");
  return { dir, workspace, gitDir, file, events, git, start, put, say, documentEvents, subjects };
}

test("the first start creates the repository, imports the files earlier app messages delivered in one commit, and registers them in event-log order", async () => {
  const f = fixture();
  f.put("reports/vps.md", "# VPS 对比\n\n正文\n");
  f.put("reports/chart.html", "<!doctype html><title>价格图表</title><svg></svg>");
  f.put("reports/vps.pdf", "%PDF-1.4\n% pdf\n");
  f.put("images/cover.jpg", "jpeg bytes");
  f.put("notes/never-sent.md", "# 没发过\n");
  f.put("reports/wechat-only.md", "# 只发给微信\n");
  const big = path.join(f.workspace, "reports", "big.pdf");
  fs.writeFileSync(big, "");
  fs.truncateSync(big, VERSION_MAX_BYTES + 1);
  f.put("notes/.git/config", "[core]\n");

  f.say({ files: ["reports/vps.md"], at: "2026-10-20T01:00:00.000Z", runId: "k7m2qa" });
  f.say({ direction: "in", files: ["notes/never-sent.md"], at: "2026-10-20T01:05:00.000Z" });
  f.say({ files: ["reports/gone.md"], at: "2026-10-21T01:00:00.000Z", runId: "s2d8kp" });
  f.say({ channel: "wechat", files: ["reports/wechat-only.md"], at: "2026-10-21T02:00:00.000Z", runId: "s2d8kp" });
  f.say({ files: ["reports/vps.pdf", "images/cover.jpg"], at: "2026-10-22T01:00:00.000Z", runId: "t4w9xr" });
  f.say({ files: ["reports/chart.html"], at: "2026-10-23T01:00:00.000Z", runId: "k7m2qa", taskId: "a7k2mq" });
  f.say({ files: ["reports/big.pdf", "notes/.git/config", "notes"], at: "2026-10-23T02:00:00.000Z", runId: "k7m2qa" });
  f.say({ files: ["reports/vps.md"], at: "2026-10-24T01:00:00.000Z", runId: "m4n5pq" });
  f.say({ text: "没有文件", at: "2026-10-24T02:00:00.000Z" });

  const documents = await f.start();
  assert.ok(documents, "Alfred starts with documents");
  assert.equal(f.git("log", "-1", "--format=%s"), "Import files delivered before documents");
  const head = f.git("rev-parse", "HEAD");
  assert.deepEqual(f.git("show", "--name-only", "--format=", "HEAD").split("\n").sort(), ["images/cover.jpg", "reports/vps.pdf"], "the files the rules leave out are forced in");
  assert.deepEqual(f.subjects().slice(1), ["Initial version of the workspace"], "the text files came with the first commit");

  const { documents: stored } = readDocumentFile(f.file);
  const byPath = new Map(stored.map((entry) => [entry.document.path, entry]));
  assert.deepEqual([...byPath.keys()].sort(), ["images/cover.jpg", "reports/chart.html", "reports/vps.md", "reports/vps.pdf"]);
  assert.ok(![...byPath.keys()].some((p) => /gone|wechat|never-sent|big|\.git|^notes$/.test(p)), "missing, WeChat, inbound, large, .git and directory paths are left out");
  for (const entry of stored) assert.equal(entry.document.version, head, entry.document.path);

  const vps = byPath.get("reports/vps.md");
  assert.deepEqual([vps?.document.title, vps?.document.kind, vps?.document.createdAt], ["VPS 对比", "markdown", "2026-10-20T01:00:00.000Z"], "named twice, one document, as of the first delivery");
  assert.deepEqual(vps?.versions.map((v) => [v.version, v.reason, v.runId, v.at]), [[head, "delivered", "k7m2qa", "2026-10-20T01:00:00.000Z"]]);
  assert.equal(byPath.get("reports/chart.html")?.document.title, "价格图表");
  assert.equal(byPath.get("reports/chart.html")?.document.taskId, "a7k2mq", "the task whose run delivered it");
  assert.deepEqual([byPath.get("reports/vps.pdf")?.document.kind, byPath.get("reports/vps.pdf")?.document.title], ["pdf", "vps.pdf"]);
  assert.equal(byPath.get("images/cover.jpg")?.versions[0]?.runId, "t4w9xr");
  assert.equal(new Set(stored.map((entry) => entry.document.id)).size, 4);
});

test("a second start imports nothing: no commit and no document event", async () => {
  const f = fixture();
  f.put("reports/once.md", "# 一次\n");
  f.put("images/once.jpg", "jpeg bytes");
  f.say({ files: ["reports/once.md", "images/once.jpg"], at: "2026-10-20T01:00:00.000Z", runId: "k7m2qa" });
  assert.ok(await f.start());
  const commits = f.git("rev-list", "--count", "HEAD");
  const events = f.documentEvents();
  const before = fs.readFileSync(f.file, "utf8");
  assert.equal(events, 2);

  // A file delivered earlier that appeared since is not picked up: the import runs only when there is no documents file.
  f.put("reports/late.md", "# 晚到\n");
  f.say({ files: ["reports/late.md"], at: "2026-10-21T01:00:00.000Z", runId: "s2d8kp" });
  assert.ok(await f.start());
  assert.equal(f.git("rev-list", "--count", "HEAD"), String(Number(commits) + 1), "only the startup commit of the file that appeared");
  assert.equal(f.git("log", "-1", "--format=%s"), "Changes found at startup");
  assert.equal(f.documentEvents(), events);
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
});

test("with only text files the first commit holds them, and the import adds no commit: the documents are at the current commit", async () => {
  const f = fixture();
  f.put("notes/plain.md", "# 笔记\n");
  f.say({ files: ["notes/plain.md"], at: "2026-10-20T01:00:00.000Z", runId: "k7m2qa" });
  assert.ok(await f.start());
  assert.deepEqual(f.subjects(), ["Initial version of the workspace"]);
  const [entry] = readDocumentFile(f.file).documents;
  assert.equal(entry?.document.version, f.git("rev-parse", "HEAD"));
});

test("a file changed while Alfred was stopped gets a startup commit, and the document among the changed files a changed version", async () => {
  const f = fixture();
  f.put("reports/stopped.md", "# 停机前\n");
  f.say({ files: ["reports/stopped.md"], at: "2026-10-20T01:00:00.000Z", runId: "k7m2qa" });
  assert.ok(await f.start());
  const [before] = readDocumentFile(f.file).documents;
  assert.ok(before);

  f.put("reports/stopped.md", "# 停机时改过\n");
  f.put("notes/while-stopped.md", "# 停机时新写的\n");
  assert.ok(await f.start());

  assert.equal(f.git("log", "-1", "--format=%s"), "Changes found at startup");
  assert.deepEqual(f.git("show", "--name-only", "--format=", "HEAD").split("\n").sort(), ["notes/while-stopped.md", "reports/stopped.md"]);
  const [after] = readDocumentFile(f.file).documents;
  assert.deepEqual(
    after?.versions.map((v) => [v.reason, v.runId, v.version === f.git("rev-parse", "HEAD")]),
    [["changed", undefined, true], ["delivered", "k7m2qa", false]],
  );
  assert.equal(after?.document.version, f.git("rev-parse", "HEAD"));
  assert.equal(after?.document.id, before.document.id);

  const commits = f.git("rev-list", "--count", "HEAD");
  assert.ok(await f.start());
  assert.equal(f.git("rev-list", "--count", "HEAD"), commits, "nothing changed, so no commit");
});

test("the startup commit is not made when nothing changed", async () => {
  const f = fixture();
  f.put("notes/steady.md", "# 稳定\n");
  assert.ok(await f.start());
  const head = f.git("rev-parse", "HEAD");
  assert.ok(await f.start());
  assert.equal(f.git("rev-parse", "HEAD"), head);
});

test("a failure is logged and leaves Alfred running without documents: nothing is thrown", async () => {
  const f = fixture();
  // The git dir cannot be made: a file is where its parent directory should be.
  fs.mkdirSync(path.dirname(f.gitDir), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(f.gitDir), "versions.git"), "a file");
  assert.equal(await f.start(), undefined);

  const g = fixture();
  g.put("notes/a.md", "# a\n");
  fs.mkdirSync(path.dirname(g.file), { recursive: true });
  fs.writeFileSync(g.file, "{ not json");
  g.say({ files: ["notes/a.md"], at: "2026-10-20T01:00:00.000Z" });
  assert.equal(await g.start(), undefined, "a documents file that cannot be read");
  assert.equal(fs.readFileSync(g.file, "utf8"), "{ not json", "and it is left as it is");
});
