import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { TestContext } from "node:test";

import type {
  DocumentResult,
  DocumentRevise,
  DocumentUndo,
  IdeaAccept,
  IdeaAccepted,
  IdeaGenerate,
  IdeaGenerationAccepted,
  IdeaReject,
  IdeaResult,
  MemoryCreate,
  MemoryDelete,
  MemoryResult,
  MemoryUpdate,
  Run,
  RevisionAccepted,
  Rules,
  RulesSave,
  SettingsResult,
  SettingsUpdate,
  TaskCreate,
  TaskResult,
  TaskUpdate,
} from "./schema.ts";
import type { DocumentCommands, DocumentReply, IdeaCommands, IdeaReply, MemoryCommands, MemoryReply, RulesCommands, RulesReply, SettingsCommands, SettingsReply, TaskCommands, TaskReply } from "./server.ts";
import type { Inbound } from "../channels.ts";
import type { EventLog as EventLogType } from "../events.ts";

// store.ts reads the state dir at import time, so set it before loading the modules under test.
// Unix socket paths are short-limited (about 100 bytes): keep the temp dir shallow.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alf-")));
process.env.ALFRED_STATE_DIR = path.join(tmp, "state");
// Uploads and the files of a message are checked against the workspace's inbox.
const workspace = path.join(tmp, "workspace");
fs.mkdirSync(workspace);
process.env.ALFRED_WORKSPACE = workspace;
// With no umask in the way, the modes below are the server's doing.
const umask = process.umask(0);
after(() => {
  process.umask(umask);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const { EventLog } = await import("../events.ts");
const { localDate } = await import("../files.ts");
const { MAX_COMMAND_BYTES, MAX_UPLOAD_BYTES, SettingsResultSchema, TaskResultSchema, parseCommand } = await import("./schema.ts");
const { HEARTBEAT_MS, apiSocketPath, startApi } = await import("./server.ts");
const { InvalidAnswer } = await import("../channels.ts");

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
    submitted: [] as Inbound[],
    stopped: [] as string[],
    live: new Set(["k7m2qa"]),
    answered: [] as [string, Record<string, string>][],
    /** The open questions: an id and the texts of its questions. */
    open: new Map([["q-open", ["报告用哪种格式？"]]]),
    /** While set, submit() waits for it. */
    hold: undefined as Promise<void> | undefined,
    fail: false,
    async submit(inbound: Inbound) {
      handler.submitted.push(inbound);
      await handler.hold;
      if (handler.fail) throw new Error("intake broke");
    },
    async stopRun(runId: string) {
      handler.stopped.push(runId);
      return handler.live.has(runId);
    },
    async answerQuestion(id: string, answers: Record<string, string>) {
      handler.answered.push([id, answers]);
      const texts = handler.open.get(id);
      if (!texts) return false;
      const key = Object.keys(answers).find((k) => !texts.includes(k));
      if (key !== undefined) throw new InvalidAnswer(`answers.${key}: not the text of one of the question's questions`);
      return true;
    },
  };
  return handler;
}

let fixtures = 0;
/** An API on a socket of its own, with a stub handler and an event log of its own. */
async function start(
  t: TestContext,
  opts: { heartbeatMs?: number; pageSize?: number; tasks?: TaskCommands; documents?: DocumentCommands; ideas?: IdeaCommands; rules?: RulesCommands; memory?: MemoryCommands; settings?: SettingsCommands } = {},
) {
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
  opts: { headers?: http.OutgoingHttpHeaders; body?: string | Buffer; agent?: http.Agent } = {},
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
  assert.deepEqual(handler.submitted, [{ text: "你好", clientId: "c-1", files: [] }]);

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
  assert.deepEqual(handler.stopped, ["k7m2qa"]);

  const unknown = await post(socket, { type: "run.stop", runId: "zzzzzz" });
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.json(), { error: "no live or queued run zzzzzz" });
  assert.deepEqual(handler.stopped, ["k7m2qa", "zzzzzz"]);
});

test("question.answer answers an open question with 202, and the handler gets the id and the answers", async (t) => {
  const { socket, handler } = await start(t);
  const answers = { "报告用哪种格式？": "短表格" };
  const reply = await post(socket, { type: "question.answer", questionId: "q-open", answers });
  assert.equal(reply.status, 202);
  assert.deepEqual(reply.json(), { answered: true });
  assert.deepEqual(handler.answered, [["q-open", answers]]);
});

test("question.answer for a question that is not open gets 404", async (t) => {
  const { socket } = await start(t);
  const reply = await post(socket, { type: "question.answer", questionId: "q-gone", answers: { "报告用哪种格式？": "短表格" } });
  assert.equal(reply.status, 404);
  assert.deepEqual(reply.json(), { error: "no open question q-gone" });
});

test("question.answer with a key that is not one of the question's texts gets 400 with the handler's reason", async (t) => {
  const { socket } = await start(t);
  const reply = await post(socket, { type: "question.answer", questionId: "q-open", answers: { 别的问题: "x" } });
  assert.equal(reply.status, 400);
  assert.deepEqual(reply.json(), { error: "answers.别的问题: not the text of one of the question's questions" });
});

test("a question.answer that does not fit the schema gets 400 and never reaches the handler", async (t) => {
  const { socket, handler } = await start(t);
  for (const bad of [
    { type: "question.answer", questionId: "q-open", answers: {} },
    { type: "question.answer", questionId: "q-open", answers: { "报告用哪种格式？": "" } },
    { type: "question.answer", questionId: "q-open", answers: { "报告用哪种格式？": "x".repeat(2001) } },
    { type: "question.answer", questionId: "not an id", answers: { "报告用哪种格式？": "x" } },
    { type: "question.answer", answers: { "报告用哪种格式？": "x" } },
  ]) {
    assert.equal((await post(socket, bad)).status, 400, JSON.stringify(bad).slice(0, 80));
  }
  assert.deepEqual(handler.answered, []);
});

test("each task command fixture gets 503 until tasks are wired in, and never reaches the handler", async (t) => {
  const { socket, handler } = await start(t);
  for (const name of ["task-create.json", "task-update-schedule.json", "task-run.json"]) {
    const body = fs.readFileSync(new URL(`../../fixtures/api/commands/${name}`, import.meta.url), "utf8");
    const reply = await post(socket, body);
    assert.equal(reply.status, 503, name);
    assert.deepEqual(reply.json(), { error: "tasks are not available" }, name);
  }
  assert.equal(handler.submitted.length, 0, "submit was not called");
  assert.deepEqual(handler.stopped, []);
  assert.deepEqual(handler.answered, []);
});

