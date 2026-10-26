import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// store.ts reads these at import time, so set them before loading the modules under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-close-")));
const workspace = path.join(tmp, "workspace");
process.env.ALFRED_STATE_DIR = path.join(tmp, "state");
process.env.ALFRED_WORKSPACE = workspace;

const { DeviceStore } = await import("./devices.ts");
const { runPushDispatcher } = await import("./push.ts");
const { startWorkbench } = await import("./server.ts");

const devices = new DeviceStore(path.join(tmp, "app"));
const paired = devices.createDevice("test phone");
const bearer = { Authorization: `Bearer ${paired.token}` };

/** The close grace period the workbench gives other requests, in ms. */
const GRACE_MS = 2000;

// --- A fake of Alfred's command socket --------------------------------------

const upstreamSocket = path.join(tmp, "alfred.sock");
/** How many /events requests the fake has answered, and how many of those have closed. */
let eventsOpened = 0;
let eventsClosed = 0;
/** The texts of the /commands the fake has received, and whether the one it never answers has closed. */
const arrivals = new Set<string>();
let stuckClosed = false;

/** One event as a stream frame: the id, the type and the JSON of the whole event. */
const FRAME =
  'id: 1\nevent: message.created\ndata: {"id":1,"at":"2026-10-26T01:00:00.000Z","type":"message.created","data":{"id":"m-1","channel":"app","direction":"out","text":"好","files":[],"at":"2026-10-26T01:00:00.000Z"}}\n\n';

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://alfred");
    if (req.method === "GET" && url.pathname === "/events") {
      eventsOpened++;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(FRAME);
      res.on("close", () => eventsClosed++);
      return undefined; // held open until the workbench or the client goes
    }
    if (req.method === "POST" && url.pathname === "/commands") {
      const text = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { text?: string }).text ?? "";
      arrivals.add(text);
      if (text === "stuck") {
        res.on("close", () => (stuckClosed = true));
        return undefined; // never answered
      }
      if (text === "slow") {
        // Answered after a second, which is within the grace period.
        setTimeout(() => sendJson(res, 202, { accepted: true }), 1000);
        return undefined;
      }
      return sendJson(res, 202, { accepted: true });
    }
    sendJson(res, 404, { error: "not found" });
  });
});

// --- The workbench under test -----------------------------------------------

/** Every workbench started here and not yet stopped, so a failing test does not leave one listening. */
const running = new Set<() => Promise<void>>();
let sockets = 0;

/** A workbench on its own Unix socket, forwarding to the fake upstream. */
async function startBench(): Promise<{ socket: string; stop: () => Promise<void> }> {
  const socket = path.join(tmp, `wb-${sockets++}.sock`);
  const close = await startWorkbench({ workspace, socket, devices });
  const stop = async () => {
    running.delete(stop);
    await close();
  };
  running.add(stop);
  return { socket, stop };
}

before(async () => {
  fs.mkdirSync(workspace, { recursive: true });
  await new Promise<void>((resolve) => upstream.listen(upstreamSocket, resolve));
  // The forwarding routes read Alfred's socket from the environment when the workbench starts.
  process.env.ALFRED_API_SOCKET = upstreamSocket;
});

