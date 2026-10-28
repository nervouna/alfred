// The command API: the owner's commands in, Alfred's events out, over a Unix
// socket (no TCP listener). A process on the same host posts message.send,
// run.stop, question.answer, the task, document, idea, rules, memory and settings commands to /commands, uploads files to /uploads
// (into the workspace's inbox, for a message to name) and follows /events as server-sent
// events, resuming by event id. Every command is validated here by parseCommand.
// Live events (reply text as it is written, the steps of a run) go out as frames
// without an id and are never replayed.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { resolveInside } from "../agent/guard.ts";
import { InvalidAnswer } from "../channels.ts";
import type { Intake } from "../channels.ts";
import { type EventLog, isLiveEvent } from "../events.ts";
import { localDate, localTime, sanitizeFileName, uniquePath } from "../files.ts";
import { describeError, log } from "../log.ts";
import { STATE_DIR, WORKSPACE_DIR } from "../store.ts";
import { MAX_COMMAND_BYTES, MAX_UPLOAD_BYTES, parseCommand } from "./schema.ts";
import type {
  DocumentResult,
  DocumentRevise,
  DocumentUndo,
  Event,
  IdeaAccept,
  IdeaAccepted,
  IdeaGenerate,
  IdeaGenerationAccepted,
  IdeaReject,
  IdeaResult,
  LiveEvent,
  MemoryCreate,
  MemoryDelete,
  MemoryResult,
  MemoryUpdate,
  RevisionAccepted,
  Rules,
  RulesSave,
  Settings,
  SettingsUpdate,
  Task,
  TaskCreate,
  TaskUpdate,
  UploadResult,
} from "./schema.ts";

/** How often an event stream gets a `: ping` comment. */
export const HEARTBEAT_MS = 30_000;
const PING = ": ping\n\n";
/** Events per page when a stream sends its backlog. */
const BACKLOG_PAGE = 200;
/** A client that lets this much pile up unread is dropped; it resumes by id when it reconnects. */
const MAX_UNREAD_BYTES = 8 * 1024 * 1024;
/** How many accepted client ids are remembered for the duplicate check. */
const REMEMBERED_CLIENT_IDS = 1000;
/** On close, how long a request in flight gets before its connection is cut. */
const CLOSE_GRACE_MS = 2000;
/** The longest file name an upload may ask for, in characters. */
const MAX_NAME_CHARS = 255;
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic"]);
const VIDEO_EXTS = new Set([".mp4", ".mov"]);

/** The part of the event log the API reads. */
export type ApiEvents = Pick<EventLog, "lastId" | "readSince" | "subscribe">;

/** A task command's answer: the task as the store now holds it, or the status and the reason it was refused. */
export type TaskReply = { ok: true; task: Task } | { ok: false; status: 400 | 404; error: string };

export interface TaskCommands {
  create(command: TaskCreate): TaskReply | Promise<TaskReply>;
  update(command: TaskUpdate): TaskReply | Promise<TaskReply>;
  /** Starts a run of the task now, or queues it; false when there is no such task. */
  run(taskId: string): boolean | Promise<boolean>;
}

/** A document command's answer: the body to send, or the status and the reason it was refused. */
export type DocumentReply<T> = { ok: true; body: T } | { ok: false; status: 400 | 404 | 409 | 500; error: string };

export interface DocumentCommands {
  /** Starts a revision run that takes the batch, or refuses it. */
  revise(command: DocumentRevise): DocumentReply<RevisionAccepted> | Promise<DocumentReply<RevisionAccepted>>;
  /** Undoes the document's latest revision, or refuses it. Without it every document.undo answers 503. */
  undo?(command: DocumentUndo): DocumentReply<DocumentResult> | Promise<DocumentReply<DocumentResult>>;
}

/** An idea command's answer: the body to send, or the status and the reason it was refused. */
export type IdeaReply<T> = { ok: true; body: T } | { ok: false; status: 400 | 404 | 409 | 500 | 503; error: string };