// --- Task commands ------------------------------------------------------------

const fixture = (dir: string, name: string) => fs.readFileSync(new URL(`../../fixtures/api/${dir}/${name}`, import.meta.url), "utf8");
const taskResult = JSON.parse(fixture("responses", "task-result.json")) as TaskResult;

/** The command a commands fixture parses to, as parseCommand gives it. */
function parsedCommand(name: string) {
  const parsed = parseCommand(JSON.parse(fixture("commands", name)));
  if (!parsed.ok) throw new Error(`${name} does not parse: ${parsed.error}`);
  return parsed.command;
}

/** Stands in for the task store: records the commands it is given, and answers a create or an update with `refuse` when it is set. */
function stubTasks() {
  const tasks = {
    created: [] as TaskCreate[],
    updated: [] as TaskUpdate[],
    ran: [] as string[],
    refuse: undefined as Extract<TaskReply, { ok: false }> | undefined,
    /** The task ids the store holds: run answers false for any other. */
    known: new Set(["p3r8vx"]),
    async create(command: TaskCreate): Promise<TaskReply> {
      tasks.created.push(command);
      return tasks.refuse ?? { ok: true, task: taskResult.task };
    },
    async update(command: TaskUpdate): Promise<TaskReply> {
      tasks.updated.push(command);
      return tasks.refuse ?? { ok: true, task: taskResult.task };
    },
    async run(taskId: string): Promise<boolean> {
      tasks.ran.push(taskId);
      return tasks.known.has(taskId);
    },
  };
  return tasks;
}

test("task.create, task.update and task.run reach the task store as parsed commands, and answer 201, 200 and 202", async (t) => {
  const tasks = stubTasks();
  const { socket, handler } = await start(t, { tasks });
  const created = await post(socket, fixture("commands", "task-create.json"));
  assert.equal(created.status, 201);
  assert.deepEqual(TaskResultSchema.parse(created.json()), taskResult);
  const updated = await post(socket, fixture("commands", "task-update-schedule.json"));
  assert.equal(updated.status, 200);
  assert.deepEqual(TaskResultSchema.parse(updated.json()), taskResult);
  const ran = await post(socket, fixture("commands", "task-run.json"));
  assert.equal(ran.status, 202);
  assert.deepEqual(ran.json(), { accepted: true });

  assert.deepEqual(tasks.created, [parsedCommand("task-create.json")]);
  assert.deepEqual(tasks.updated, [parsedCommand("task-update-schedule.json")]);
  assert.deepEqual(tasks.ran, ["p3r8vx"]);
  assert.equal(handler.submitted.length, 0, "a task command never reaches the message path");
});

test("a task reply that is not ok answers its status and its error", async (t) => {
  const tasks = stubTasks();
  const { socket } = await start(t, { tasks });
  tasks.refuse = { ok: false, status: 400, error: "brief: must not be empty" };
  const created = await post(socket, fixture("commands", "task-create.json"));
  assert.equal(created.status, 400);
  assert.deepEqual(created.json(), { error: "brief: must not be empty" });

  tasks.refuse = { ok: false, status: 404, error: "no task p3r8vx" };
  const updated = await post(socket, fixture("commands", "task-update-schedule.json"));
  assert.equal(updated.status, 404);
  assert.deepEqual(updated.json(), { error: "no task p3r8vx" });
});

test("task.run answers 404 for a task the store does not have", async (t) => {
  const tasks = stubTasks();
  const { socket } = await start(t, { tasks });
  const reply = await post(socket, { type: "task.run", taskId: "zzzzzz" });
  assert.equal(reply.status, 404);
  assert.deepEqual(reply.json(), { error: "no task zzzzzz" });
  assert.deepEqual(tasks.ran, ["zzzzzz"]);
});

