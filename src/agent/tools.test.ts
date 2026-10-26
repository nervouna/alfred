// Alfred's own tools on fakes: each one stops when the signal of its call aborts, as well as when the
// run's does. No model is called. generate_image runs a stand-in for mmx that hangs, and render_pdf
// may use Chrome Headless Shell when it is installed; without it that test still holds.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { Outbound } from "../channels.ts";
import type { Versions as VersionsType } from "../documents/versions.ts";

// store.ts, config.ts and image.ts read these at import time, so set them before loading the modules under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-tools-")));
const workspace = path.join(tmp, "workspace");
const mmx = path.join(tmp, "mmx");
const pidFile = path.join(tmp, "mmx.pid");
fs.mkdirSync(workspace);
// Stands in for mmx: starts a grandchild, records its pid and waits, as a hung call would.
fs.writeFileSync(mmx, `#!/bin/sh\nsleep 30 >/dev/null 2>&1 &\necho $! > "${pidFile}"\nwait\n`, { mode: 0o755 });
Object.assign(process.env, {
  ALFRED_WORKSPACE: workspace,
  ALFRED_STATE_DIR: path.join(tmp, "state"),
  ALFRED_ANTHROPIC_API_KEY: "sk-test",
  ALFRED_MMX_BIN: mmx,
  ALFRED_WORKBENCH: "",
  ALFRED_WORKBENCH_URL: "",
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { alfredToolDefinitions } = await import("./tools.ts");
const { recorded } = await import("../channels.ts");
const { DocumentStore } = await import("../documents/store.ts");
const { VERSION_MAX_BYTES, Versions } = await import("../documents/versions.ts");
const { EventLog } = await import("../events.ts");
const { RunRecorder } = await import("../runs.ts");

interface Result {
  content: { type: string; text: string }[];
  isError?: boolean;
}
type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<Result>;

/** One of Alfred's tools, bound to `out` and the run's signal, as the run gets it. */
function tool(name: string, out: Outbound, run?: AbortSignal): Handler {
  const def = alfredToolDefinitions(out, run).find((d) => d.name === name);
  assert.ok(def, name);
  return def.handler as unknown as Handler;
}

/** The `extra` argument the SDK passes a tool call: its own signal, aborted when the turn is interrupted. */
const callWith = (signal: AbortSignal) => ({ signal });
const textOf = (result: Result) => result.content.map((c) => c.text).join("\n");

function fakeOutbound() {
  const sent: string[] = [];
  const out: Outbound = {
    channel: "app",
    async text() {},
    async file(absPath) {
      sent.push(absPath);
      return "file";
    },
  };
  return { out, sent };
}

let stacks = 0;

/**
 * Alfred's tools on a real git dir and document store of their own, delivering through `recorded`, so what the
 * owner is sent shows as message events. `versions` replaces the real Versions, for a repository that fails.
 */
async function documentStack(options: { versions?: VersionsType } = {}) {
  const dir = path.join(tmp, `stack-${stacks++}`);
  const gitDir = path.join(dir, "versions.git");
  const events = new EventLog(path.join(dir, "events.jsonl"));
  const real = new Versions({ workspace, gitDir });
  await real.init();
  const versions = options.versions ?? real;
  const store = new DocumentStore({ file: path.join(dir, "documents.json"), events });
  const run = new RunRecorder({ kind: "task", title: "整理笔记", events });
  const { out, sent } = fakeOutbound();
  const definitions = alfredToolDefinitions(recorded(out, events, { workspace, runId: run.id }), undefined, run, { versions, store });
  const call = (name: string, args: Record<string, unknown>) => {
    const def = definitions.find((d) => d.name === name);
    assert.ok(def, name);
    return (def.handler as unknown as Handler)(args, callWith(new AbortController().signal));
  };
  const messages = () => events.readSince(0).flatMap((e) => (e.type === "message.created" ? [e.data] : []));
  const git = (...args: string[]) => execFileSync("git", [`--git-dir=${gitDir}`, `--work-tree=${workspace}`, ...args], { encoding: "utf8" }).trim();
  return { run, store, versions: real, sent, call, messages, git, deliver: (p: string) => call("deliver", { path: p }) };
}

function write(rel: string, text: string | Buffer): void {
  fs.mkdirSync(path.dirname(path.join(workspace, rel)), { recursive: true });
  fs.writeFileSync(path.join(workspace, rel), text);
}

const exists = (rel: string): boolean => fs.existsSync(path.join(workspace, rel));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("deliver sends a file for a call that is not stopped, and refuses one whose own signal is aborted", async () => {
  write("notes/send-me.md", "# 笔记\n");
  const { out, sent } = fakeOutbound();
  const send = tool("deliver", out);

  const stopped = new AbortController();
  stopped.abort();
  const refused = await send({ path: "notes/send-me.md" }, callWith(stopped.signal));
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /stopped/);
  assert.deepEqual(sent, [], "nothing is sent once the call is stopped");

  const delivered = await send({ path: "notes/send-me.md" }, callWith(new AbortController().signal));
  assert.notEqual(delivered.isError, true, textOf(delivered));
  assert.equal(sent.length, 1);
});

test("deliver sends an HTML report as it is", async () => {
  write("reports/chart.html", "<!doctype html><title>t</title><svg></svg>");
  write("reports/old.htm", "<p>x</p>");
  const { out, sent } = fakeOutbound();
  const send = tool("deliver", out);

  for (const file of ["reports/chart.html", "reports/old.htm"]) {
    const result = await send({ path: file }, callWith(new AbortController().signal));
    assert.notEqual(result.isError, true, textOf(result));
  }
  assert.deepEqual(sent.map((p) => path.relative(workspace, p)), ["reports/chart.html", "reports/old.htm"]);
});

test("deliver says what the app opens, HTML reports included", () => {
  const def = alfredToolDefinitions(fakeOutbound().out).find((d) => d.name === "deliver");
  assert.ok(def);
  assert.match(def.description, /in the app/);
  assert.match(def.description, /Markdown, PDF, images, video, text files and HTML reports/);
  assert.match(def.description, /inline scripts and SVG charts work, with no network access/);
  assert.doesNotMatch(def.description, /cannot open/i);
});

test("deliver reports a send the channel refused, and the file stays", async () => {
  write("notes/refused.md", "# x\n");
  const out: Outbound = {
    channel: "app",
    async text() {},
    async file() {
      throw new Error("disk full");
    },
  };
  const result = await tool("deliver", out)({ path: "notes/refused.md" }, callWith(new AbortController().signal));
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Sending failed: disk full\. The file stays in the workspace\./);
  assert.equal(exists("notes/refused.md"), true);
});