export interface IdeaCommands {
  /** Accepts an idea as a task, or refuses it. */
  accept(command: IdeaAccept): IdeaReply<IdeaAccepted> | Promise<IdeaReply<IdeaAccepted>>;
  /** Rejects an idea with its reason, or refuses it. */
  reject(command: IdeaReject): IdeaReply<IdeaResult> | Promise<IdeaReply<IdeaResult>>;
  /** Starts a generation run of ideas, or refuses it. */
  generate(command: IdeaGenerate): IdeaReply<IdeaGenerationAccepted> | Promise<IdeaReply<IdeaGenerationAccepted>>;
}

/** A rules command's answer: the Rules as the file now holds them, or the status and the reason the save was refused. */
export type RulesReply = { ok: true; body: Rules } | { ok: false; status: 400 | 409; error: string };

export interface RulesCommands {
  /** Replaces the root ALFRED.md with the text, or refuses the save. */
  save(command: RulesSave): RulesReply | Promise<RulesReply>;
}

/** A memory command's answer: the body to send, or the status and the reason the command was refused. */
export type MemoryReply<T> = { ok: true; body: T } | { ok: false; status: 400 | 404 | 409; error: string };

export interface MemoryCommands {
  /** Adds a memory, or refuses it. */
  create(command: MemoryCreate): MemoryReply<MemoryResult> | Promise<MemoryReply<MemoryResult>>;
  /** Replaces a memory's fields, or refuses the update. */
  update(command: MemoryUpdate): MemoryReply<MemoryResult> | Promise<MemoryReply<MemoryResult>>;
  /** Moves a memory's file into .trash/memory/, or refuses the delete. */
  delete(command: MemoryDelete): MemoryReply<{ deleted: true }> | Promise<MemoryReply<{ deleted: true }>>;
}

/** A settings command's answer: the settings as they now are, or the status and the reason it was refused. */
export type SettingsReply = { ok: true; settings: Settings } | { ok: false; status: 400; error: string };

export interface SettingsCommands {
  /** Changes the settings and answers with the whole of them, or refuses the change. */
  update(command: SettingsUpdate): SettingsReply | Promise<SettingsReply>;
}

export interface ApiOptions {
  /** Path of the Unix socket. */
  socket: string;
  /** Where commands go: the agent handler's intake. */
  handler: Intake;
  events: ApiEvents;
  /** Where task commands go, once the task store is wired in; without it every task command answers 503. */
  tasks?: TaskCommands;
  /** Where document commands go, once the document store is wired in; without it every document command answers 503. */
  documents?: DocumentCommands;
  /** Where idea commands go, once the idea store is wired in; without it every idea command answers 503. */
  ideas?: IdeaCommands;
  /** Where rules commands go, once the rules service is wired in; without it every rules command answers 503. */
  rules?: RulesCommands;
  /** Where memory commands go, once the memory service is wired in; without it every memory command answers 503. */
  memory?: MemoryCommands;
  /** Where settings commands go, once the settings store is wired in; without it every settings command answers 503. */
  settings?: SettingsCommands;
  /** Interval between pings on an event stream; 30 s by default. */
  heartbeatMs?: number;
  /** Events read per page of a stream's backlog. */
  pageSize?: number;
}

/** The socket from ALFRED_API_SOCKET, `<STATE_DIR>/api/alfred.sock` when unset; undefined when it is "off". */
export function apiSocketPath(): string | undefined {
  const setting = process.env.ALFRED_API_SOCKET?.trim() || path.join(STATE_DIR, "api", "alfred.sock");
  return setting === "off" ? undefined : path.resolve(setting);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: http.OutgoingHttpHeaders = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(text), ...headers });
  res.end(text);
}

function methodNotAllowed(res: http.ServerResponse, allow: string): void {
  sendJson(res, 405, { error: `method not allowed, use ${allow}` }, { Allow: allow });
}

function isJson(contentType: string | undefined): boolean {
  return contentType?.split(";")[0]?.trim().toLowerCase() === "application/json";
}

/** The request body as text; undefined as soon as it is known to be over the limit, with the rest left unread. */
function readBody(req: http.IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"]) > MAX_COMMAND_BYTES) return resolve(undefined);
    const chunks: Buffer[] = [];
    let size = 0;
    // Over the limit, the data listener comes off and what is left is dropped by the caller as it arrives
    // (the request is neither destroyed nor buffered: the 413 still has to go out on its connection).
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_COMMAND_BYTES) return void chunks.push(chunk);
      chunks.length = 0;
      req.off("data", onData);
      resolve(undefined);
    };
    req.on("data", onData);
    req.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.once("close", () => reject(new Error("the request was cut short")));
  });
}