test("a task command that does not fit the schema gets 400 and never reaches the task store", async (t) => {
  const tasks = stubTasks();
  const { socket } = await start(t, { tasks });
  for (const bad of [
    { type: "task.update", taskId: "p3r8vx" },
    { type: "task.run", taskId: "p3r8vx", now: true },
    { type: "task.create", title: "", brief: "查价格", schedule: { kind: "daily", time: "09:00" } },
  ]) {
    assert.equal((await post(socket, bad)).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual(tasks.created, []);
  assert.deepEqual(tasks.updated, []);
  assert.deepEqual(tasks.ran, []);
});

// --- Document commands --------------------------------------------------------

const revisionAccepted = JSON.parse(fixture("responses", "revision-accepted.json")) as RevisionAccepted;
const documentResult = JSON.parse(fixture("responses", "document-result.json")) as DocumentResult;

/** Stands in for the documents service: records the commands it is given, and refuses with `refuse` when it is set. */
function stubDocuments() {
  const documents = {
    revised: [] as DocumentRevise[],
    undone: [] as DocumentUndo[],
    refuse: undefined as Extract<DocumentReply<unknown>, { ok: false }> | undefined,
    async revise(command: DocumentRevise): Promise<DocumentReply<RevisionAccepted>> {
      documents.revised.push(command);
      return documents.refuse ?? { ok: true, body: revisionAccepted };
    },
    async undo(command: DocumentUndo): Promise<DocumentReply<DocumentResult>> {
      documents.undone.push(command);
      return documents.refuse ?? { ok: true, body: documentResult };
    },
  };
  return documents;
}

test("each document command fixture gets 503 until documents are wired in, and never reaches the handler", async (t) => {
  const { socket, handler } = await start(t);
  for (const name of ["document-revise.json", "document-revise-document-comment.json", "document-undo.json"]) {
    const reply = await post(socket, fixture("commands", name));
    assert.equal(reply.status, 503, name);
    assert.deepEqual(reply.json(), { error: "documents are not available" }, name);
  }
  assert.equal(handler.submitted.length, 0, "a document command never reaches the message path");
});

test("document.revise and document.undo reach the documents service as parsed commands, and answer 202 and 200", async (t) => {
  const documents = stubDocuments();
  const { socket, handler } = await start(t, { documents });
  const revised = await post(socket, fixture("commands", "document-revise.json"));
  assert.equal(revised.status, 202);
  assert.deepEqual(revised.json(), revisionAccepted);
  const undone = await post(socket, fixture("commands", "document-undo.json"));
  assert.equal(undone.status, 200);
  assert.deepEqual(undone.json(), documentResult);

  assert.deepEqual(documents.revised, [parsedCommand("document-revise.json")]);
  assert.deepEqual(documents.undone, [parsedCommand("document-undo.json")]);
  assert.equal(handler.submitted.length, 0, "a document command never reaches the message path");
});

test("a document reply that is not ok answers its status and its error", async (t) => {
  const documents = stubDocuments();
  const { socket } = await start(t, { documents });
  documents.refuse = { ok: false, status: 409, error: "version: not the document's current version" };
  const revised = await post(socket, fixture("commands", "document-revise.json"));
  assert.equal(revised.status, 409);
  assert.deepEqual(revised.json(), { error: "version: not the document's current version" });

  documents.refuse = { ok: false, status: 404, error: "no document r4f7ma" };
  const undone = await post(socket, fixture("commands", "document-undo.json"));
  assert.equal(undone.status, 404);
  assert.deepEqual(undone.json(), { error: "no document r4f7ma" });

  documents.refuse = { ok: false, status: 400, error: "only Markdown and text documents take passage annotations" };
  const passage = await post(socket, fixture("commands", "document-revise.json"));
  assert.equal(passage.status, 400);
  assert.deepEqual(passage.json(), { error: "only Markdown and text documents take passage annotations" });
});

test("a documents service without undo takes document.revise and answers document.undo 503", async (t) => {
  const documents = stubDocuments();
  const { socket } = await start(t, { documents: { revise: (command) => documents.revise(command) } });
  assert.equal((await post(socket, fixture("commands", "document-revise.json"))).status, 202);
  const undone = await post(socket, fixture("commands", "document-undo.json"));
  assert.equal(undone.status, 503);
  assert.deepEqual(undone.json(), { error: "undo is not available" });
  assert.deepEqual(documents.undone, []);
});

test("a document command that does not fit the schema gets 400 and never reaches the documents service", async (t) => {
  const documents = stubDocuments();
  const { socket } = await start(t, { documents });
  for (const bad of [
    { type: "document.undo", documentId: "r4f7ma" },
    { type: "document.undo", documentId: "r4f7ma", runId: "x4n7mj", force: true },
    { type: "document.revise", documentId: "r4f7ma", version: "5d726c9ddcb2d6a8fad41e6213426bdeb94c6a", annotations: [{ target: { kind: "document" }, comment: "x" }] },
    { type: "document.revise", documentId: "r4f7ma", version: "5d726c9ddcb2d6a8fad41e6213426bdeb94c6acd", annotations: [] },
  ]) {
    assert.equal((await post(socket, bad)).status, 400, JSON.stringify(bad).slice(0, 80));
  }
  assert.deepEqual(documents.revised, []);
  assert.deepEqual(documents.undone, []);
});

// --- Rules commands -----------------------------------------------------------

const rulesBody = JSON.parse(fixture("responses", "rules.json")) as Rules;

/** Stands in for the rules service: records the commands it is given, and refuses with `refuse` when it is set. */
function stubRules() {
  const rules = {
    saved: [] as RulesSave[],
    refuse: undefined as Extract<RulesReply, { ok: false }> | undefined,
    async save(command: RulesSave): Promise<RulesReply> {
      rules.saved.push(command);
      return rules.refuse ?? { ok: true, body: rulesBody };
    },
  };
  return rules;
}

test("rules.save gets 503 until rules are wired in, and never reaches the handler", async (t) => {
  const { socket, handler } = await start(t);
  const reply = await post(socket, fixture("commands", "rules-save.json"));
  assert.equal(reply.status, 503);
  assert.deepEqual(reply.json(), { error: "rules are not available" });
  assert.equal(handler.submitted.length, 0, "a rules command never reaches the message path");
  assert.deepEqual(handler.stopped, []);
  assert.deepEqual(handler.answered, []);
});

test("rules.save reaches the rules service as the parsed command and answers 200 with its Rules", async (t) => {
  const rules = stubRules();
  const { socket, handler } = await start(t, { rules });
  const reply = await post(socket, fixture("commands", "rules-save.json"));
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.json(), rulesBody);
  assert.deepEqual(rules.saved, [parsedCommand("rules-save.json")]);
  assert.equal(handler.submitted.length, 0, "a rules command never reaches the message path");
});

test("a rules reply that is not ok answers its status and its error", async (t) => {
  const rules = stubRules();
  const { socket } = await start(t, { rules });
  rules.refuse = { ok: false, status: 409, error: "version: not the current version of ALFRED.md" };
  const stale = await post(socket, fixture("commands", "rules-save.json"));
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.json(), { error: "version: not the current version of ALFRED.md" });

  rules.refuse = { ok: false, status: 400, error: "text: over 8192 bytes" };
  const long = await post(socket, fixture("commands", "rules-save.json"));
  assert.equal(long.status, 400);
  assert.deepEqual(long.json(), { error: "text: over 8192 bytes" });
});

test("a rules.save that does not fit the schema gets 400 and never reaches the rules service", async (t) => {
  const rules = stubRules();
  const { socket } = await start(t, { rules });
  for (const name of ["rules-save-missing-version.json", "rules-save-extra-key.json"]) {
    assert.equal((await post(socket, fixture("invalid-commands", name))).status, 400, name);
  }
  assert.equal((await post(socket, { type: "rules.save", text: 5, version: "x" })).status, 400);
  assert.deepEqual(rules.saved, []);
});

test("the real rules service saves with the version it read, and refuses the old version with 409", async (t) => {
  const { rulesCommands } = await import("../agent/rules.ts");
  const { socket } = await start(t, { rules: rulesCommands({ workspace }) });
  const file = path.join(workspace, "ALFRED.md");
  fs.rmSync(file, { force: true });
  t.after(() => fs.rmSync(file, { force: true }));
  const sha256 = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

  const first = await post(socket, { type: "rules.save", text: "# one\n", version: sha256("") });
  assert.equal(first.status, 200);
  assert.deepEqual(first.json(), { text: "# one\n", version: sha256("# one\n"), maxBytes: 8192 });
  assert.equal(fs.readFileSync(file, "utf8"), "# one\n");

  const second = await post(socket, { type: "rules.save", text: "# two\n", version: sha256("") });
  assert.equal(second.status, 409);
  assert.equal(fs.readFileSync(file, "utf8"), "# one\n", "the stale save changed nothing");
  assert.equal((await post(socket, { type: "rules.save", text: "a\0b", version: sha256("# one\n") })).status, 400);
  assert.equal((await post(socket, { type: "rules.save", text: "a".repeat(8193), version: sha256("# one\n") })).status, 400);
  assert.equal((await post(socket, { type: "rules.save", text: "# two\n", version: sha256("# one\n") })).status, 200);
});

