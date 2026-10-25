// Alfred's own tools on fakes: each one stops when the signal of its call aborts, as well as when the
// run's does. No model is called. generate_image runs a stand-in for mmx that hangs, and render_pdf
// may use Chrome Headless Shell when it is installed; without it that test still holds.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { Outbound } from "../channels.ts";

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
    async typing() {
      return async () => {};
    },
  };
  return { out, sent };
}

function write(rel: string, text: string): void {
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

test("send_file sends a file for a call that is not stopped, and refuses one whose own signal is aborted", async () => {
  write("notes/send-me.md", "# 笔记\n");
  const { out, sent } = fakeOutbound();
  const send = tool("send_file", out);

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

test("send_file also refuses when only the run's signal is aborted", async () => {
  write("notes/run-stopped.md", "# 笔记\n");
  const { out, sent } = fakeOutbound();
  const run = new AbortController();
  const send = tool("send_file", out, run.signal);
  run.abort();
  const refused = await send({ path: "notes/run-stopped.md" }, {});
  assert.equal(refused.isError, true);
  assert.deepEqual(sent, []);
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