test("deliver also refuses when only the run's signal is aborted", async () => {
  write("notes/run-stopped.md", "# 笔记\n");
  const { out, sent } = fakeOutbound();
  const run = new AbortController();
  const send = tool("deliver", out, run.signal);
  run.abort();
  const refused = await send({ path: "notes/run-stopped.md" }, {});
  assert.equal(refused.isError, true);
  assert.deepEqual(sent, []);
});

test("deliver says that a delivered file becomes a document, and that a delivered document is revised in place", () => {
  const def = alfredToolDefinitions(fakeOutbound().out).find((d) => d.name === "deliver");
  assert.ok(def);
  assert.match(def.description, /becomes a document the owner can annotate in the app/);
  assert.match(def.description, /[Rr]evise a delivered document in place, under the same path, since every version is kept/);
  assert.deepEqual(
    alfredToolDefinitions(fakeOutbound().out).map((d) => d.name),
    ["deliver", "move_file", "render_pdf", "generate_image"],
  );
});

test("deliver commits a new Markdown file and registers a document with its heading as the title, and the message names the document and version", async () => {
  const s = await documentStack();
  write("notes/deliver-new.md", "# 墨尔本行程\n\n第一天：市场\n");
  const result = await s.deliver("notes/deliver-new.md");
  assert.notEqual(result.isError, true, textOf(result));
  assert.match(textOf(result), /Delivered deliver-new\.md/);

  const head = s.git("rev-parse", "HEAD");
  assert.equal(s.git("log", "-1", "--format=%s"), `Deliver notes/deliver-new.md (run ${s.run.id})`);
  assert.equal(s.git("show", "--name-only", "--format=", "HEAD"), "notes/deliver-new.md");
  const [document, ...others] = s.store.list();
  assert.equal(others.length, 0, "one document");
  assert.ok(document);
  assert.deepEqual([document.path, document.title, document.kind, document.version], ["notes/deliver-new.md", "墨尔本行程", "markdown", head]);
  assert.deepEqual(
    s.store.versions(document.id)?.map((v) => [v.version, v.reason, v.runId]),
    [[head, "delivered", s.run.id]],
  );
  const [message, ...more] = s.messages();
  assert.equal(more.length, 0);
  assert.deepEqual(message?.files, [{ path: "notes/deliver-new.md", kind: "file", documentId: document.id, version: head }]);
  assert.equal(message?.runId, s.run.id);
});