// --- Memory commands ----------------------------------------------------------

const memoryResult = JSON.parse(fixture("responses", "memory-result.json")) as MemoryResult;

/** Stands in for the memory service: records the commands it is given, and refuses with `refuse` when it is set. */
function stubMemory() {
  const memory = {
    calls: [] as (MemoryCreate | MemoryUpdate | MemoryDelete)[],
    refuse: undefined as Extract<MemoryReply<unknown>, { ok: false }> | undefined,
    async create(command: MemoryCreate): Promise<MemoryReply<MemoryResult>> {
      memory.calls.push(command);
      return memory.refuse ?? { ok: true, body: memoryResult };
    },
    async update(command: MemoryUpdate): Promise<MemoryReply<MemoryResult>> {
      memory.calls.push(command);
      return memory.refuse ?? { ok: true, body: memoryResult };
    },
    async delete(command: MemoryDelete): Promise<MemoryReply<{ deleted: true }>> {
      memory.calls.push(command);
      return memory.refuse ?? { ok: true, body: { deleted: true } };
    },
  };
  return memory;
}

const MEMORY_COMMAND_FIXTURES = ["memory-create.json", "memory-update.json", "memory-delete.json"];

test("the memory commands get 503 until memory is wired in, and never reach the handler", async (t) => {
  const { socket, handler } = await start(t);
  for (const name of MEMORY_COMMAND_FIXTURES) {
    const reply = await post(socket, fixture("commands", name));
    assert.equal(reply.status, 503, name);
    assert.deepEqual(reply.json(), { error: "memory is not available" }, name);
  }
  assert.equal(handler.submitted.length, 0, "a memory command never reaches the message path");
  assert.deepEqual(handler.stopped, []);
  assert.deepEqual(handler.answered, []);
});

test("memory.create answers 201 with a MemoryResult, memory.update 200 with one and memory.delete 200 with { deleted: true }", async (t) => {
  const memory = stubMemory();
  const { socket, handler } = await start(t, { memory });
  const created = await post(socket, fixture("commands", "memory-create.json"));
  assert.equal(created.status, 201);
  assert.deepEqual(created.json(), memoryResult);
  const updated = await post(socket, fixture("commands", "memory-update.json"));
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.json(), memoryResult);
  const deleted = await post(socket, fixture("commands", "memory-delete.json"));
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.json(), { deleted: true });

  assert.deepEqual(memory.calls, MEMORY_COMMAND_FIXTURES.map(parsedCommand), "each reached the memory service as the parsed command");
  assert.equal(handler.submitted.length, 0, "a memory command never reaches the message path");
});

test("a memory reply that is not ok answers its status and its error", async (t) => {
  const memory = stubMemory();
  const { socket } = await start(t, { memory });
  for (const [status, error] of [
    [404, "no memory prefer-short-answers.md"],
    [409, "version: not the current version of prefer-short-answers.md"],
    [409, "Alfred is tidying memory right now; try again shortly."],
    [400, "name: must be at most 80 characters"],
  ] as const) {
    memory.refuse = { ok: false, status, error };
    for (const name of MEMORY_COMMAND_FIXTURES) {
      const reply = await post(socket, fixture("commands", name));
      assert.equal(reply.status, status, name);
      assert.deepEqual(reply.json(), { error }, name);
    }
  }
});

test("a memory command that does not fit the schema gets 400 and never reaches the memory service", async (t) => {
  const memory = stubMemory();
  const { socket } = await start(t, { memory });
  const names = fs.readdirSync(new URL("../../fixtures/api/invalid-commands/", import.meta.url)).filter((name) => name.startsWith("memory-"));
  assert.ok(names.length >= 6, "a case for each rule: kind, name, version, file, one line and the extra key");
  for (const name of names) assert.equal((await post(socket, fixture("invalid-commands", name))).status, 400, name);
  assert.deepEqual(memory.calls, []);
});

test("the real memory service creates, updates and deletes through the API, and a stale version is 409", async (t) => {
  const { memoryCommands } = await import("../agent/memory-edit.ts");
  const { socket } = await start(t, {
    memory: memoryCommands({ withMemoryLock: async (job) => ({ locked: true, value: job() }) }, { workspace }),
  });
  const dir = path.join(workspace, "memory");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(path.join(workspace, ".trash"), { recursive: true, force: true });
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.join(workspace, ".trash"), { recursive: true, force: true });
  });
  const index = () => fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8");

  const created = await post(socket, { type: "memory.create", name: "Metric units", description: "Use kilometres.", kind: "preference", body: "Convert miles." });
  assert.equal(created.status, 201);
  const first = (created.json() as MemoryResult).memory;
  assert.deepEqual([first.file, first.name, first.kind, first.updated], ["metric-units.md", "Metric units", "preference", localDate()]);
  assert.match(index(), /\[Metric units\]\(metric-units\.md\) — Use kilometres\./);

  const edit = { type: "memory.update", file: first.file, version: first.version, name: "Metric", description: "", kind: "user", body: "Changed." };
  const updated = await post(socket, edit);
  assert.equal(updated.status, 200);
  const second = (updated.json() as MemoryResult).memory;
  assert.notEqual(second.version, first.version);
  assert.match(index(), /\[Metric\]\(metric-units\.md\)/);

  const stale = await post(socket, edit);
  assert.equal(stale.status, 409, "the old version");
  assert.match((stale.json() as { error: string }).error, /^version: /);
  assert.equal((await post(socket, { ...edit, file: "nothing.md" })).status, 404);

  const deleted = await post(socket, { type: "memory.delete", file: first.file, version: second.version });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.json(), { deleted: true });
  assert.ok(fs.existsSync(path.join(workspace, ".trash", "memory", "metric-units.md")));
  assert.doesNotMatch(index(), /metric-units\.md/);
  assert.equal((await post(socket, { type: "memory.delete", file: first.file, version: second.version })).status, 404);
});

// --- Idea commands ------------------------------------------------------------

const ideaAccepted = JSON.parse(fixture("responses", "idea-accepted.json")) as IdeaAccepted;
const ideaResult = JSON.parse(fixture("responses", "idea-result.json")) as IdeaResult;
const ideaGenerationAccepted = JSON.parse(fixture("responses", "idea-generation-accepted.json")) as IdeaGenerationAccepted;
const IDEA_COMMANDS = ["idea-accept-once.json", "idea-accept-recurring.json", "idea-reject.json", "idea-reject-no-note.json", "idea-generate.json"];

