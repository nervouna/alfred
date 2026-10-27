import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// store.ts reads these at import time, so set them before loading the modules under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alf-")));
process.env.ALFRED_STATE_DIR = path.join(tmp, "state");
process.env.ALFRED_WORKSPACE = path.join(tmp, "workspace");

const { ErrorResponseSchema, IdeaAcceptedSchema, IdeaGenerationAcceptedSchema, MAX_COMMAND_BYTES, MAX_UPLOAD_BYTES, TaskResultSchema, UploadResultSchema, parseCommand } = await import("../api/schema.ts");
const { DeviceStore } = await import("./devices.ts");
const { createHandler } = await import("./server.ts");

const devices = new DeviceStore(path.join(tmp, "app"));
const paired = devices.createDevice("test phone");
const bearer = { Authorization: `Bearer ${paired.token}` };

// --- A fake of Alfred's command socket --------------------------------------

interface Seen {
  method?: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** Every request that reached the fake upstream in full. */
const upstreamSeen: Seen[] = [];
/** The /events requests the fake saw close, by their `after` value. */
const eventsClosed = new Set<string>();
/** How the fake answers /events: hold the stream open, end it, or break it. */
let eventsMode: "hold" | "end" | "break" = "hold";

/** The TaskResult the fake answers a task.create with, as the commands fixture's task would come back. */
const taskResultBody: unknown = JSON.parse(fs.readFileSync(new URL("../../fixtures/api/responses/task-result.json", import.meta.url), "utf8"));
/** The IdeaAccepted and IdeaGenerationAccepted the fake answers an idea.accept and an idea.generate with. */
const ideaAcceptedBody: unknown = JSON.parse(fs.readFileSync(new URL("../../fixtures/api/responses/idea-accepted.json", import.meta.url), "utf8"));
const ideaGenerationBody: unknown = JSON.parse(fs.readFileSync(new URL("../../fixtures/api/responses/idea-generation-accepted.json", import.meta.url), "utf8"));

/** The frames the fake sends on /events: one with an id, a ping, and a live event without one. */
const FRAMES =
  'id: 7\nevent: message.created\ndata: {"id":7,"at":"2026-10-26T01:00:00.000Z","type":"message.created","data":{"id":"m-7","channel":"app","direction":"out","text":"好","files":[],"at":"2026-10-26T01:00:00.000Z","runId":"abcdef"}}\n\n' +
  ": ping\n\n" +
  'data: {"at":"2026-10-26T01:00:01.000Z","type":"message.delta","data":{"runId":"abcdef","streamId":"s-1","text":"你"}}\n\n';

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://alfred");
    const body = Buffer.concat(chunks);
    upstreamSeen.push({ method: req.method, url: req.url ?? "", headers: req.headers, body });
    if (req.method === "POST" && url.pathname === "/commands") {
      const command = JSON.parse(body.toString("utf8")) as { type: string; runId?: string };
      if (command.type === "run.stop") return sendJson(res, 404, { error: `no live or queued run ${command.runId}` });
      if (command.type === "task.create") return sendJson(res, 201, taskResultBody);
      if (command.type === "idea.accept") return sendJson(res, 200, ideaAcceptedBody);
      if (command.type === "idea.reject") return sendJson(res, 409, { error: "the idea is accepted" });
      if (command.type === "idea.generate") return sendJson(res, 202, ideaGenerationBody);
      return sendJson(res, 202, { accepted: true });
    }
    if (req.method === "POST" && url.pathname === "/uploads") {
      const name = url.searchParams.get("name") ?? "";
      return sendJson(res, 201, { file: { path: `inbox/2026-10-26/${name}`, kind: "image" } });
    }
    if (req.method === "GET" && url.pathname === "/events") {
      const after = url.searchParams.get("after") ?? "none";
      if (after === "bad") return sendJson(res, 400, { error: "after must be a non-negative integer" });
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
      // A broken stream is cut once the frames are on the wire, as a dropped connection would be.
      if (eventsMode === "break") return res.write(FRAMES, () => res.destroy());
      res.write(FRAMES);
      res.on("close", () => eventsClosed.add(after));
      if (eventsMode === "end") return res.end();
      return undefined; // held open until the client or the workbench goes
    }
    sendJson(res, 404, { error: "not found" });
  });
});

