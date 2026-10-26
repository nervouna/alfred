import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { Outbound } from "./channels.ts";

// events.ts reads the state dir at import time, so set it before loading the modules under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-channels-")));
process.env.ALFRED_STATE_DIR = path.join(tmp, "state");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { EventLog } = await import("./events.ts");
const { SerialQueue, appOutbound, outboundKind, recordInbound, recorded } = await import("./channels.ts");

const workspace = path.join(tmp, "workspace");
fs.mkdirSync(path.join(workspace, "reports"), { recursive: true });
fs.writeFileSync(path.join(workspace, "reports", "vps.md"), "# VPS");

let logs = 0;
const newLog = () => new EventLog(path.join(tmp, `events-${logs++}`, "events.jsonl"));

/** An Outbound that records what it was asked to send and refuses everything when `fail` is set. */
function fakeOut(fail = false) {
  const sent: string[] = [];
  const out: Outbound = {
    channel: "app",
    async text(text) {
      if (fail) throw new Error("the channel refused the message");
      sent.push(text);
    },
    async file(absPath, caption) {
      if (fail) throw new Error("upload failed");
      if (caption) sent.push(caption);
      sent.push(`file ${absPath}`);
      return "file";
    },
  };
  return { out, sent };
}

function messages(events: InstanceType<typeof EventLog>) {
  return events.readSince(0).flatMap((e) => (e.type === "message.created" ? [e.data] : []));
}

test("the app channel sends nothing: text and files resolve, and a file is an image, a video or a file by its extension", async () => {
  const out = appOutbound();
  assert.equal(out.channel, "app");
  await out.text("hello");
  assert.equal(await out.file(path.join(workspace, "reports", "vps.md"), "caption"), "file");
  assert.equal(await out.file("/x/cover.jpg"), "image");
});

test("outboundKind routes by extension", () => {
  assert.equal(outboundKind("a.JPG"), "image");
  assert.equal(outboundKind("images/2026-10-10/cover_001.jpg"), "image");
  assert.equal(outboundKind("chart.png"), "image");
  assert.equal(outboundKind("clip.mp4"), "video");
  assert.equal(outboundKind("report.pdf"), "file");
  assert.equal(outboundKind("report.html"), "file");
});

test("recorded text appends an outbound message event after the send, with the run id", async () => {
  const events = newLog();
  const { out, sent } = fakeOut();
  await recorded(out, events, { workspace, runId: "k7m2qa" }).text("报告写好了。");

  assert.deepEqual(sent, ["报告写好了。"]);
  const [message, ...rest] = messages(events);
  assert.equal(rest.length, 0);
  assert.equal(message?.channel, "app");
  assert.equal(message?.direction, "out");
  assert.equal(message?.text, "报告写好了。");
  assert.deepEqual(message?.files, []);
  assert.equal(message?.runId, "k7m2qa");
  assert.equal(message?.error, undefined);
  assert.match(message?.id ?? "", /^[0-9a-f-]{36}$/);
});

test("recorded messages carry the task id when the output is a task run's", async () => {
  const events = newLog();
  const { out } = fakeOut();
  const task = recorded(out, events, { workspace, runId: "k7m2qa", taskId: "p3x9za" });
  await task.text("报告写好了。");
  await task.file(path.join(workspace, "reports", "vps.md"), "见附件");
  await recorded(out, events, { workspace, taskId: "p3x9za" }).text("今天的花费已到上限。");
  await recorded(out, events, { workspace, runId: "k7m2qa" }).text("没有任务。");

  const view = messages(events).map((m) => [m.text || m.files[0]?.path, m.runId, m.taskId]);
  assert.deepEqual(view, [
    ["报告写好了。", "k7m2qa", "p3x9za"],
    ["见附件", "k7m2qa", "p3x9za"],
    ["reports/vps.md", "k7m2qa", "p3x9za"],
    ["今天的花费已到上限。", undefined, "p3x9za"],
    ["没有任务。", "k7m2qa", undefined],
  ]);
});

test("a send the channel refuses is recorded with the error and still rejects", async () => {
  const events = newLog();
  const { out } = fakeOut(true);
  await assert.rejects(recorded(out, events, { workspace, runId: "k7m2qa" }).text("报告写好了。"), /channel refused/);

  const [message] = messages(events);
  assert.equal(message?.text, "报告写好了。");
  assert.equal(message?.error, "the channel refused the message");
  assert.equal(message?.runId, "k7m2qa");
});

test("a file is recorded with its workspace path and kind, after its caption as a message of its own", async () => {
  const events = newLog();
  const { out, sent } = fakeOut();
  const kind = await recorded(out, events, { workspace, runId: "k7m2qa" }).file(path.join(workspace, "reports", "vps.md"), "见附件");

  assert.equal(kind, "file");
  assert.equal(sent.length, 2, "the caption and the file");
  const [caption, file, ...rest] = messages(events);
  assert.equal(rest.length, 0);
  assert.deepEqual([caption?.text, caption?.files], ["见附件", []]);
  assert.deepEqual([file?.text, file?.files], ["", [{ path: "reports/vps.md", kind: "file" }]]);
  assert.deepEqual([caption?.channel, file?.channel, file?.direction, file?.runId], ["app", "app", "out", "k7m2qa"]);
});

test("a file the channel refuses is recorded with the error and still rejects", async () => {
  const events = newLog();
  const { out } = fakeOut(true);
  await assert.rejects(recorded(out, events, { workspace }).file(path.join(workspace, "reports", "vps.md")), /upload failed/);

  const [message] = messages(events);
  assert.deepEqual(message?.files, [{ path: "reports/vps.md", kind: "file" }]);
  assert.equal(message?.error, "upload failed");
  assert.equal(message?.runId, undefined);
});

test("recordInbound records the files, the client id and the run, and skips a message with nothing to show", () => {
  const events = newLog();
  recordInbound(events, "app", { text: "帮我查一下 VPS 价格", files: [], clientId: "c-7f3a9e" }, "k7m2qa");
  recordInbound(events, "app", { text: "", files: [{ path: "inbox/2026-10-25/image-083110.jpg", kind: "image" }] });
  recordInbound(events, "app", { text: "  \n", files: [] });

  const [first, second, ...rest] = messages(events);
  assert.equal(rest.length, 0);
  assert.deepEqual([first?.channel, first?.direction, first?.text, first?.clientId, first?.runId], ["app", "in", "帮我查一下 VPS 价格", "c-7f3a9e", "k7m2qa"]);
  assert.deepEqual([second?.channel, second?.direction, second?.text, second?.clientId, second?.runId], ["app", "in", "", undefined, undefined]);
  assert.deepEqual(second?.files, [{ path: "inbox/2026-10-25/image-083110.jpg", kind: "image" }]);
});

test("the serial queue runs tasks one at a time in order, and a failing task does not stop it", async () => {
  const queue = new SerialQueue();
  const order: string[] = [];
  const slow = queue.run(async () => {
    await new Promise((r) => setTimeout(r, 30));
    order.push("slow");
  });
  const failing = queue.run(async () => {
    order.push("failing");
    throw new Error("boom");
  });
  const last = queue.run(async () => void order.push("last"));
  await Promise.all([slow, failing, last]);
  assert.deepEqual(order, ["slow", "failing", "last"]);
});