/** Stands in for the ideas service: records the commands it is given, and refuses with `refuse` when it is set. */
function stubIdeas() {
  const ideas = {
    accepted: [] as IdeaAccept[],
    rejected: [] as IdeaReject[],
    generated: [] as IdeaGenerate[],
    refuse: undefined as Extract<IdeaReply<unknown>, { ok: false }> | undefined,
    async accept(command: IdeaAccept): Promise<IdeaReply<IdeaAccepted>> {
      ideas.accepted.push(command);
      return ideas.refuse ?? { ok: true, body: ideaAccepted };
    },
    async reject(command: IdeaReject): Promise<IdeaReply<IdeaResult>> {
      ideas.rejected.push(command);
      return ideas.refuse ?? { ok: true, body: ideaResult };
    },
    async generate(command: IdeaGenerate): Promise<IdeaReply<IdeaGenerationAccepted>> {
      ideas.generated.push(command);
      return ideas.refuse ?? { ok: true, body: ideaGenerationAccepted };
    },
  };
  return ideas;
}

test("each idea command fixture gets 503 until ideas are wired in, and never reaches the handler", async (t) => {
  const { socket, handler } = await start(t);
  for (const name of IDEA_COMMANDS) {
    const reply = await post(socket, fixture("commands", name));
    assert.equal(reply.status, 503, name);
    assert.deepEqual(reply.json(), { error: "ideas are not available" }, name);
  }
  assert.equal(handler.submitted.length, 0, "an idea command never reaches the message path");
  assert.deepEqual(handler.stopped, []);
  assert.deepEqual(handler.answered, []);
});

test("each settings command fixture gets 503 until settings are wired in, and never reaches the handler", async (t) => {
  const { socket, handler } = await start(t);
  for (const name of ["settings-update.json", "settings-update-ideas-off.json", "settings-update-reset-all.json"]) {
    const reply = await post(socket, fixture("commands", name));
    assert.equal(reply.status, 503, name);
    assert.deepEqual(reply.json(), { error: "settings are not available" }, name);
  }
  assert.equal(handler.submitted.length, 0, "a settings command never reaches the message path");
  assert.deepEqual(handler.stopped, []);
  assert.deepEqual(handler.answered, []);
});

/** Stands in for the settings service: records the commands it is given, and answers the fixture's settings or `refuse`. */
function stubSettings() {
  const answer = JSON.parse(fixture("responses", "settings-result.json")) as SettingsResult;
  const settings = {
    updated: [] as SettingsUpdate[],
    refuse: undefined as SettingsReply | undefined,
    answer,
    update(command: SettingsUpdate): SettingsReply {
      settings.updated.push(command);
      return settings.refuse ?? { ok: true, settings: answer.settings };
    },
  };
  return settings;
}

test("settings.update reaches the settings service as a parsed command and answers 200 with a SettingsResult", async (t) => {
  const settings = stubSettings();
  const { socket, handler } = await start(t, { settings });
  for (const name of ["settings-update.json", "settings-update-ideas-off.json", "settings-update-reset-all.json"]) {
    const reply = await post(socket, fixture("commands", name));
    assert.equal(reply.status, 200, name);
    assert.deepEqual(reply.json(), settings.answer, name);
    assert.equal(SettingsResultSchema.safeParse(reply.json()).success, true, name);
  }
  assert.deepEqual(settings.updated, [
    parsedCommand("settings-update.json"),
    parsedCommand("settings-update-ideas-off.json"),
    parsedCommand("settings-update-reset-all.json"),
  ]);
  assert.equal(handler.submitted.length, 0, "a settings command never reaches the message path");
  assert.deepEqual(handler.stopped, []);
  assert.deepEqual(handler.answered, []);
});

test("a settings change the service refuses is answered with its status and reason", async (t) => {
  const settings = stubSettings();
  const { socket } = await start(t, { settings });
  settings.refuse = { ok: false, status: 400, error: "dailyBudgetUsd: must be at most 100" };
  const reply = await post(socket, fixture("commands", "settings-update.json"));
  assert.equal(reply.status, 400);
  assert.deepEqual(reply.json(), { error: "dailyBudgetUsd: must be at most 100" });
});

test("a settings command that fails the contract's ranges never reaches the settings service", async (t) => {
  const settings = stubSettings();
  const { socket } = await start(t, { settings });
  const reply = await post(socket, fixture("invalid-commands", "settings-update-daily-101.json"));
  assert.equal(reply.status, 400);
  assert.deepEqual(settings.updated, []);
});

test("idea.accept, idea.reject and idea.generate reach the ideas service as parsed commands, and answer 200, 200 and 202", async (t) => {
  const ideas = stubIdeas();
  const { socket, handler } = await start(t, { ideas });
  const accepted = await post(socket, fixture("commands", "idea-accept-once.json"));
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.json(), ideaAccepted);
  const recurring = await post(socket, fixture("commands", "idea-accept-recurring.json"));
  assert.equal(recurring.status, 200);
  const rejected = await post(socket, fixture("commands", "idea-reject.json"));
  assert.equal(rejected.status, 200);
  assert.deepEqual(rejected.json(), ideaResult);
  const generated = await post(socket, fixture("commands", "idea-generate.json"));
  assert.equal(generated.status, 202);
  assert.deepEqual(generated.json(), ideaGenerationAccepted);

  assert.deepEqual(ideas.accepted, [parsedCommand("idea-accept-once.json"), parsedCommand("idea-accept-recurring.json")]);
  assert.deepEqual(ideas.rejected, [parsedCommand("idea-reject.json")]);
  assert.deepEqual(ideas.generated, [parsedCommand("idea-generate.json")]);
  assert.equal(handler.submitted.length, 0, "an idea command never reaches the message path");
});

test("an idea reply that is not ok answers its status and its error", async (t) => {
  const ideas = stubIdeas();
  const { socket } = await start(t, { ideas });
  ideas.refuse = { ok: false, status: 404, error: "no idea h3v8ct" };
  const accepted = await post(socket, fixture("commands", "idea-accept-once.json"));
  assert.equal(accepted.status, 404);
  assert.deepEqual(accepted.json(), { error: "no idea h3v8ct" });

  ideas.refuse = { ok: false, status: 409, error: "idea m7x2zd is not open" };
  const rejected = await post(socket, fixture("commands", "idea-reject.json"));
  assert.equal(rejected.status, 409);
  assert.deepEqual(rejected.json(), { error: "idea m7x2zd is not open" });

  ideas.refuse = { ok: false, status: 409, error: "a generation is already queued or running" };
  const generated = await post(socket, fixture("commands", "idea-generate.json"));
  assert.equal(generated.status, 409);
  assert.deepEqual(generated.json(), { error: "a generation is already queued or running" });
});