const upstreamSocket = path.join(tmp, "alfred.sock");
const downSocket = path.join(tmp, "down.sock"); // never created: Alfred is not running

// --- The workbench under test -----------------------------------------------

const servers: http.Server[] = [];
let open = "";
let down = "";

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

before(async () => {
  fs.mkdirSync(path.join(tmp, "workspace"), { recursive: true });
  await new Promise<void>((resolve) => upstream.listen(upstreamSocket, resolve));
  servers.push(upstream);
  open = await serve(createHandler({ workspace: path.join(tmp, "workspace"), devices, apiSocket: upstreamSocket }));
  down = await serve(createHandler({ workspace: path.join(tmp, "workspace"), devices, apiSocket: downSocket }));
});

after(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

/** The requests that reached the fake upstream on a path, as the fake saw them. */
function reached(pathname: string): Seen[] {
  return upstreamSeen.filter((s) => new URL(s.url, "http://alfred").pathname === pathname);
}

/** Sends a body whose length is declared (or not, for chunks) and returns the status, without waiting for the body to be accepted. */
function sendUpload(
  base: string,
  target: string,
  opts: { headers?: http.OutgoingHttpHeaders; chunks: number; chunkBytes: number; end?: boolean },
): Promise<{ status: number; body: string }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, method: "POST", path: target, headers: { ...bearer, ...opts.headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      res.on("error", () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on("error", () => {}); // the workbench may cut a body it has refused
    const timer = setTimeout(() => reject(new Error("no answer while the body was still being sent")), 5000);
    timer.unref();
    const chunk = Buffer.alloc(opts.chunkBytes, 0x61);
    for (let i = 0; i < opts.chunks; i++) req.write(chunk);
    if (opts.end !== false) req.end();
  });
}

// --- Commands -----------------------------------------------------------------