test("a changed file delivered again is a second delivered version; delivered unchanged it adds none, and the message names the same version", async () => {
  const s = await documentStack();
  write("notes/deliver-twice.md", "# 周报\n\n第一版\n");
  await s.deliver("notes/deliver-twice.md");
  write("notes/deliver-twice.md", "# 周报\n\n第二版\n");
  await s.deliver("notes/deliver-twice.md");
  const second = s.git("rev-parse", "HEAD");
  const commits = s.git("rev-list", "--count", "HEAD");

  const unchanged = await s.deliver("notes/deliver-twice.md");
  assert.notEqual(unchanged.isError, true, textOf(unchanged));
  assert.equal(s.git("rev-list", "--count", "HEAD"), commits, "nothing to commit");

  const [document] = s.store.list();
  assert.ok(document);
  const versions = s.store.versions(document.id) ?? [];
  assert.deepEqual(versions.map((v) => v.reason), ["delivered", "delivered"]);
  assert.equal(versions[0]?.version, second);
  assert.notEqual(versions[1]?.version, second);
  assert.deepEqual(
    s.messages().map((m) => m.files[0]?.version),
    [versions[1]?.version, second, second],
  );
  assert.equal(new Set(s.messages().map((m) => m.files[0]?.documentId)).size, 1, "one document");
});

test("a file delivered unchanged after other commits is still at the version of its document", async () => {
  const s = await documentStack();
  write("notes/deliver-quiet.md", "# 安静的笔记\n");
  await s.deliver("notes/deliver-quiet.md");
  const [document] = s.store.list();
  assert.ok(document);
  write("notes/deliver-other.md", "# 别的笔记\n");
  assert.ok(await s.versions.commit("Other work", { paths: ["notes/deliver-other.md"] }));

  await s.deliver("notes/deliver-quiet.md");
  assert.equal(s.store.versions(document.id)?.length, 1, "the file did not change, so neither did its versions");
  assert.equal(s.messages().at(-1)?.files[0]?.version, document.version);
});

