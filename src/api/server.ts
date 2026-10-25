// The command API: the owner's commands in, Alfred's events out, over a Unix
// socket (no TCP listener). A process on the same host posts message.send and
// run.stop to /commands and follows /events as server-sent events, resuming by
// event id. Every command is validated here by parseCommand. Live events (reply
// text as it is written, the steps of a run) go out as frames without an id and
// are never replayed.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import type { Intake } from "../channels.ts";
import { type EventLog, isLiveEvent } from "../events.ts";
import { describeError, log } from "../log.ts";
import { STATE_DIR } from "../store.ts";
import { MAX_COMMAND_BYTES, parseCommand } from "./schema.ts";
import type { Event, LiveEvent } from "./schema.ts";

/** How often an event stream gets a `: ping` comment. */
export const HEARTBEAT_MS = 30_000;
/** Events per page when a stream sends its backlog. */
const BACKLOG_PAGE = 200;
/** A client that lets this much pile up unread is dropped; it resumes by id when it reconnects. */
const MAX_UNREAD_BYTES = 8 * 1024 * 1024;
/** How many accepted client ids are remembered for the duplicate check. */
const REMEMBERED_CLIENT_IDS = 1000;
/** On close, how long a request in flight gets before its connection is cut. */
const CLOSE_GRACE_MS = 2000;

/** The part of the event log the API reads. */
export type ApiEvents = Pick<EventLog, "lastId" | "readSince" | "subscribe">;

export interface ApiOptions {
  /** Path of the Unix socket. */
  socket: string;
  /** Where commands go: the agent handler's intake. */
  handler: Intake;
  events: ApiEvents;
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

/** Start the API; resolves to a function that closes it. */
export async function startApi(opts: ApiOptions): Promise<() => Promise<void>> {
  const { socket, handler, events } = opts;
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
      if (await handler.stopRun(command.runId, "app")) return sendJson(res, 202, { stopped: true });
      return sendJson(res, 404, { error: `no live or queued run ${command.runId}` });
    }
    if (accepted.has(command.clientId)) return sendJson(res, 200, { accepted: false, duplicate: true });
    // Remembered before the handler is awaited, so a second post of the same id meanwhile is a duplicate.
    remember(command.clientId);
    try {
      await handler.submit({ channel: "app", text: command.text, clientId: command.clientId, files: [] });
    } catch (err) {
      accepted.delete(command.clientId);
      throw err;
    }
    sendJson(res, 202, { accepted: true });
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
    const timer = setInterval(() => write(": ping\n\n"), heartbeatMs);
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
  // After startup a server error is logged, not thrown: it must not take the bot down.
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
