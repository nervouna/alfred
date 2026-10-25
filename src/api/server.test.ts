import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { TestContext } from "node:test";

import type { Channel, Run } from "./schema.ts";
import type { InboundSource } from "../channels.ts";
import type { EventLog as EventLogType } from "../events.ts";

// store.ts reads the state dir at import time, so set it before loading the modules under test.
// Unix socket paths are short-limited (about 100 bytes): keep the temp dir shallow.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alf-")));
process.env.ALFRED_STATE_DIR = path.join(tmp, "state");
// With no umask in the way, the modes below are the server's doing.
const umask = process.umask(0);
after(() => {
  process.umask(umask);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const { EventLog } = await import("../events.ts");
const { MAX_COMMAND_BYTES, parseCommand } = await import("./schema.ts");
const { HEARTBEAT_MS, apiSocketPath, startApi } = await import("./server.ts");

const run: Run = { id: "k7m2qa", kind: "task", title: "调研 VPS 价格", status: "running", startedAt: "2026-10-25T08:30:05.000Z", costUsd: 0, files: [] };
const JSON_TYPE = { "Content-Type": "application/json" };
const message = { type: "message.send", clientId: "c-1", text: "你好" };

/** The events log, counting what is subscribed and the pages read. */
class WatchedLog extends EventLog {
  subscribers = 0;
  reads = 0;
  onRead: ((read: number) => void) | undefined;

  override subscribe(listener: Parameters<EventLogType["subscribe"]>[0]): () => void {
    this.subscribers++;
    const off = super.subscribe(listener);
    return () => {
      this.subscribers--;
      off();
    };
  }

  override readSince(afterId: number, limit?: number) {
    const events = super.readSince(afterId, limit);
    this.onRead?.(++this.reads);
    return events;
  }
}

/** Stands in for the agent handler: records what the API passes on. */
function stubHandler() {
  const handler = {
    submitted: [] as InboundSource[],
    stopped: [] as [string, Channel][],
    live: new Set(["k7m2qa"]),
    /** While set, submit() waits for it. */
    hold: undefined as Promise<void> | undefined,
    fail: false,
    async submit(source: InboundSource) {
      handler.submitted.push(source);
      await handler.hold;
      if (handler.fail) throw new Error("intake broke");
    },
    async stopRun(runId: string, channel: Channel) {
      handler.stopped.push([runId, channel]);
      return handler.live.has(runId);
    },
  };
  return handler;
}

let fixtures = 0;
/** An API on a socket of its own, with a stub handler and an event log of its own. */
async function start(t: TestContext, opts: { heartbeatMs?: number; pageSize?: number } = {}) {
  const dir = path.join(tmp, `t${fixtures++}`);
  const socket = path.join(dir, "api", "a.sock");
  const handler = stubHandler();
  const events = new WatchedLog(path.join(dir, "events.jsonl"));
  const close = await startApi({ socket, handler, events, ...opts });
  t.after(close);
  return { dir, socket, handler, events, close };
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: () => unknown;
}

function call(
  socket: string,
  method: string,
  target: string,
  opts: { headers?: http.OutgoingHttpHeaders; body?: string; agent?: http.Agent } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, method, path: target, headers: opts.headers, agent: opts.agent ?? false }, (res) => {
      res.setEncoding("utf8");
      let text = "";
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

/** Posts a command; a string is sent as it is, anything else as JSON. */
const post = (socket: string, body: unknown, headers: http.OutgoingHttpHeaders = JSON_TYPE, agent?: http.Agent) =>
  call(socket, "POST", "/commands", { headers, body: typeof body === "string" ? body : JSON.stringify(body), agent });

async function until(what: string, check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Sse {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: () => string;
  ids: () => number[];
  ended: () => boolean;
  close: () => void;
}

/** Opens a stream and collects what arrives. */
function open(t: TestContext, socket: string, target = "/events", headers: http.OutgoingHttpHeaders = {}): Promise<Sse> {
  return new Promise((resolve, reject) => {
    const req = http.get({ socketPath: socket, path: target, headers, agent: false }, (res) => {
      res.setEncoding("utf8");
      let text = "";
      res.on("data", (chunk: string) => (text += chunk));
      let ended = false;
      res.on("error", () => {});
      res.on("close", () => (ended = true));
      const sse: Sse = {
        status: res.statusCode ?? 0,
        headers: res.headers,
        text: () => text,
        ids: () => [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1])),
        ended: () => ended,
        close: () => req.destroy(),
      };
      t.after(() => req.destroy());
      resolve(sse);
    });
    req.on("error", reject);
  });
}

function appendRuns(events: EventLogType, n: number): void {
  for (let i = 0; i < n; i++) events.append("run.updated", run);
}

test("the socket is mode 0600 in a directory of mode 0700, and a stale socket file is replaced", async (t) => {
  const { dir, socket } = await start(t);
  assert.equal(fs.statSync(socket).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(socket)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(socket).isSocket(), true);

  // A socket file a crash left behind: bound by another process, never closed.
  const stale = path.join(dir, "stale", "a.sock");
  fs.mkdirSync(path.dirname(stale));
  const bound = spawnSync(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(stale)}, () => process.exit(0))`], { cwd: tmp });
  assert.equal(bound.status, 0, bound.stderr.toString());
  assert.equal(fs.lstatSync(stale).isSocket(), true);

  const close = await startApi({ socket: stale, handler: stubHandler(), events: new EventLog(path.join(dir, "e2.jsonl")) });
  t.after(close);
  assert.equal((await call(stale, "GET", "/health")).status, 200);
});

test("a file that is not a socket is not removed", async (t) => {
  const { dir } = await start(t);
  const file = path.join(dir, "keep.sock");
  fs.writeFileSync(file, "mine");
  await assert.rejects(startApi({ socket: file, handler: stubHandler(), events: new EventLog(path.join(dir, "e3.jsonl")) }));
  assert.equal(fs.readFileSync(file, "utf8"), "mine");
});

test("closing removes the socket, ends the streams and refuses new connections", async (t) => {
  const { socket, close } = await start(t);
  const sse = await open(t, socket);
  await close();
  assert.equal(fs.existsSync(socket), false);
  await until("the stream to end", sse.ended);
  await assert.rejects(call(socket, "GET", "/health"), /ENOENT|ECONNREFUSED/);
});

test("ALFRED_API_SOCKET picks the socket: a path, the default, or off", () => {
  const saved = process.env.ALFRED_API_SOCKET;
  try {
    delete process.env.ALFRED_API_SOCKET;
    assert.equal(apiSocketPath(), path.join(tmp, "state", "api", "alfred.sock"));
    process.env.ALFRED_API_SOCKET = "  ";
    assert.equal(apiSocketPath(), path.join(tmp, "state", "api", "alfred.sock"));
    process.env.ALFRED_API_SOCKET = "/run/alfred/api.sock";
    assert.equal(apiSocketPath(), "/run/alfred/api.sock");
    process.env.ALFRED_API_SOCKET = "off";
    assert.equal(apiSocketPath(), undefined);
  } finally {
    if (saved === undefined) delete process.env.ALFRED_API_SOCKET;
    else process.env.ALFRED_API_SOCKET = saved;
  }
});

test("GET /health", async (t) => {
  const { socket, events } = await start(t);
  const empty = await call(socket, "GET", "/health");
  assert.equal(empty.status, 200);
  assert.match(String(empty.headers["content-type"]), /^application\/json/);
  assert.deepEqual(empty.json(), { ok: true, lastEventId: 0 });
  appendRuns(events, 3);
  assert.deepEqual((await call(socket, "GET", "/health")).json(), { ok: true, lastEventId: 3 });
});

test("other paths get 404 and other methods 405 with the methods allowed", async (t) => {
  const { socket, handler } = await start(t);
  assert.equal((await call(socket, "GET", "/")).status, 404);
  assert.equal((await call(socket, "GET", "/nope")).status, 404);
  assert.equal((await call(socket, "GET", "/commands/")).status, 404);
  for (const [method, target, allow] of [
    ["GET", "/commands", "POST"],
    ["PUT", "/commands", "POST"],
    ["POST", "/events", "GET"],
    ["DELETE", "/events", "GET"],
    ["POST", "/health", "GET"],
  ] as const) {
    const reply = await call(socket, method, target);
    assert.equal(reply.status, 405, `${method} ${target}`);
    assert.equal(reply.headers.allow, allow);
    assert.deepEqual(Object.keys(reply.json() as object), ["error"]);
  }
  assert.equal(handler.submitted.length + handler.stopped.length, 0);
});

test("a body over the limit gets 413 as soon as the limit is crossed, and nothing is submitted", async (t) => {
  const { socket, handler } = await start(t);
  // A connection that stays open, as a client's does: the rest of the body is read and dropped, not left to break the connection.
  const agent = new http.Agent({ keepAlive: true });
  t.after(() => agent.destroy());
  const declared = await post(socket, "x".repeat(MAX_COMMAND_BYTES + 1), JSON_TYPE, agent);
  assert.equal(declared.status, 413);
  assert.deepEqual(Object.keys(declared.json() as object), ["error"]);

  // No length declared: the answer comes while the client is still sending, after a little over the limit.
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request({ socketPath: socket, method: "POST", path: "/commands", headers: JSON_TYPE, agent }, (res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
      req.destroy();
    });
    req.on("error", () => {});
    setTimeout(() => reject(new Error("no answer while the body was still being sent")), 5000).unref();
    const chunk = "x".repeat(MAX_COMMAND_BYTES / 2);
    req.write(chunk);
    req.write(chunk);
    req.write(chunk);
  });
  assert.equal(status, 413);

  // The limit itself is fine.
  const exact = JSON.stringify(message);
  const padded = exact + " ".repeat(MAX_COMMAND_BYTES - Buffer.byteLength(exact));
  assert.equal(Buffer.byteLength(padded), MAX_COMMAND_BYTES);
  assert.equal((await post(socket, padded, JSON_TYPE, agent)).status, 202);
  assert.equal((await post(socket, `${padded} `, JSON_TYPE, agent)).status, 413);
  assert.equal(handler.submitted.length, 1);
});

test("a bad request gets 400 and never reaches the handler", async (t) => {
  const { socket, handler } = await start(t);
  const expected = (value: unknown) => {
    const parsed = parseCommand(value);
    assert.equal(parsed.ok, false);
    return parsed.ok ? "" : parsed.error;
  };

  const invalidJson = await post(socket, "{not json");
  assert.equal(invalidJson.status, 400);
  assert.deepEqual(Object.keys(invalidJson.json() as object), ["error"]);
  assert.equal((await post(socket, "")).status, 400);

  const plain = await post(socket, message, { "Content-Type": "text/plain" });
  assert.equal(plain.status, 400);
  assert.match((plain.json() as { error: string }).error, /application\/json/);
  assert.equal((await post(socket, message, {})).status, 400);

  const unknown = { type: "message.delete", clientId: "c-2" };
  const unknownReply = await post(socket, unknown);
  assert.equal(unknownReply.status, 400);
  assert.deepEqual(unknownReply.json(), { error: expected(unknown) });

  const extra = { type: "run.stop", runId: "k7m2qa", force: true };
  const extraReply = await post(socket, extra);
  assert.equal(extraReply.status, 400);
  assert.deepEqual(extraReply.json(), { error: expected(extra) });

  for (const bad of [[], "text", 5, null, { type: "message.send", clientId: "c-3", text: "  " }, { type: "run.stop", runId: "K7M2QA" }]) {
    const reply = await post(socket, JSON.stringify(bad));
    assert.equal(reply.status, 400, JSON.stringify(bad));
    assert.deepEqual(reply.json(), { error: expected(bad) });
  }
  assert.equal(handler.submitted.length + handler.stopped.length, 0);
});

test("message.send hands the message to the handler once and answers 202", async (t) => {
  const { socket, handler } = await start(t);
  const reply = await post(socket, message);
  assert.equal(reply.status, 202);
  assert.deepEqual(reply.json(), { accepted: true });
  assert.deepEqual(handler.submitted, [{ channel: "app", text: "你好", clientId: "c-1", files: [] }]);

  // A charset on the content type is fine.
  assert.equal((await post(socket, { ...message, clientId: "c-2" }, { "Content-Type": "application/json; charset=utf-8" })).status, 202);
  assert.equal(handler.submitted.length, 2);
});

test("a client id that was accepted among the last 1000 is not submitted again", async (t) => {
  const { socket, handler } = await start(t);
  assert.equal((await post(socket, message)).status, 202);
  const duplicate = await post(socket, { ...message, text: "another text, same id" });
  assert.equal(duplicate.status, 200);
  assert.deepEqual(duplicate.json(), { accepted: false, duplicate: true });
  assert.equal(handler.submitted.length, 1);

  // Once 1000 others came after it, the first is forgotten.
  for (let i = 0; i < 1000; i++) assert.equal((await post(socket, { ...message, clientId: `n-${i}` })).status, 202);
  assert.equal(handler.submitted.length, 1001);
  assert.equal((await post(socket, { ...message, clientId: "n-999" })).status, 200, "the latest is still remembered");
  assert.equal((await post(socket, message)).status, 202, "the first is forgotten");
  assert.equal(handler.submitted.length, 1002);
});

test("two posts of one client id at once submit it once", async (t) => {
  const { socket, handler } = await start(t);
  let release = () => {};
  handler.hold = new Promise<void>((resolve) => (release = resolve));
  const first = post(socket, message);
  await until("the first to be submitted", () => handler.submitted.length === 1);
  const second = await post(socket, message);
  assert.equal(second.status, 200);
  assert.deepEqual(second.json(), { accepted: false, duplicate: true });
  release();
  assert.equal((await first).status, 202);
  assert.equal(handler.submitted.length, 1);
});

test("a message the handler cannot take gets 500 and may be sent again", async (t) => {
  const { socket, handler } = await start(t);
  handler.fail = true;
  const failed = await post(socket, message);
  assert.equal(failed.status, 500);
  assert.deepEqual(Object.keys(failed.json() as object), ["error"]);
  handler.fail = false;
  assert.equal((await post(socket, message)).status, 202);
  assert.equal(handler.submitted.length, 2);
});

test("run.stop stops a live run with 202 and answers 404 for any other", async (t) => {
  const { socket, handler } = await start(t);
  const stopped = await post(socket, { type: "run.stop", runId: "k7m2qa" });
  assert.equal(stopped.status, 202);
  assert.deepEqual(stopped.json(), { stopped: true });
  assert.deepEqual(handler.stopped, [["k7m2qa", "app"]]);

  const unknown = await post(socket, { type: "run.stop", runId: "zzzzzz" });
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.json(), { error: "no live or queued run zzzzzz" });
  assert.deepEqual(handler.stopped, [["k7m2qa", "app"], ["zzzzzz", "app"]]);
});

test("GET /events streams the backlog, then live events, as server-sent events", async (t) => {
  const { socket, events } = await start(t);
  appendRuns(events, 2);
  const sse = await open(t, socket);
  assert.equal(sse.status, 200);
  assert.match(String(sse.headers["content-type"]), /^text\/event-stream/);
  await until("the backlog", () => sse.ids().length === 2);

  const live = events.append("message.created", {
    id: "m-1",
    channel: "app",
    direction: "in",
    text: "你好",
    files: [],
    at: "2026-10-25T08:30:05.000Z",
    clientId: "c-1",
  });
  assert.ok(live);
  await until("the live event", () => sse.ids().length === 3);
  assert.deepEqual(sse.ids(), [1, 2, 3]);
  assert.ok(sse.text().endsWith(`id: 3\nevent: message.created\ndata: ${JSON.stringify(live)}\n\n`));
  const first = events.readSince(0, 1)[0];
  assert.ok(sse.text().startsWith(`id: 1\nevent: run.updated\ndata: ${JSON.stringify(first)}\n\n`), "the whole event on one line");
});

test("events appended while the backlog is read are neither skipped nor repeated", async (t) => {
  const { socket, events } = await start(t, { pageSize: 2 });
  appendRuns(events, 3);
  // Each read sees the log as it was, and an event lands right after it: the first two are read again
  // by the next page as well as buffered, the last is only buffered.
  events.onRead = (read) => {
    if (read <= 3) events.append("run.updated", run);
  };
  const sse = await open(t, socket);
  await until("the backlog", () => sse.ids().length >= 6);

  events.onRead = undefined;
  events.append("run.updated", run);
  await until("the live event", () => sse.ids().length >= 7);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(sse.ids(), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(events.reads, 3, "the backlog took three pages of two");
});

test("a client resumes after Last-Event-ID, which wins over ?after", async (t) => {
  const { socket, events } = await start(t);
  appendRuns(events, 5);

  const byHeader = await open(t, socket, "/events", { "Last-Event-ID": "3" });
  await until("events 4 and 5", () => byHeader.ids().length === 2);
  assert.deepEqual(byHeader.ids(), [4, 5]);

  const byQuery = await open(t, socket, "/events?after=1");
  await until("events 2 to 5", () => byQuery.ids().length === 4);
  assert.deepEqual(byQuery.ids(), [2, 3, 4, 5]);

  const both = await open(t, socket, "/events?after=1", { "Last-Event-ID": "4" });
  await until("event 5", () => both.ids().length === 1);
  assert.deepEqual(both.ids(), [5]);

  const none = await open(t, socket, "/events", { "Last-Event-ID": "5" });
  appendRuns(events, 1);
  await until("event 6", () => none.ids().length === 1);
  assert.deepEqual(none.ids(), [6]);

  const everything = await open(t, socket);
  await until("everything", () => everything.ids().length === 6);
  assert.deepEqual(everything.ids(), [1, 2, 3, 4, 5, 6]);
});

test("an id that is not a non-negative integer gets 400", async (t) => {
  const { socket } = await start(t);
  for (const target of ["/events?after=x", "/events?after=", "/events?after=-1", "/events?after=1.5", "/events?after=1e3", "/events?after=99999999999999999999"]) {
    const reply = await call(socket, "GET", target);
    assert.equal(reply.status, 400, target);
    assert.deepEqual(Object.keys(reply.json() as object), ["error"]);
  }
  for (const id of ["abc", "", "-1", "1.5", "1, 2"]) {
    const reply = await call(socket, "GET", "/events", { headers: { "Last-Event-ID": id } });
    assert.equal(reply.status, 400, `Last-Event-ID: ${id}`);
  }
  // Only the value in use is checked.
  const sse = await open(t, socket, "/events?after=x", { "Last-Event-ID": "0" });
  assert.equal(sse.status, 200);
});

test("a ping goes out on the heartbeat interval, which is 30 s by default", async (t) => {
  assert.equal(HEARTBEAT_MS, 30_000);
  const { socket } = await start(t, { heartbeatMs: 20 });
  const sse = await open(t, socket);
  await until("three pings", () => sse.text().split(": ping\n\n").length > 3);
  assert.equal(sse.text().replaceAll(": ping\n\n", ""), "", "only pings, as there are no events");
});

test("after the client disconnects, nothing stays subscribed and the heartbeat stops", async (t) => {
  const intervals = new Set<unknown>();
  const { setInterval: set, clearInterval: clear } = globalThis;
  globalThis.setInterval = ((fn: () => void, ms?: number) => {
    const timer = set(fn, ms);
    if (ms === 37) intervals.add(timer);
    return timer;
  }) as typeof setInterval;
  globalThis.clearInterval = ((timer: Parameters<typeof clearInterval>[0]) => {
    intervals.delete(timer);
    clear(timer);
  }) as typeof clearInterval;
  t.after(() => {
    globalThis.setInterval = set;
    globalThis.clearInterval = clear;
  });

  const { socket, events } = await start(t, { heartbeatMs: 37 });
  const sse = await open(t, socket);
  await until("the stream to subscribe", () => events.subscribers === 1 && intervals.size === 1);
  sse.close();
  await until("the subscription and the timer to go", () => events.subscribers === 0 && intervals.size === 0);
});

test("a client that leaves while the backlog is read is not read for any longer", async (t) => {
  const { socket, events } = await start(t, { pageSize: 1 });
  appendRuns(events, 60);
  let sse: Sse | undefined;
  let leftAt = 0;
  events.onRead = (read) => {
    if (!sse || leftAt) return;
    leftAt = read;
    sse.close();
  };
  sse = await open(t, socket);
  await until("the subscription to go", () => events.subscribers === 0);
  const reads = events.reads;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(events.reads, reads, "no page is read after the stream is gone");
  assert.ok(reads - leftAt < 5, `${reads - leftAt} pages read after the client left`);
  assert.ok(reads < 60, "the backlog was not read to its end");
});