test("a PDF is committed whatever its type when it is delivered, and a file over 20 MB is delivered with no document", async () => {
  const s = await documentStack();
  write("reports/deliver-report.pdf", "%PDF-1.4\n% not really a PDF\n");
  const pdf = await s.deliver("reports/deliver-report.pdf");
  assert.notEqual(pdf.isError, true, textOf(pdf));
  assert.equal(s.git("show", "--name-only", "--format=", "HEAD"), "reports/deliver-report.pdf");
  const [document] = s.store.list();
  assert.deepEqual([document?.kind, document?.title, document?.version], ["pdf", "deliver-report.pdf", s.git("rev-parse", "HEAD")]);

  const before = s.git("rev-parse", "HEAD");
  const big = path.join(workspace, "reports", "deliver-big.pdf");
  fs.writeFileSync(big, "");
  fs.truncateSync(big, VERSION_MAX_BYTES + 1);
  const sent = await s.deliver("reports/deliver-big.pdf");
  assert.notEqual(sent.isError, true, textOf(sent));
  assert.equal(s.git("rev-parse", "HEAD"), before, "no commit");
  assert.equal(s.store.list().length, 1, "no document");
  const file = s.messages().at(-1)?.files[0];
  assert.deepEqual(file, { path: "reports/deliver-big.pdf", kind: "file" });
  assert.ok(s.sent.some((p) => p.endsWith("deliver-big.pdf")), "the file went out");
});

test("a repository that fails still sends the file, with no document, and the tool says it was delivered", async () => {
  const broken = {
    commit: async () => {
      throw new Error("index.lock exists");
    },
    head: async () => undefined,
    differs: async () => [],
  } as unknown as VersionsType;
  const s = await documentStack({ versions: broken });
  write("notes/deliver-broken.md", "# 仍然送达\n");
  const result = await s.deliver("notes/deliver-broken.md");
  assert.notEqual(result.isError, true, textOf(result));
  assert.match(textOf(result), /Delivered deliver-broken\.md/);
  assert.equal(s.sent.length, 1);
  assert.equal(s.store.list().length, 0);
  assert.deepEqual(s.messages().map((m) => m.files), [[{ path: "notes/deliver-broken.md", kind: "file" }]]);
});

test("a store that fails also leaves the file sent with no document", async () => {
  const s = await documentStack();
  write("notes/deliver-nostore.md", "# 登记失败\n");
  const failing = alfredToolDefinitions(fakeOutbound().out, undefined, s.run, {
    versions: s.versions,
    store: { deliver: () => { throw new Error("disk full"); }, byPath: () => undefined } as unknown as InstanceType<typeof DocumentStore>,
  }).find((d) => d.name === "deliver");
  assert.ok(failing);
  const result = await (failing.handler as unknown as Handler)({ path: "notes/deliver-nostore.md" }, callWith(new AbortController().signal));
  assert.notEqual(result.isError, true, textOf(result));
  assert.match(textOf(result), /Delivered deliver-nostore\.md/);
});

test("move_file of a delivered file moves its document along", async () => {
  const s = await documentStack();
  write("notes/deliver-moving.md", "# 要搬家\n");
  await s.deliver("notes/deliver-moving.md");
  const [before] = s.store.list();
  assert.ok(before);

  const moved = await s.call("move_file", { from: "notes/deliver-moving.md", to: "reports/deliver-moved.md" });
  assert.notEqual(moved.isError, true, textOf(moved));
  assert.equal(exists("reports/deliver-moved.md"), true);
  const [after] = s.store.list();
  assert.deepEqual([after?.id, after?.path, after?.kind], [before.id, "reports/deliver-moved.md", "markdown"]);
  assert.equal(s.store.byPath("notes/deliver-moving.md"), undefined);
  assert.deepEqual(s.run.movedFrom, ["notes/deliver-moving.md"]);
});

test("move_file moves a directory's documents along with it", async () => {
  const s = await documentStack();
  write("notes/deliver-dir/a.md", "# A\n");
  await s.deliver("notes/deliver-dir/a.md");
  await s.call("move_file", { from: "notes/deliver-dir", to: "reports/deliver-dir" });
  assert.equal(s.store.list()[0]?.path, "reports/deliver-dir/a.md");
});

test("move_file moves a file when the repository or store fails, and the tool says it moved", async () => {
  const s = await documentStack();
  const failing = alfredToolDefinitions(fakeOutbound().out, undefined, s.run, {
    versions: s.versions,
    store: { move: () => { throw new Error("disk full"); } } as unknown as InstanceType<typeof DocumentStore>,
  }).find((d) => d.name === "move_file");
  assert.ok(failing);
  write("notes/deliver-unmovable.md", "x");
  const result = await (failing.handler as unknown as Handler)({ from: "notes/deliver-unmovable.md", to: "notes/deliver-unmovable-2.md" }, callWith(new AbortController().signal));
  assert.notEqual(result.isError, true, textOf(result));
  assert.equal(exists("notes/deliver-unmovable-2.md"), true);
});