after(async () => {
  // A workbench that did not close in a test is given a bounded wait here, so a failure cannot hang the run.
  await Promise.all([...running].map((stop) => within(stop(), 3000, "close() in cleanup").catch(() => {})));
  await new Promise<void>((resolve) => {
    upstream.closeAllConnections();
    upstream.close(() => resolve());
  });
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- Helpers ----------------------------------------------------------------

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

/** Resolves with what `promise` resolves to, or rejects with `label` once `ms` have passed. */
function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} (no answer within ${ms} ms)`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** A request to the workbench's socket, resolved with the response once its headers arrive. */
function open(agent: http.Agent, socket: string, method: string, target: string, body?: string, headers: http.OutgoingHttpHeaders = {}): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, method, path: target, agent, headers: { ...bearer, ...headers } }, resolve);
    req.on("error", reject);
    req.end(body);
  });
}

/** A message.send command with the given text, as a request body. */
function sendBody(text: string): string {
  return JSON.stringify({ type: "message.send", clientId: `c-${text}-${Math.random().toString(36).slice(2)}`, text });
}

// --- Tests ------------------------------------------------------------------

test("closing the workbench ends a followed event stream at once, and the upstream request with it", async () => {
  const { socket, stop } = await startBench();
  const agent = new http.Agent({ keepAlive: false });
  const followed = await open(agent, socket, "GET", "/api/events");
  assert.equal(followed.statusCode, 200);
  followed.on("error", () => {});
  const ended = new Promise<void>((resolve) => followed.once("close", resolve));
  await new Promise<void>((resolve) => followed.once("data", () => resolve())); // the first frame is on the wire
  assert.ok(eventsOpened > 0);
  const closedBefore = eventsClosed;

  const started = Date.now();
  await within(stop(), 3000, "close() of a workbench with a followed event stream");
  const elapsed = Date.now() - started;

  await waitFor(() => eventsClosed > closedBefore, "the upstream /events request to close");
  await within(ended, 1000, "the client's event stream to end");
  assert.ok(elapsed < 3000, `close() took ${elapsed} ms`);
  agent.destroy();
});

test("an idle keep-alive connection does not hold close() beyond the grace period", async () => {
  const { socket, stop } = await startBench();
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const ping = await open(agent, socket, "GET", "/api/ping");
  assert.equal(ping.statusCode, 204);
  ping.resume();
  await new Promise((resolve) => ping.once("end", resolve));
  // The connection stays open and idle, waiting for its next request.
  await waitFor(() => Object.values(agent.freeSockets).flat().length === 1, "the keep-alive connection to be idle");

  const started = Date.now();
  await within(stop(), GRACE_MS + 1000, "close() with an idle keep-alive connection");
  const elapsed = Date.now() - started;
  assert.ok(elapsed < GRACE_MS, `close() waited ${elapsed} ms for an idle connection`);
  agent.destroy();
});

test("a request in flight within the grace period still gets its answer", async () => {
  const { socket, stop } = await startBench();
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const sending = open(agent, socket, "POST", "/api/commands", sendBody("slow"), { "Content-Type": "application/json" });
  await waitFor(() => arrivals.has("slow"), "the slow command to reach the upstream");

  const started = Date.now();
  const closing = stop();
  const res = await within(sending, GRACE_MS, "the in-flight command's answer");
  const body = await new Promise<string>((resolve, reject) => {
    let text = "";
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => (text += chunk));
    res.once("end", () => resolve(text));
    res.once("error", reject);
  });
  await within(closing, GRACE_MS + 1000, "close() after the in-flight answer");
  const elapsed = Date.now() - started;

  assert.equal(res.statusCode, 202);
  assert.deepEqual(JSON.parse(body), { accepted: true });
  // Answered after about a second, and the idle connection goes with it: close() does not wait out the grace period.
  assert.ok(elapsed < GRACE_MS, `close() took ${elapsed} ms after a 1 s answer`);
  agent.destroy();
});

test("a request still in flight after the grace period is cut, and close() resolves about 2 s after it began", async () => {
  const { socket, stop } = await startBench();
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const sending = open(agent, socket, "POST", "/api/commands", sendBody("stuck"), { "Content-Type": "application/json" });
  const outcome = sending.then(
    () => "answered",
    () => "cut",
  );
  await waitFor(() => arrivals.has("stuck"), "the stuck command to reach the upstream");

  const started = Date.now();
  await within(stop(), GRACE_MS + 1000, "close() with a request that never finishes");
  const elapsed = Date.now() - started;

  assert.equal(await outcome, "cut");
  assert.ok(elapsed >= GRACE_MS - 100, `close() cut the request after ${elapsed} ms, before the grace period`);
  assert.ok(elapsed < GRACE_MS + 1000, `close() took ${elapsed} ms`);
  await waitFor(() => stuckClosed, "the upstream request for the cut command to close");
  agent.destroy();
});

test("the push dispatcher stops following Alfred's stream when it is aborted", async () => {
  const cursorFile = path.join(tmp, "push", "push-cursor.json");
  fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
  fs.writeFileSync(cursorFile, JSON.stringify({ lastEventId: 0 }));
  const apns = { send: async () => ({ status: 200 as const }) };
  const signal = new AbortController();
  const openedBefore = eventsOpened;
  const closedBefore = eventsClosed;
  const done = runPushDispatcher({ socket: upstreamSocket, cursorFile, devices, apns, signal: signal.signal, backoff: { minMs: 5, maxMs: 20 } });
  await waitFor(() => eventsOpened > openedBefore, "the dispatcher to open the stream");

  signal.abort();
  await within(done, 2000, "the push dispatcher after it is aborted");
  await waitFor(() => eventsClosed > closedBefore, "the dispatcher's upstream request to close");
});