/** One SSE frame: the whole event on one line of JSON. A live event has no id line, so a client's last id stays that of the last durable event. */
function frame(event: Event | LiveEvent): string {
  const id = isLiveEvent(event) ? "" : `id: ${event.id}\n`;
  return `${id}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** An id from a header or a query: a non-negative integer. */
function parseId(raw: string): number | undefined {
  const id = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(id) ? id : undefined;
}

/** The file name an upload asks for, trimmed; undefined unless it is 1 to 255 characters, with no /, \ or NUL, and not . or .. */
function uploadName(raw: string | null): string | undefined {
  const name = raw?.trim() ?? "";
  if (!name || [...name].length > MAX_NAME_CHARS || /[/\\\0]/.test(name) || name === "." || name === "..") return undefined;
  return name;
}

/** The kind an upload is shown as, from its extension. */
function uploadKind(fileName: string): UploadResult["file"]["kind"] {
  const ext = path.extname(fileName).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return "image";
  return VIDEO_EXTS.has(ext) ? "video" : "file";
}

/** Whether `rel` is a regular file inside the workspace's inbox, following symlinks: what a message may attach. */
function inboxFile(rel: string): boolean {
  const real = resolveInside(WORKSPACE_DIR, rel);
  if (!real) return false;
  const inbox = path.join(fs.realpathSync(WORKSPACE_DIR), "inbox") + path.sep;
  try {
    return real.startsWith(inbox) && fs.statSync(real).isFile();
  } catch {
    return false;
  }
}

/**
 * Writes the request body to `file` as it arrives. Resolves to the bytes written, or to "too-large" when the body
 * grows past MAX_UPLOAD_BYTES, or to "cut-short" when the client goes away first. Then `file` is gone: nothing
 * is kept of an upload that did not complete. The request is not destroyed on "too-large": what is still sent
 * is read and dropped, so the 413 can go out on its connection.
 */
function receiveUpload(req: http.IncomingMessage, file: string): Promise<number | "too-large" | "cut-short"> {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file, { flags: "wx", mode: 0o600 });
    let size = 0;
    let ended = false;
    let stopped: "too-large" | "cut-short" | undefined;
    let failure: unknown;
    const stop = (why: "too-large" | "cut-short") => {
      stopped = why;
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("close", onClose);
      out.destroy();
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) return stop("too-large");
      if (!out.write(chunk)) {
        req.pause();
        out.once("drain", () => req.resume());
      }
    };
    const onEnd = () => {
      ended = true;
      out.end();
    };
    const onClose = () => {
      if (!ended) stop("cut-short");
    };
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("close", onClose);
    out.on("error", (err) => {
      // Writes still buffered when the upload is stopped fail with the destroyed stream: that is no failure.
      if (stopped === undefined) failure = err;
    });
    // Closed once the file is complete, or at once when it is stopped or failed.
    out.once("close", () => {
      if (failure === undefined && stopped === undefined) return resolve(size);
      fs.rmSync(file, { force: true });
      if (failure !== undefined) reject(failure);
      else resolve(stopped ?? "cut-short");
    });
  });
}

/** Start the API; resolves to a function that closes it. */
export async function startApi(opts: ApiOptions): Promise<() => Promise<void>> {
  const { socket, handler, events, tasks, documents, ideas, rules, memory, settings } = opts;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const pageSize = opts.pageSize ?? BACKLOG_PAGE;

  // Client ids accepted so far, oldest first. They live in this process only: after a restart a
  // client that sends a message again can have it delivered twice.
  const accepted = new Set<string>();
  const remember = (clientId: string) => {
    accepted.add(clientId);
    if (accepted.size <= REMEMBERED_CLIENT_IDS) return;
    const oldest = accepted.values().next().value;
    if (oldest !== undefined) accepted.delete(oldest);
  };

  const streams = new Set<http.ServerResponse>();

  async function postCommand(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req);
    if (body === undefined) {
      sendJson(res, 413, { error: `command is over ${MAX_COMMAND_BYTES} bytes` });
      // What is still coming is read and dropped, not kept.
      req.resume();
      return;
    }
    if (!isJson(req.headers["content-type"])) return sendJson(res, 400, { error: "content type must be application/json" });
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return sendJson(res, 400, { error: "body is not valid JSON" });
    }
    const parsed = parseCommand(json);
    if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });

    const { command } = parsed;
    if (command.type === "run.stop") {
      if (await handler.stopRun(command.runId)) return sendJson(res, 202, { stopped: true });
      return sendJson(res, 404, { error: `no live or queued run ${command.runId}` });
    }
    if (command.type === "question.answer") {
      try {
        if (await handler.answerQuestion(command.questionId, command.answers)) return sendJson(res, 202, { answered: true });
      } catch (err) {
        if (err instanceof InvalidAnswer) return sendJson(res, 400, { error: err.message });
        throw err;
      }
      return sendJson(res, 404, { error: `no open question ${command.questionId}` });
    }
    // A task command never reaches the message path. Without a task store (none is wired in yet) it is refused with 503.
    if (command.type === "task.run" || command.type === "task.create" || command.type === "task.update") {
      if (!tasks) return sendJson(res, 503, { error: "tasks are not available" });
      if (command.type === "task.run") {
        if (await tasks.run(command.taskId)) return sendJson(res, 202, { accepted: true });
        return sendJson(res, 404, { error: `no task ${command.taskId}` });
      }
      const reply = command.type === "task.create" ? await tasks.create(command) : await tasks.update(command);
      if (!reply.ok) return sendJson(res, reply.status, { error: reply.error });
      return sendJson(res, command.type === "task.create" ? 201 : 200, { task: reply.task });
    }
    // A document command never reaches the message path either. Without a document store it is refused with 503.
    if (command.type === "document.revise" || command.type === "document.undo") {
      if (!documents) return sendJson(res, 503, { error: "documents are not available" });
      if (command.type === "document.revise") {
        const reply = await documents.revise(command);
        if (!reply.ok) return sendJson(res, reply.status, { error: reply.error });
        return sendJson(res, 202, reply.body);
      }
      if (!documents.undo) return sendJson(res, 503, { error: "undo is not available" });
      const reply = await documents.undo(command);
      if (!reply.ok) return sendJson(res, reply.status, { error: reply.error });
      return sendJson(res, 200, reply.body);
    }
    // An idea command never reaches the message path either. Without an idea store it is refused with 503.
    if (command.type === "idea.accept" || command.type === "idea.reject" || command.type === "idea.generate") {
      if (!ideas) return sendJson(res, 503, { error: "ideas are not available" });
      if (command.type === "idea.accept") {
        const reply = await ideas.accept(command);
        if (!reply.ok) return sendJson(res, reply.status, { error: reply.error });
        return sendJson(res, 200, reply.body);
      }
      if (command.type === "idea.reject") {
        const reply = await ideas.reject(command);
        if (!reply.ok) return sendJson(res, reply.status, { error: reply.error });
        return sendJson(res, 200, reply.body);
      }
      const reply = await ideas.generate(command);
      if (!reply.ok) return sendJson(res, reply.status, { error: reply.error });
      return sendJson(res, 202, reply.body);
    }
    // A rules command never reaches the message path either. Without a rules service it is refused with 503.
    if (command.type === "rules.save") {
      if (!rules) return sendJson(res, 503, { error: "rules are not available" });
      const reply = await rules.save(command);
      if (!reply.ok) return sendJson(res, reply.status, { error: reply.error });
      return sendJson(res, 200, reply.body);
    }
    // A memory command never reaches the message path either. Without a memory service it is refused with 503.
    if (command.type === "memory.create" || command.type === "memory.update" || command.type === "memory.delete") {
      if (!memory) return sendJson(res, 503, { error: "memory is not available" });
      if (command.type === "memory.create") {
        const reply = await memory.create(command);
        if (!reply.ok) return sendJson(res, reply.status, { error: reply.error });
        return sendJson(res, 201, reply.body);
      }
      const reply = command.type === "memory.update" ? await memory.update(command) : await memory.delete(command);
      if (!reply.ok) return sendJson(res, reply.status, { error: reply.error });
      return sendJson(res, 200, reply.body);
    }
    // A settings command never reaches the message path either. Without a settings store it is refused with 503.
    if (command.type === "settings.update") {
      if (!settings) return sendJson(res, 503, { error: "settings are not available" });
      const reply = await settings.update(command);
      if (!reply.ok) return sendJson(res, reply.status, { error: reply.error });
      return sendJson(res, 200, { settings: reply.settings });
    }
    // A message's files are checked before anything is submitted: one that is not in the inbox refuses the message.
    const files = command.files ?? [];
    const missing = files.findIndex((file) => !inboxFile(file.path));
    if (missing >= 0) return sendJson(res, 400, { error: `files.${missing}.path: no such file in the inbox` });
    if (accepted.has(command.clientId)) return sendJson(res, 200, { accepted: false, duplicate: true });
    // Remembered before the handler is awaited, so a second post of the same id meanwhile is a duplicate.
    remember(command.clientId);
    try {
      await handler.submit({ text: command.text, clientId: command.clientId, files });
    } catch (err) {
      accepted.delete(command.clientId);
      throw err;
    }
    sendJson(res, 202, { accepted: true });
  }

  /**
   * POST /uploads?name=<name>: the body is the file, saved in today's inbox under a sanitized, unique name.
   * The upload records no event; the message that names the file does.
   */
  async function postUpload(req: http.IncomingMessage, res: http.ServerResponse, params: URLSearchParams): Promise<void> {
    const name = uploadName(params.get("name"));
    if (name === undefined) {
      sendJson(res, 400, { error: `name must be 1 to ${MAX_NAME_CHARS} characters, with no /, \\ or NUL, and not . or ..` });
      req.resume();
      return;
    }
    if (Number(req.headers["content-length"]) > MAX_UPLOAD_BYTES) {
      sendJson(res, 413, { error: `upload is over ${MAX_UPLOAD_BYTES} bytes` });
      req.resume();
      return;
    }
    const dir = path.join(WORKSPACE_DIR, "inbox", localDate());
    fs.mkdirSync(dir, { recursive: true });
    // Written under a temporary name and renamed once complete, so a cut-short upload leaves no file.
    const temp = path.join(dir, `.upload-${crypto.randomUUID()}.part`);
    const received = await receiveUpload(req, temp);
    if (received === "cut-short") return;
    if (received === "too-large") {
      sendJson(res, 413, { error: `upload is over ${MAX_UPLOAD_BYTES} bytes` });
      req.resume();
      return;
    }
    const file = uniquePath(dir, sanitizeFileName(name, `file-${localTime()}.bin`));
    fs.renameSync(temp, file);
    const answer: UploadResult = { file: { path: path.relative(WORKSPACE_DIR, file), kind: uploadKind(file) } };
    sendJson(res, 201, answer);
  }

  function getEvents(req: http.IncomingMessage, res: http.ServerResponse, params: URLSearchParams): void {
    const header = req.headers["last-event-id"]?.toString();
    const from = header ?? params.get("after") ?? "0";
    const after = parseId(from);
    if (after === undefined) {
      return sendJson(res, 400, { error: `${header === undefined ? "after" : "Last-Event-ID"} must be a non-negative integer` });
    }
    stream(res, after).catch((err) => {
      log.error(`api: an event stream failed: ${describeError(err)}`);
      res.destroy();
    });
  }

  /**
   * Sends the events after `after`: the backlog in pages, then live ones. The stream subscribes first
   * and buffers the durable events that arrive while the backlog is read; events are sent in id order
   * and one with an id that was already sent is dropped, so nothing is skipped or repeated at the switch
   * to live. A live event (one without an id) that arrives before that switch is dropped: it was never
   * stored, so a stream that was not there when it happened never gets it.
   */
  async function stream(res: http.ServerResponse, after: number): Promise<void> {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
    res.flushHeaders();
    // A ping as the stream opens. A proxy in front, Cloudflare's, holds the response headers until the first body byte,
    // so a client that resumes with nothing to catch up on would wait a whole heartbeat to learn it is connected.
    res.write(PING);
    streams.add(res);

    let sent = after;
    let live = false;
    let done = false;
    let waiter: (() => void) | undefined;
    const buffered: Event[] = [];
    const wake = () => {
      const resume = waiter;
      waiter = undefined;
      resume?.();
    };

    const write = (text: string) => {
      if (done) return;
      res.write(text);
      if (res.writableLength > MAX_UNREAD_BYTES) {
        log.warn(`api: dropping an event stream that left ${res.writableLength} bytes unread`);
        res.destroy();
      }
    };
    const send = (event: Event) => {
      if (event.id <= sent) return;
      sent = event.id;
      write(frame(event));
    };

    const unsubscribe = events.subscribe((event) => {
      if (isLiveEvent(event)) {
        if (live) write(frame(event));
      } else if (live) send(event);
      else buffered.push(event);
    });
    const timer = setInterval(() => write(PING), heartbeatMs);
    res.on("drain", wake);
    res.once("close", () => {
      done = true;
      unsubscribe();
      clearInterval(timer);
      streams.delete(res);
      wake();
    });

    try {
      for (;;) {
        const page = events.readSince(sent, pageSize);
        for (const event of page) send(event);
        if (page.length < pageSize) break;
        // Waits for a slow client to catch up, and lets other work run between pages.
        await new Promise<void>((resolve) => {
          if (res.writableNeedDrain) waiter = resolve;
          else setImmediate(resolve);
        });
        if (done) return;
      }
    } catch (err) {
      log.error(`api: reading the events for a stream failed: ${describeError(err)}`);
      res.destroy();
      return;
    }
    // No await from here to the end of the buffer: an event appended after the last page was read is in it.
    for (const event of buffered) send(event);
    buffered.length = 0;
    live = true;
  }

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const target = req.url ?? "/";
    const query = target.indexOf("?");
    const pathname = query < 0 ? target : target.slice(0, query);
    const params = new URLSearchParams(query < 0 ? "" : target.slice(query + 1));
    const method = req.method ?? "";
    switch (pathname) {
      case "/commands":
        return method === "POST" ? postCommand(req, res) : methodNotAllowed(res, "POST");
      case "/uploads":
        return method === "POST" ? postUpload(req, res, params) : methodNotAllowed(res, "POST");
      case "/events":
        return method === "GET" ? getEvents(req, res, params) : methodNotAllowed(res, "GET");
      case "/health":
        return method === "GET" ? sendJson(res, 200, { ok: true, lastEventId: events.lastId() }) : methodNotAllowed(res, "GET");
      default:
        return sendJson(res, 404, { error: "not found" });
    }
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      // A client that went away mid-request is not an error of ours.
      if (res.destroyed) return;
      log.error(`api ${req.method ?? ""} ${req.url ?? ""} failed: ${describeError(err)}`);
      if (res.headersSent) res.destroy();
      else sendJson(res, 500, { error: "internal error" });
    });
  });

  // Only a directory made here is restricted: the socket may sit in a shared one, and it is 0600 either way.
  const dir = path.dirname(socket);
  if (fs.mkdirSync(dir, { recursive: true, mode: 0o700 }) !== undefined) fs.chmodSync(dir, 0o700);
  try {
    if (fs.lstatSync(socket).isSocket()) fs.rmSync(socket);
  } catch {
    // No socket left over.
  }
  // Created owner-only from the start, so no other user can connect in between.
  const umask = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } finally {
    process.umask(umask);
  }
  // After startup a server error is logged, not thrown: it must not take Alfred down.
  server.on("error", (err) => log.error(`api server error: ${describeError(err)}`));
  log.info(`api listening on ${socket}`);

  return async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const res of streams) res.destroy();
    // A request still being answered finishes; its connection goes once it is idle, or after the grace period.
    const cutAt = Date.now() + CLOSE_GRACE_MS;
    const sweep = setInterval(() => (Date.now() < cutAt ? server.closeIdleConnections() : server.closeAllConnections()), 20);
    await closed;
    clearInterval(sweep);
  };
}