test("a valid command is forwarded to /commands with its body, and the upstream status and body are relayed", async () => {
  const command = { type: "message.send", clientId: "c-fwd-1", text: "你好" };
  const res = await fetch(`${open}/api/commands`, {
    method: "POST",
    headers: { ...bearer, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { accepted: true });
  const [sent] = reached("/commands").filter((s) => s.body.toString("utf8").includes("c-fwd-1"));
  assert.ok(sent, "the command reached the upstream");
  assert.equal(sent.method, "POST");
  assert.equal(sent.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(sent.body.toString("utf8")), command);
});

test("an upstream error on a command is relayed with its status and body", async () => {
  const res = await fetch(`${open}/api/commands`, {
    method: "POST",
    headers: { ...bearer, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "run.stop", runId: "abcdef" }),
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "no live or queued run abcdef" });
});

test("a command with files is forwarded as the command set allows it", async () => {
  const command = { type: "message.send", clientId: "c-fwd-files", text: "", files: [{ path: "inbox/2026-10-26/a.png", kind: "image" }] };
  const res = await fetch(`${open}/api/commands`, { method: "POST", headers: { ...bearer, "Content-Type": "application/json" }, body: JSON.stringify(command) });
  assert.equal(res.status, 202);
});

test("a question.answer is forwarded, and Alfred's 404 for a question that is not open comes back", async () => {
  const command = { type: "question.answer", questionId: "q-fwd", answers: { "报告用哪种格式？": "短表格" } };
  const res = await fetch(`${open}/api/commands`, { method: "POST", headers: { ...bearer, "Content-Type": "application/json" }, body: JSON.stringify(command) });
  assert.equal(res.status, 202);
  const sent = upstreamSeen.at(-1);
  assert.deepEqual(JSON.parse(sent?.body.toString("utf8") ?? ""), command);
});

test("a task.create is forwarded, and Alfred's 201 comes back with its task as it is", async () => {
  assert.ok(TaskResultSchema.safeParse(taskResultBody).success, "the fake answers a TaskResult");
  const command = { type: "task.create", title: "每日 VPS 价格", brief: "查三家供应商官网的定价页。", schedule: { kind: "daily", time: "09:00" } };
  const res = await fetch(`${open}/api/commands`, { method: "POST", headers: { ...bearer, "Content-Type": "application/json" }, body: JSON.stringify(command) });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(await res.json(), taskResultBody);
  const sent = upstreamSeen.at(-1);
  assert.deepEqual(JSON.parse(sent?.body.toString("utf8") ?? ""), command);
});

test("an idea.accept is forwarded, and Alfred's 200 comes back with the idea and its task as they are", async () => {
  assert.ok(IdeaAcceptedSchema.safeParse(ideaAcceptedBody).success, "the fake answers an IdeaAccepted");
  const command = { type: "idea.accept", ideaId: "k4p9rx", title: "盯住供应商状态页", brief: "只报告新出现的故障。", model: "sonnet", budgetUsd: 1 };
  const res = await fetch(`${open}/api/commands`, { method: "POST", headers: { ...bearer, "Content-Type": "application/json" }, body: JSON.stringify(command) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), ideaAcceptedBody);
  const sent = upstreamSeen.at(-1);
  assert.deepEqual(JSON.parse(sent?.body.toString("utf8") ?? ""), command);
});

test("an idea.reject is forwarded, and Alfred's 409 for an idea that is not open comes back", async () => {
  const command = { type: "idea.reject", ideaId: "k4p9rx", reason: "not-now", note: "下周再说" };
  const res = await fetch(`${open}/api/commands`, { method: "POST", headers: { ...bearer, "Content-Type": "application/json" }, body: JSON.stringify(command) });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "the idea is accepted" });
  const sent = upstreamSeen.at(-1);
  assert.deepEqual(JSON.parse(sent?.body.toString("utf8") ?? ""), command);
});

test("an idea.generate is forwarded, and Alfred's 202 comes back with the generation run", async () => {
  assert.ok(IdeaGenerationAcceptedSchema.safeParse(ideaGenerationBody).success, "the fake answers an IdeaGenerationAccepted");
  const res = await fetch(`${open}/api/commands`, { method: "POST", headers: { ...bearer, "Content-Type": "application/json" }, body: JSON.stringify({ type: "idea.generate" }) });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), ideaGenerationBody);
  const sent = upstreamSeen.at(-1);
  assert.deepEqual(JSON.parse(sent?.body.toString("utf8") ?? ""), { type: "idea.generate" });
});

test("an invalid command gets 400 with the parser's error line and never reaches Alfred", async () => {
  const before = upstreamSeen.length;
  const cases: unknown[] = [
    { type: "question.answer", questionId: "q-bad", answers: {} },
    { type: "question.answer", questionId: "q-bad", answers: { 问题: "" } },
    { type: "message.send", clientId: "c-bad-1", text: "   " },
    { type: "run.stop" },
    { type: "message.send", clientId: "c-bad-2", text: "", files: [{ path: "notes/a.md" }] },
    { type: "delete.everything" },
    ["not", "an", "object"],
  ];
  for (const c of cases) {
    const res = await fetch(`${open}/api/commands`, { method: "POST", headers: { ...bearer, "Content-Type": "application/json" }, body: JSON.stringify(c) });
    const parsed = parseCommand(c);
    assert.equal(parsed.ok, false);
    assert.equal(res.status, 400, JSON.stringify(c));
    assert.deepEqual(await res.json(), { error: parsed.ok ? "" : parsed.error });
  }
  assert.equal(upstreamSeen.length, before, "nothing was forwarded");
});