test("move_file of a file that is not a document leaves the documents alone", async () => {
  const s = await documentStack();
  write("notes/deliver-plain.md", "x");
  const moved = await s.call("move_file", { from: "notes/deliver-plain.md", to: "notes/deliver-plain-2.md" });
  assert.notEqual(moved.isError, true, textOf(moved));
  assert.equal(s.store.list().length, 0);
});

test("move_file moves a file only for a call that is not stopped", async () => {
  write("notes/move-me.md", "x");
  const move = tool("move_file", fakeOutbound().out);
  const args = { from: "notes/move-me.md", to: "reports/move-me.md" };

  const stopped = new AbortController();
  stopped.abort();
  const refused = await move(args, callWith(stopped.signal));
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /stopped/);
  assert.equal(exists("notes/move-me.md"), true, "the file stays where it was");
  assert.equal(exists("reports/move-me.md"), false);

  const done = await move(args, callWith(new AbortController().signal));
  assert.notEqual(done.isError, true, textOf(done));
  assert.equal(exists("reports/move-me.md"), true);
});

test("render_pdf does not start the renderer for a call that is already stopped", async (t) => {
  write("reports/stopped-report.md", "# 停止\n\n正文\n");
  const render = tool("render_pdf", fakeOutbound().out);
  const stopped = new AbortController();
  stopped.abort();
  const refused = await render({ source: "reports/stopped-report.md" }, callWith(stopped.signal));
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /stopped/);
  assert.equal(exists("reports/stopped-report.pdf"), false);

  const done = await render({ source: "reports/stopped-report.md" }, callWith(new AbortController().signal));
  if (done.isError && /not set up/.test(textOf(done))) return t.skip("Chrome Headless Shell is not installed (npm run setup:pdf)");
  assert.notEqual(done.isError, true, textOf(done));
  assert.equal(exists("reports/stopped-report.pdf"), true);
});

test("render_pdf stops a render under way when its call's signal aborts, before or while the browser starts", async () => {
  write("reports/midway.md", "# 中途\n\n正文\n");
  const render = tool("render_pdf", fakeOutbound().out);
  const stop = new AbortController();
  const pending = render({ source: "reports/midway.md" }, callWith(stop.signal));
  stop.abort();
  const result = await pending;
  assert.equal(result.isError, true);
  assert.match(textOf(result), /stopped/);
  assert.equal(exists("reports/midway.pdf"), false);
});

test("generate_image does not start mmx for a call that is already stopped", async () => {
  fs.rmSync(pidFile, { force: true });
  const generate = tool("generate_image", fakeOutbound().out);
  const stopped = new AbortController();
  stopped.abort();
  const refused = await generate({ prompt: "a red fox", aspect_ratio: "1:1" }, callWith(stopped.signal));
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /stopped/);
  assert.equal(fs.existsSync(pidFile), false, "mmx was never started");
});

test("generate_image kills a running mmx when its call's signal aborts, and reports the stop", async () => {
  fs.rmSync(pidFile, { force: true });
  const generate = tool("generate_image", fakeOutbound().out);
  const stop = new AbortController();
  const pending = generate({ prompt: "a red fox", aspect_ratio: "1:1" }, callWith(stop.signal));
  await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf-8").trim() !== "");
  const grandchild = Number(fs.readFileSync(pidFile, "utf-8"));
  assert.ok(alive(grandchild), "mmx is running");

  stop.abort();
  const result = await pending;
  assert.equal(result.isError, true);
  assert.match(textOf(result), /stopped/);
  await until(() => !alive(grandchild));
});