test("an idea command that does not fit the schema gets 400 and never reaches the ideas service", async (t) => {
  const ideas = stubIdeas();
  const { socket } = await start(t, { ideas });
  for (const bad of [
    { type: "idea.accept", ideaId: "h3v8ct", title: "对比三家 VPS 的带宽配额", brief: "查带宽。", model: "sonnet" },
    { type: "idea.reject", ideaId: "m7x2zd", reason: "bored" },
    { type: "idea.reject", ideaId: "m7x2zd", reason: "not-now", note: "   " },
    { type: "idea.generate", ideaId: "h3v8ct" },
  ]) {
    assert.equal((await post(socket, bad)).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual(ideas.accepted, []);
  assert.deepEqual(ideas.rejected, []);
  assert.deepEqual(ideas.generated, []);
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
  assert.ok(sse.text().startsWith(`: ping\n\nid: 1\nevent: run.updated\ndata: ${JSON.stringify(first)}\n\n`), "the whole event on one line, after the opening ping");
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

/** The frame that ends a backlog, as it is on the wire. */
const CAUGHT_UP = "event: caught-up\ndata: {}\n\n";
const markers = (text: string) => text.split(CAUGHT_UP).length - 1;

test("the backlog ends with a caught-up frame that has no id, before the first live event", async (t) => {
  const { socket, events } = await start(t);
  appendRuns(events, 2);
  const sse = await open(t, socket);
  await until("the marker", () => markers(sse.text()) === 1);
  const last = events.readSince(1, 1)[0];
  assert.ok(sse.text().endsWith(`id: 2\nevent: run.updated\ndata: ${JSON.stringify(last)}\n\n${CAUGHT_UP}`), "right after the last backlog event, and nothing after it yet");
  assert.deepEqual(sse.ids(), [1, 2], "the marker has no id line");

  const live = events.append("run.updated", run);
  await until("the live event", () => sse.ids().length === 3);
  assert.ok(sse.text().endsWith(`id: 3\nevent: run.updated\ndata: ${JSON.stringify(live)}\n\n`));
  assert.equal(markers(sse.text()), 1, "once per stream");
  assert.ok(sse.text().indexOf(CAUGHT_UP) < sse.text().indexOf("id: 3"));
});

test("a stream with nothing to catch up on gets the ping and then the marker, also when it resumes at the end", async (t) => {
  const { socket, events } = await start(t, { heartbeatMs: 60_000 });
  const empty = await open(t, socket);
  await until("the marker", () => empty.text() === `: ping\n\n${CAUGHT_UP}`);

  appendRuns(events, 3);
  const atEnd = await open(t, socket, "/events", { "Last-Event-ID": "3" });
  await until("the marker", () => atEnd.text() === `: ping\n\n${CAUGHT_UP}`);
  assert.deepEqual(atEnd.ids(), []);
});

test("a backlog of several pages gets the marker only after the last page", async (t) => {
  const { socket, events } = await start(t, { pageSize: 2 });
  appendRuns(events, 5);
  events.onRead = () => {}; // reads are counted only while a hook is set
  const sse = await open(t, socket);
  await until("the marker", () => markers(sse.text()) === 1);
  assert.deepEqual(sse.ids(), [1, 2, 3, 4, 5], "every page came first");
  assert.ok(sse.text().endsWith(CAUGHT_UP));
  assert.equal(events.reads, 3, "three pages of two");

  // A stream that resumes mid-log gets its own marker, after its own last page.
  const exact = await open(t, socket, "/events?after=1");
  await until("the marker", () => markers(exact.text()) === 1);
  assert.deepEqual(exact.ids(), [2, 3, 4, 5]);
  assert.ok(exact.text().endsWith(CAUGHT_UP));
});

test("events that arrive while the backlog is read come before the marker", async (t) => {
  const { socket, events } = await start(t, { pageSize: 2 });
  appendRuns(events, 3);
  events.onRead = (read) => {
    if (read <= 2) events.append("run.updated", run);
  };
  const sse = await open(t, socket);
  await until("the marker", () => markers(sse.text()) === 1);
  events.onRead = undefined;
  assert.deepEqual(sse.ids(), [1, 2, 3, 4, 5]);
  assert.ok(sse.text().endsWith(CAUGHT_UP), "buffered events are part of the backlog");
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

test("a stream pings as it opens, so a client with nothing to catch up on gets a byte at once", async (t) => {
  const { socket } = await start(t, { heartbeatMs: 60_000 });
  const sse = await open(t, socket);
  await until("the opening ping", () => sse.text().startsWith(": ping\n\n"));
});

test("a ping goes out on the heartbeat interval, which is 30 s by default", async (t) => {
  assert.equal(HEARTBEAT_MS, 30_000);
  const { socket } = await start(t, { heartbeatMs: 20 });
  const sse = await open(t, socket);
  await until("three pings", () => sse.text().split(": ping\n\n").length > 3);
  assert.equal(sse.text().replaceAll(": ping\n\n", ""), CAUGHT_UP, "only pings and the one marker, as there are no events");
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

const delta = (text: string) => ({ runId: "k7m2qa", streamId: "msg_01.0", text });

test("a live event goes out as a frame with an event and a data line and no id line", async (t) => {
  const { socket, events } = await start(t);
  appendRuns(events, 1);
  const sse = await open(t, socket);
  await until("the backlog", () => sse.ids().length === 1);

  const live = events.publish("message.delta", delta("你好"));
  assert.ok(live);
  await until("the live event", () => sse.text().includes("event: message.delta"));
  assert.ok(sse.text().endsWith(`event: message.delta\ndata: ${JSON.stringify(live)}\n\n`), "the whole live event on one line");
  assert.deepEqual(sse.ids(), [1], "the live event has no id line");
  assert.equal((sse.text().match(/^id: /gm) ?? []).length, 1);

  events.publish("run.step", { runId: "k7m2qa", step: { at: "2026-10-25T08:31:02.000Z", tool: "WebFetch", detail: "https://example.com/pricing" } });
  appendRuns(events, 1);
  await until("the next durable event", () => sse.ids().length === 2);
  assert.deepEqual(sse.ids(), [1, 2], "ids go on as if the live events had not been there");
  assert.deepEqual(
    [...sse.text().matchAll(/^event: (.+)$/gm)].map((m) => m[1]),
    ["run.updated", "caught-up", "message.delta", "run.step", "run.updated"],
    "in the order they happened, the marker after the backlog",
  );
});

test("a live event published while a stream is still sending its backlog is dropped for that stream, not buffered", async (t) => {
  const { socket, events } = await start(t, { pageSize: 2 });
  appendRuns(events, 5);
  let published = 0;
  events.onRead = () => {
    published++;
    events.publish("message.delta", delta(`during ${published}`));
  };
  const sse = await open(t, socket);
  await until("the backlog", () => sse.ids().length === 5);

  events.onRead = undefined;
  assert.equal(published, 3, "events were published during the three pages of the backlog");
  events.publish("message.delta", delta("after"));
  await until("the live event after the backlog", () => sse.text().includes("event: message.delta"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((sse.text().match(/^event: message\.delta$/gm) ?? []).length, 1, "only the one that came after the backlog");
  assert.match(sse.text(), /"text":"after"/);
  assert.doesNotMatch(sse.text(), /during/);
  assert.deepEqual(sse.ids(), [1, 2, 3, 4, 5]);
});

test("a stream resumed with Last-Event-ID or ?after never replays live events", async (t) => {
  const { socket, events } = await start(t);
  appendRuns(events, 2);
  events.publish("message.delta", delta("before the third"));
  appendRuns(events, 1);
  events.publish("run.step", { runId: "k7m2qa", step: { at: "2026-10-25T08:31:02.000Z", tool: "Read", detail: "notes/a.md" } });
  appendRuns(events, 1);

  const byHeader = await open(t, socket, "/events", { "Last-Event-ID": "1" });
  await until("events 2 to 4", () => byHeader.ids().length === 3);
  const everything = await open(t, socket);
  await until("everything", () => everything.ids().length === 4);
  const byQuery = await open(t, socket, "/events?after=0");
  await until("everything by query", () => byQuery.ids().length === 4);
  await new Promise((resolve) => setTimeout(resolve, 50));

  for (const sse of [byHeader, everything, byQuery]) {
    assert.doesNotMatch(sse.text(), /message\.delta|run\.step/, "live events are not in the log, so they are not in a backlog");
  }
  assert.deepEqual(byHeader.ids(), [2, 3, 4]);
});

const inbox = () => path.join(workspace, "inbox", localDate());
/** The names in today's inbox; none before the first upload. */
const inboxNames = (): string[] => (fs.existsSync(inbox()) ? fs.readdirSync(inbox()) : []);
const upload = (socket: string, name: string, body: Buffer | string = "x") =>
  call(socket, "POST", `/uploads?name=${encodeURIComponent(name)}`, { headers: { "Content-Type": "application/octet-stream" }, body });

test("POST /uploads saves the bytes under today's inbox and answers 201 with the path and kind", async (t) => {
  const { socket } = await start(t);
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const reply = await upload(socket, "Screen Shot.PNG", bytes);
  assert.equal(reply.status, 201);
  assert.deepEqual(reply.json(), { file: { path: `inbox/${localDate()}/Screen Shot.PNG`, kind: "image" } });
  assert.deepEqual(fs.readFileSync(path.join(inbox(), "Screen Shot.PNG")), bytes);
  assert.deepEqual(
    inboxNames().filter((n) => n.startsWith(".upload-")),
    [],
    "nothing is left under a temporary name",
  );
});

test("the kind of an upload follows its extension: image, video or file", async (t) => {
  const { socket } = await start(t);
  const kinds: [string, string][] = [
    ["kind-a.png", "image"],
    ["kind-b.JPG", "image"],
    ["kind-c.jpeg", "image"],
    ["kind-d.gif", "image"],
    ["kind-e.webp", "image"],
    ["kind-f.heic", "image"],
    ["kind-g.mp4", "video"],
    ["kind-h.MOV", "video"],
    ["kind-i.pdf", "file"],
    ["kind-j.md", "file"],
    ["kind-k", "file"],
  ];
  for (const [name, kind] of kinds) {
    const reply = await upload(socket, name);
    assert.equal(reply.status, 201, name);
    assert.deepEqual(reply.json(), { file: { path: `inbox/${localDate()}/${name}`, kind } }, name);
  }
});

test("a name that is already in the inbox gets a unique path, and the first file is kept", async (t) => {
  const { socket } = await start(t);
  assert.equal((await upload(socket, "same-name.txt", "first")).status, 201);
  const second = await upload(socket, "same-name.txt", "second");
  assert.deepEqual(second.json(), { file: { path: `inbox/${localDate()}/same-name-1.txt`, kind: "file" } });
  assert.equal(fs.readFileSync(path.join(inbox(), "same-name.txt"), "utf8"), "first");
  assert.equal(fs.readFileSync(path.join(inbox(), "same-name-1.txt"), "utf8"), "second");
});

test("the name is trimmed and sanitized", async (t) => {
  const { socket } = await start(t);
  const trimmed = await call(socket, "POST", `/uploads?name=${encodeURIComponent("  spaced.txt  ")}`, { body: "x" });
  assert.deepEqual(trimmed.json(), { file: { path: `inbox/${localDate()}/spaced.txt`, kind: "file" } });
  const unsafe = await upload(socket, "a:b?.txt");
  assert.deepEqual(unsafe.json(), { file: { path: `inbox/${localDate()}/a_b_.txt`, kind: "file" } });
  const longest = await upload(socket, "y".repeat(255));
  assert.equal(longest.status, 201, "255 characters is the most a name can have");
});

test("a name over the file system's 255 bytes is cut, keeps its extension and leaves no temporary file", async (t) => {
  const { socket } = await start(t);
  const reply = await upload(socket, `${"报".repeat(90)}.pdf`);
  assert.equal(reply.status, 201);
  const { file } = reply.json() as { file: { path: string; kind: string } };
  assert.equal(path.extname(file.path), ".pdf");
  assert.ok(Buffer.byteLength(path.basename(file.path)) <= 255);
  assert.deepEqual(
    inboxNames().filter((n) => n.startsWith(".upload-")),
    [],
  );
});

test("a name that is missing, empty, unsafe or too long gets 400 and nothing is saved", async (t) => {
  const { socket } = await start(t);
  const before = inboxNames();
  for (const target of [
    "/uploads",
    "/uploads?name=",
    "/uploads?name=%20%20",
    "/uploads?name=a%2Fb",
    "/uploads?name=a%5Cb",
    "/uploads?name=.",
    "/uploads?name=..",
    "/uploads?name=%2E%2E",
    "/uploads?name=a%00b",
    `/uploads?name=${"z".repeat(256)}`,
  ]) {
    const reply = await call(socket, "POST", target, { headers: { "Content-Type": "application/octet-stream" }, body: "x" });
    assert.equal(reply.status, 400, target);
    assert.deepEqual(Object.keys(reply.json() as object), ["error"], target);
  }
  assert.deepEqual(inboxNames(), before);
});

test("a declared length over the limit is 413 before the body is read, and nothing is saved", async (t) => {
  const { socket } = await start(t);
  const before = inboxNames();
  // Only a little of the body is sent: the answer comes without the rest.
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request(
      {
        socketPath: socket,
        method: "POST",
        path: "/uploads?name=declared.bin",
        headers: { "Content-Type": "application/octet-stream", "Content-Length": MAX_UPLOAD_BYTES + 1 },
        agent: false,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
        req.destroy();
      },
    );
    req.on("error", () => {});
    setTimeout(() => reject(new Error("no answer before the body was sent")), 5000).unref();
    req.write("only a little");
  });
  assert.equal(status, 413);
  assert.deepEqual(inboxNames(), before);
});

test("a body that grows past the limit is cut with 413, and no file is left", async (t) => {
  const { socket } = await start(t);
  const before = inboxNames();
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  // A connection that stays open, as a client's does: a closed one would drop the 413 with the unread body.
  const agent = new http.Agent({ keepAlive: true });
  t.after(() => agent.destroy());
  const status = await new Promise<number>((resolve, reject) => {
    let answered = false;
    const req = http.request(
      { socketPath: socket, method: "POST", path: "/uploads?name=grows.bin", headers: { "Content-Type": "application/octet-stream" }, agent },
      (res) => {
        answered = true;
        res.resume();
        resolve(res.statusCode ?? 0);
        req.destroy();
      },
    );
    req.on("error", (err) => {
      if (!answered) reject(err);
    });
    setTimeout(() => reject(new Error("no answer while the body was still being sent")), 10_000).unref();
    void (async () => {
      // 60 MiB is over the 50 MiB limit: the answer must come before all of it is sent.
      for (let i = 0; i < 60 && !answered; i++) {
        if (!req.write(chunk) && !answered) await new Promise((next) => req.once("drain", next));
      }
    })();
  });
  assert.equal(status, 413);
  assert.deepEqual(inboxNames(), before);
});

test("an upload cut short by the client leaves no file", async (t) => {
  const { socket } = await start(t);
  const before = inboxNames();
  const req = http.request({
    socketPath: socket,
    method: "POST",
    path: "/uploads?name=cut-short.bin",
    headers: { "Content-Type": "application/octet-stream", "Content-Length": 1000 },
    agent: false,
  });
  req.on("error", () => {});
  req.write(Buffer.alloc(100, 1));
  await until("the upload to start", () => inboxNames().some((n) => n.startsWith(".upload-")));
  req.destroy();
  await until("the partial file to go", () => inboxNames().every((n) => before.includes(n)));
  assert.equal(inboxNames().includes("cut-short.bin"), false);
});

test("other methods on /uploads get 405 with POST allowed", async (t) => {
  const { socket, handler } = await start(t);
  const reply = await call(socket, "GET", "/uploads?name=x.txt");
  assert.equal(reply.status, 405);
  assert.equal(reply.headers.allow, "POST");
  assert.equal(handler.submitted.length, 0);
});

test("message.send with files hands them to the handler with the message, and an answer of 202", async (t) => {
  const { socket, handler } = await start(t);
  const saved = (await upload(socket, "for-message.txt", "hi")).json() as { file: { path: string } };
  const reply = await post(socket, { type: "message.send", clientId: "c-files", text: "看看这个", files: [{ path: saved.file.path }] });
  assert.equal(reply.status, 202);
  assert.deepEqual(handler.submitted, [{ text: "看看这个", clientId: "c-files", files: [{ path: saved.file.path }] }]);

  // Files with no text, and a kind that goes along with a path.
  const kinded = await post(socket, { type: "message.send", clientId: "c-files-2", text: "", files: [{ path: saved.file.path, kind: "file" }] });
  assert.equal(kinded.status, 202);
  assert.deepEqual(handler.submitted.at(-1), { text: "", clientId: "c-files-2", files: [{ path: saved.file.path, kind: "file" }] });
});

test("a file of a message that is not a regular file in the inbox gets 400, and nothing is submitted", async (t) => {
  const { socket, handler } = await start(t);
  const real = (await upload(socket, "real.txt", "hi")).json() as { file: { path: string } };
  fs.mkdirSync(inbox(), { recursive: true });
  const outside = path.join(tmp, "outside.txt");
  fs.writeFileSync(outside, "outside the workspace");
  fs.mkdirSync(path.join(workspace, "reports"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "reports", "memo.md"), "not in the inbox");
  fs.mkdirSync(path.join(inbox(), "a-folder"), { recursive: true });
  fs.symlinkSync(outside, path.join(inbox(), "escape-link.txt"));
  fs.symlinkSync(path.join(workspace, "reports", "memo.md"), path.join(inbox(), "memo-link.md"));
  fs.symlinkSync(real.file.path.replace(/^inbox\//, path.join(workspace, "inbox") + path.sep), path.join(inbox(), "alias.txt"));

  const cases: [string, string][] = [
    [`inbox/${localDate()}/never-uploaded.txt`, "files.0.path: no such file in the inbox"],
    [`inbox/${localDate()}/a-folder`, "files.0.path: no such file in the inbox"],
    [`inbox/${localDate()}/escape-link.txt`, "files.0.path: no such file in the inbox"],
    [`inbox/${localDate()}/memo-link.md`, "files.0.path: no such file in the inbox"],
    ["reports/memo.md", "files.0.path: must start with inbox/"],
  ];
  for (const [i, [file, error]] of cases.entries()) {
    const reply = await post(socket, { type: "message.send", clientId: `bad-${i}`, text: "x", files: [{ path: file }] });
    assert.equal(reply.status, 400, file);
    assert.deepEqual(reply.json(), { error }, file);
  }
  // With a good file first, the bad one is named by its place in the list.
  const second = await post(socket, { type: "message.send", clientId: "bad-second", text: "x", files: [{ path: real.file.path }, { path: `inbox/${localDate()}/none.txt` }] });
  assert.deepEqual(second.json(), { error: "files.1.path: no such file in the inbox" });
  assert.equal(handler.submitted.length, 0);

  // A symlink in the inbox to another file of the inbox is that file.
  const alias = `inbox/${localDate()}/alias.txt`;
  assert.equal((await post(socket, { type: "message.send", clientId: "alias", text: "x", files: [{ path: alias }] })).status, 202);
});