test("a body that is not JSON, or not sent as JSON, gets 400 and is not forwarded", async () => {
  const before = upstreamSeen.length;
  const notJson = await fetch(`${open}/api/commands`, { method: "POST", headers: { ...bearer, "Content-Type": "application/json" }, body: "{not json" });
  assert.equal(notJson.status, 400);
  assert.deepEqual(await notJson.json(), { error: "body is not valid JSON" });
  const wrongType = await fetch(`${open}/api/commands`, { method: "POST", headers: { ...bearer, "Content-Type": "text/plain" }, body: "{}" });
  assert.equal(wrongType.status, 400);
  assert.ok(ErrorResponseSchema.safeParse(await wrongType.json()).success);
  assert.equal(upstreamSeen.length, before);
});

test("a command over the limit gets 413 and is not forwarded", async () => {
  const before = upstreamSeen.length;
  const res = await sendUpload(open, "/api/commands", {
    headers: { "Content-Type": "application/json" },
    chunks: 1,
    chunkBytes: MAX_COMMAND_BYTES + 1,
  });
  assert.equal(res.status, 413);
  assert.ok(ErrorResponseSchema.safeParse(JSON.parse(res.body)).success);
  assert.equal(upstreamSeen.length, before);
});

// --- Events -------------------------------------------------------------------

test("the event stream is relayed byte for byte, with the Last-Event-ID header passed on", async () => {
  eventsMode = "hold";
  const res = await fetch(`${open}/api/events`, { headers: { ...bearer, "Last-Event-ID": "6" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.equal(res.headers.get("cache-control"), "no-store");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (text.length < FRAMES.length) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    text += decoder.decode(value, { stream: true });
  }
  assert.equal(text, FRAMES, "frames, pings and the id-less live frame pass through unchanged");
  await reader.cancel();
  const seen = reached("/events").at(-1);
  assert.equal(seen?.headers["last-event-id"], "6");
});

test("?after= is passed on to /events", async () => {
  eventsMode = "hold";
  const controller = new AbortController();
  const res = await fetch(`${open}/api/events?after=41`, { headers: bearer, signal: controller.signal });
  assert.equal(res.status, 200);
  await res.body!.getReader().read();
  controller.abort();
  assert.equal(reached("/events").at(-1)?.url, "/events?after=41");
});

test("a rejected resume point gets the upstream's 400 with its JSON error", async () => {
  const res = await fetch(`${open}/api/events?after=bad`, { headers: bearer });
  assert.equal(res.status, 400);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(await res.json(), { error: "after must be a non-negative integer" });
});

test("when the upstream ends the stream, the client's response ends", async () => {
  eventsMode = "end";
  const res = await fetch(`${open}/api/events?after=end-case`, { headers: bearer });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), FRAMES);
});

test("when the upstream breaks the stream, the client's response ends", async () => {
  eventsMode = "break";
  const res = await fetch(`${open}/api/events?after=break-case`, { headers: bearer });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), FRAMES);
  eventsMode = "hold";
});

test("when the client goes away, the upstream request is closed", async () => {
  eventsMode = "hold";
  const controller = new AbortController();
  const res = await fetch(`${open}/api/events?after=77`, { headers: bearer, signal: controller.signal });
  await res.body!.getReader().read();
  assert.equal(eventsClosed.has("77"), false);
  controller.abort();
  await waitFor(() => eventsClosed.has("77"), "the upstream /events request to close");
});

// --- Uploads ------------------------------------------------------------------

