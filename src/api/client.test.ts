import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { Event, Run } from "./schema.ts";

// store.ts reads the state dir at import time, so set it before loading the modules under test.
// Unix socket paths are short-limited (about 100 bytes): keep the temp dir shallow.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alf-")));
process.env.ALFRED_STATE_DIR = path.join(tmp, "state");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { EventLog } = await import("../events.ts");
const { describeEvent, request, streamEvents } = await import("./client.ts");
const { startApi } = await import("./server.ts");

const run: Run = { id: "k7m2qa", kind: "task", title: "调研 VPS 价格", status: "running", startedAt: "2026-10-25T08:30:05.000Z", costUsd: 0.0123, files: [] };
const at = "2026-10-25T08:30:05.000Z";

const frameOf = (event: Event) => ({ id: event.id, type: event.type, data: JSON.stringify(event) });

test("an event is described on one line: id, type and a short summary", () => {
  const log = new EventLog(path.join(tmp, "describe.jsonl"));
  const started = log.append("run.updated", run);
  const said = log.append("message.created", { id: "m1", channel: "app", direction: "in", text: "你好\n第二行", files: [], at, clientId: "c-1", runId: "k7m2qa" });
  const sent = log.append("message.created", {
    id: "m2",
    channel: "app",
    direction: "out",
    text: "x".repeat(200),
    files: [{ path: "reports/a.md", kind: "file" }],
    at,
    runId: "k7m2qa",
  });
  assert.ok(started && said && sent);

  assert.equal(describeEvent(frameOf(started)), "1 run.updated k7m2qa task running $0.0123 调研 VPS 价格");
  assert.equal(describeEvent(frameOf(said)), "2 message.created app in run=k7m2qa 你好 第二行");
  assert.equal(describeEvent(frameOf(sent)), `3 message.created app out run=k7m2qa ${"x".repeat(60)}… +1 file`);
  assert.equal(describeEvent({ id: 4, type: "task.created", data: '{"id":4,\n"type":"task.created"}' }), '4 task.created {"id":4, "type":"task.created"}');
  assert.equal(describeEvent({ id: 5, type: "message", data: "not json" }), "5 message not json");
});

test("a live event comes without an id, and describeEvent calls it live", async (t) => {
  const dir = path.join(tmp, "live");
  const socket = path.join(dir, "api", "a.sock");
  const events = new EventLog(path.join(dir, "events.jsonl"));
  events.append("run.updated", run);
  const close = await startApi({ socket, handler: { submit: async () => {}, stopRun: async () => false, answerQuestion: async () => false }, events });
  t.after(close);

  const frames: { id: number; type: string; data: string }[] = [];
  const stop = new AbortController();
  const reading = (async () => {
    for await (const frame of streamEvents(socket, { signal: stop.signal })) frames.push(frame);
  })();
  while (frames.length < 1) await new Promise((resolve) => setTimeout(resolve, 5));
  events.publish("message.delta", { runId: "k7m2qa", streamId: "msg_01.0", text: "你好" });
  while (frames.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  stop.abort();
  await assert.rejects(reading, /aborted/);

  assert.deepEqual(frames.map((f) => [f.id, f.type]), [[1, "run.updated"], [Number.NaN, "message.delta"]]);
  const live = frames[1];
  assert.ok(live);
  assert.ok(describeEvent(live).startsWith('live message.delta {"at":'));
});

test("streamEvents reads the backlog and live events, resumes by id and stops when asked", async (t) => {
  const dir = path.join(tmp, "stream");
  const socket = path.join(dir, "api", "a.sock");
  const events = new EventLog(path.join(dir, "events.jsonl"));
  for (let i = 0; i < 3; i++) events.append("run.updated", run);
  const close = await startApi({ socket, handler: { submit: async () => {}, stopRun: async () => false, answerQuestion: async () => false }, events });
  t.after(close);

  const ids = async (opts: Parameters<typeof streamEvents>[1], count: number) => {
    const got: number[] = [];
    for await (const frame of streamEvents(socket, opts)) {
      got.push(frame.id);
      if (got.length === count) break;
    }
    return got;
  };
  assert.deepEqual(await ids({}, 3), [1, 2, 3]);
  assert.deepEqual(await ids({ after: 1 }, 2), [2, 3]);
  assert.deepEqual(await ids({ lastEventId: 2 }, 1), [3]);

  const live = ids({ after: 3 }, 2);
  setTimeout(() => {
    events.append("run.updated", run);
    events.append("run.updated", run);
  }, 20);
  assert.deepEqual(await live, [4, 5]);

  const stop = new AbortController();
  const aborted = (async () => {
    for await (const _ of streamEvents(socket, { after: 5, signal: stop.signal })) assert.fail("no event expected");
  })();
  setTimeout(() => stop.abort(), 20);
  await assert.rejects(aborted, /aborted/);

  await assert.rejects(ids({ after: -1 }, 1), /GET \/events answered 400/);
  assert.equal((await request(socket, "GET", "/health")).body, '{"ok":true,"lastEventId":5}');
});

test("a socket nobody listens on is reported as unreachable", async () => {
  await assert.rejects(request(path.join(tmp, "nobody.sock"), "GET", "/health"), /cannot reach Alfred's API at/);
  await assert.rejects(streamEvents(path.join(tmp, "nobody.sock")).next(), /cannot reach Alfred's API at/);
});

test("a request aborted by its signal rejects with the signal's reason and drops the connection, even if the socket never answers", async (t) => {
  const socket = path.join(tmp, "silent.sock");
  const server = http.createServer(() => {}); // takes every request and never answers it
  const received = new Promise<void>((resolve) => server.once("request", () => resolve()));
  const dropped = new Promise<void>((resolve) => server.on("connection", (conn) => conn.on("close", () => resolve())));
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });

  const gave = new AbortController();
  const reason = new Error("the caller gave up");
  const pending = request(socket, "GET", "/health", undefined, { signal: gave.signal });
  await received;
  gave.abort(reason);
  await assert.rejects(pending, (err) => err === reason);
  await dropped;

  await assert.rejects(request(socket, "GET", "/health", undefined, { signal: AbortSignal.abort(reason) }), (err) => err === reason, "an aborted signal sends nothing");
});
