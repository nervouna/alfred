import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { Channel } from "./api/schema.ts";
import type { Outbound } from "./channels.ts";

// events.ts reads the state dir at import time, so set it before loading the modules under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-channels-")));
process.env.ALFRED_STATE_DIR = path.join(tmp, "state");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { EventLog } = await import("./events.ts");
const { SerialQueue, appOutbound, recordInbound, recorded } = await import("./channels.ts");

const workspace = path.join(tmp, "workspace");
fs.mkdirSync(path.join(workspace, "reports"), { recursive: true });
fs.writeFileSync(path.join(workspace, "reports", "vps.md"), "# VPS");

let logs = 0;
const newLog = () => new EventLog(path.join(tmp, `events-${logs++}`, "events.jsonl"));

/** An Outbound that records what it was asked to send and refuses everything when `fail` is set. */
function fakeOut(channel: Channel, fail = false) {
  const sent: string[] = [];
  const out: Outbound = {
    channel,
    async text(text) {
      if (fail) throw new Error("sendMessage failed: ret=-2");
      sent.push(text);
    },
    async file(absPath, caption) {
      if (fail) throw new Error("upload failed");
      if (caption) sent.push(caption);
      sent.push(`file ${absPath}`);
      return "file";
    },
    async typing() {
      return async () => {};
    },
  };
  return { out, sent };
}

function messages(events: InstanceType<typeof EventLog>) {
  return events.readSince(0).flatMap((e) => (e.type === "message.created" ? [e.data] : []));
}

test("the app channel sends nothing: text, files and typing all resolve", async () => {
  const out = appOutbound();
  assert.equal(out.channel, "app");
  await out.text("hello");
  assert.equal(await out.file(path.join(workspace, "reports", "vps.md"), "caption"), "file");
  assert.equal(await out.file("/x/cover.jpg"), "image");
  const stop = await out.typing();
  await stop();
});

test("recorded text appends an outbound message event after the send, with the run id", async () => {
  const events = newLog();
  const { out, sent } = fakeOut("wechat");
  await recorded(out, events, { workspace, runId: "k7m2qa" }).text("报告写好了。");

  assert.deepEqual(sent, ["报告写好了。"]);
  const [message, ...rest] = messages(events);
  assert.equal(rest.length, 0);
  assert.equal(message?.channel, "wechat");
  assert.equal(message?.direction, "out");
  assert.equal(message?.text, "报告写好了。");
  assert.deepEqual(message?.files, []);
  assert.equal(message?.runId, "k7m2qa");
  assert.equal(message?.error, undefined);
  assert.match(message?.id ?? "", /^[0-9a-f-]{36}$/);
});

test("a send the channel refuses is recorded with the error and still rejects", async () => {
  const events = newLog();
  const { out } = fakeOut("wechat", true);
  await assert.rejects(recorded(out, events, { workspace, runId: "k7m2qa" }).text("报告写好了。"), /ret=-2/);

  const [message] = messages(events);
  assert.equal(message?.text, "报告写好了。");
  assert.equal(message?.error, "sendMessage failed: ret=-2");
  assert.equal(message?.runId, "k7m2qa");
});

test("a file is recorded with its workspace path and kind, after its caption as a message of its own", async () => {
  const events = newLog();
  const { out, sent } = fakeOut("app");
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
  const { out } = fakeOut("wechat", true);
  await assert.rejects(recorded(out, events, { workspace }).file(path.join(workspace, "reports", "vps.md")), /upload failed/);

  const [message] = messages(events);
  assert.deepEqual(message?.files, [{ path: "reports/vps.md", kind: "file" }]);
  assert.equal(message?.error, "upload failed");
  assert.equal(message?.runId, undefined);
});

test("typing passes through and is not recorded", async () => {
  const events = newLog();
  let started = 0;
  const out: Outbound = { ...fakeOut("wechat").out, typing: async () => (started++, async () => {}) };
  await (await recorded(out, events, { workspace }).typing())();
  assert.equal(started, 1);
  assert.deepEqual(events.readSince(0), []);
});

test("recordInbound records the files, the client id and the run, and skips a message with nothing to show", () => {
  const events = newLog();
  recordInbound(events, { channel: "app", text: "帮我查一下 VPS 价格", files: [], clientId: "c-7f3a9e" }, "k7m2qa");
  recordInbound(events, { channel: "wechat", text: "", files: [{ path: "inbox/2026-10-25/image-083110.jpg", kind: "image" }] });
  recordInbound(events, { channel: "wechat", text: "", files: [], voice: true });
  recordInbound(events, { channel: "wechat", text: "  \n", files: [], failed: ["image 保存失败：x"] });

  const [app, wechat, ...rest] = messages(events);
  assert.equal(rest.length, 0);
  assert.deepEqual([app?.channel, app?.direction, app?.text, app?.clientId, app?.runId], ["app", "in", "帮我查一下 VPS 价格", "c-7f3a9e", "k7m2qa"]);
  assert.deepEqual([wechat?.channel, wechat?.direction, wechat?.text, wechat?.clientId, wechat?.runId], ["wechat", "in", "", undefined, undefined]);
  assert.deepEqual(wechat?.files, [{ path: "inbox/2026-10-25/image-083110.jpg", kind: "image" }]);
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