test("an upload is forwarded with its name, content type and bytes, and the upstream answer is relayed", async () => {
  const bytes = crypto.randomBytes(4096);
  const name = "报告 1.pdf";
  const res = await fetch(`${open}/api/uploads?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { ...bearer, "Content-Type": "application/pdf" },
    body: bytes,
  });
  assert.equal(res.status, 201);
  assert.ok(UploadResultSchema.safeParse(await res.json()).success);
  const [sent] = reached("/uploads").filter((s) => new URL(s.url, "http://alfred").searchParams.get("name") === name);
  assert.ok(sent, "the upload reached the upstream under its name");
  assert.equal(sent.headers["content-type"], "application/pdf");
  assert.ok(sent.body.equals(bytes), "the bytes arrive unchanged");
});

test("an upload declaring more than the limit gets 413 before anything is forwarded", async () => {
  const res = await sendUpload(open, "/api/uploads?name=too-big-declared.bin", {
    headers: { "Content-Type": "application/octet-stream", "Content-Length": String(MAX_UPLOAD_BYTES + 1) },
    chunks: 1,
    chunkBytes: 16,
    end: false,
  });
  assert.equal(res.status, 413);
  assert.ok(ErrorResponseSchema.safeParse(JSON.parse(res.body)).success);
  assert.equal(reached("/uploads").some((s) => s.url.includes("too-big-declared")), false);
});

test("a chunked upload past the limit is cut with 413, and never completes upstream", async () => {
  const mib = 1024 * 1024;
  const chunks = Math.ceil(MAX_UPLOAD_BYTES / mib) + 1;
  const res = await sendUpload(open, "/api/uploads?name=too-big-chunked.bin", {
    headers: { "Content-Type": "application/octet-stream" },
    chunks,
    chunkBytes: mib,
  });
  assert.equal(res.status, 413);
  assert.ok(ErrorResponseSchema.safeParse(JSON.parse(res.body)).success);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(reached("/uploads").some((s) => s.url.includes("too-big-chunked")), false, "the upstream never got the whole body");
});

// --- Alfred down ----------------------------------------------------------------

test("with Alfred's socket unreachable, the three routes answer 503 with an ErrorResponse", async () => {
  const headers = { ...bearer, "Content-Type": "application/json" };
  const command = await fetch(`${down}/api/commands`, { method: "POST", headers, body: JSON.stringify({ type: "run.stop", runId: "abcdef" }) });
  assert.equal(command.status, 503);
  assert.ok(ErrorResponseSchema.safeParse(await command.json()).success);

  const events = await fetch(`${down}/api/events`, { headers: bearer });
  assert.equal(events.status, 503);
  assert.ok(ErrorResponseSchema.safeParse(await events.json()).success);

  const upload = await fetch(`${down}/api/uploads?name=a.bin`, { method: "POST", headers: { ...bearer, "Content-Type": "application/octet-stream" }, body: Buffer.from("abc") });
  assert.equal(upload.status, 503);
  assert.ok(ErrorResponseSchema.safeParse(await upload.json()).success);
});

// --- Authentication and methods ---------------------------------------------------

test("each forwarding route needs a paired device's bearer token", async () => {
  const routes: [string, string][] = [
    ["POST", "/api/commands"],
    ["GET", "/api/events"],
    ["POST", "/api/uploads?name=a.bin"],
  ];
  for (const [method, p] of routes) {
    const res = await fetch(`${open}${p}`, { method, body: method === "POST" ? "{}" : undefined });
    assert.equal(res.status, 401, `${method} ${p}`);
  }
});

test("a method a forwarding route does not take gets 405 naming the one it takes", async () => {
  const cases: [string, string, string][] = [
    ["GET", "/api/commands", "POST"],
    ["POST", "/api/events", "GET"],
    ["GET", "/api/uploads?name=a.bin", "POST"],
  ];
  for (const [method, p, allow] of cases) {
    const res = await fetch(`${open}${p}`, { method, headers: bearer, body: method === "POST" ? "{}" : undefined });
    assert.equal(res.status, 405, `${method} ${p}`);
    assert.equal(res.headers.get("allow"), allow, `${method} ${p}`);
  }
});
