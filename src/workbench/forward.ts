// The app API's forwarding: the workbench passes the app's commands, its event
// stream and its uploads on to Alfred's command socket (src/api/server.ts), and
// relays Alfred's answers. It speaks plain HTTP over that socket and holds no
// Alfred secret. A command is checked with parseCommand before anything is sent,
// so only what Alfred would accept goes on.

import http from "node:http";

import { MAX_COMMAND_BYTES, MAX_UPLOAD_BYTES, parseCommand } from "../api/schema.ts";
import type { ErrorResponse } from "../api/schema.ts";

/** What a request answers with: a body read in full, or Alfred's event stream as it arrives. */
export interface Reply {
  status: number;
  headers: Record<string, string>;
  body: string | http.IncomingMessage;
  /** The request body was not read to its end, so the connection closes once the reply is sent. */
  closeConnection?: boolean;
}

const JSON_TYPE = "application/json; charset=utf-8";
const UNREACHABLE = "Alfred is not reachable; try again.";

export function jsonReply(status: number, body: unknown): Reply {
  return { status, headers: { "Content-Type": JSON_TYPE }, body: JSON.stringify(body) };
}

export function jsonError(status: number, message: string, headers: Record<string, string> = {}): Reply {
  const body: ErrorResponse = { error: message };
  return { status, headers: { "Content-Type": JSON_TYPE, ...headers }, body: JSON.stringify(body) };
}

/** Alfred's socket cannot be reached (Alfred is restarting, or the API is off): the app retries. */
function unreachable(closeConnection = false): Reply {
  return { ...jsonError(503, UNREACHABLE), closeConnection };
}

function tooLarge(message: string): Reply {
  return { ...jsonError(413, message), closeConnection: true };
}

function isJson(contentType: string | undefined): boolean {
  return contentType?.split(";")[0]?.trim().toLowerCase() === "application/json";
}

function onAbort(signal: AbortSignal, action: () => void): void {
  if (signal.aborted) action();
  else signal.addEventListener("abort", action, { once: true });
}

/** The request body as text, or undefined once it is over `limit`; the rest is then not read. */
export function readBody(req: http.IncomingMessage, limit: number): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"]) > limit) return resolve(undefined);
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) return void chunks.push(chunk);
      req.off("data", onData);
      resolve(undefined);
    };
    req.on("data", onData);
    req.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.once("close", () => reject(new Error("the request was cut short")));
  });
}

/** A response body read in full. */
function collect(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    res.once("error", reject);
    res.once("close", () => reject(new Error("Alfred closed its answer early")));
  });
}

function contentTypeOf(res: http.IncomingMessage): string {
  return res.headers["content-type"] ?? JSON_TYPE;
}

/** One request with its body in hand, answered with Alfred's status and body as they are. */
function exchange(socket: string, method: string, target: string, headers: http.OutgoingHttpHeaders, body: string, gone: AbortSignal): Promise<Reply> {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (reply: Reply) => {
      if (answered) return;
      answered = true;
      resolve(reply);
    };
    const up = http.request({ socketPath: socket, method, path: target, headers, agent: false });
    up.on("error", () => answer(unreachable()));
    up.on("response", (res) => {
      collect(res).then(
        (text) => answer({ status: res.statusCode ?? 502, headers: { "Content-Type": contentTypeOf(res) }, body: text }),
        () => answer(unreachable()),
      );
    });
    onAbort(gone, () => {
      up.destroy();
      answer(unreachable());
    });
    up.end(body);
  });
}

/**
 * POST /api/commands. The body is checked before anything is sent: over the limit
 * is 413; a body that is not application/json, not JSON or not a valid command is
 * 400, with the parser's line for the last. A valid command goes to Alfred.
 */
export async function forwardCommand(req: http.IncomingMessage, socket: string | undefined, gone: AbortSignal): Promise<Reply> {
  const body = await readBody(req, MAX_COMMAND_BYTES);
  if (body === undefined) return tooLarge(`command is over ${MAX_COMMAND_BYTES} bytes`);
  if (!isJson(req.headers["content-type"])) return jsonError(400, "content type must be application/json");
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return jsonError(400, "body is not valid JSON");
  }
  const parsed = parseCommand(json);
  if (!parsed.ok) return jsonError(400, parsed.error);
  if (!socket) return unreachable();
  const payload = JSON.stringify(parsed.command);
  return exchange(socket, "POST", "/commands", { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }, payload, gone);
}

/**
 * GET /api/events. Alfred's stream is relayed as it arrives, byte for byte. The
 * resume point goes on as the client sent it, in Last-Event-ID or ?after=. A
 * client that goes away ends the upstream request; an upstream that ends or
 * breaks ends the client's response.
 */
export function forwardEvents(req: http.IncomingMessage, url: URL, socket: string | undefined, gone: AbortSignal): Promise<Reply> {
  if (!socket) return Promise.resolve(unreachable());
  const after = url.searchParams.get("after");
  const query = after === null ? "" : `?${new URLSearchParams({ after })}`;
  const headers: http.OutgoingHttpHeaders = {};
  const lastEventId = req.headers["last-event-id"];
  if (lastEventId !== undefined) headers["Last-Event-ID"] = lastEventId;
  return new Promise((resolve) => {
    let answered = false;
    const answer = (reply: Reply) => {
      if (answered) return;
      answered = true;
      resolve(reply);
    };
    const up = http.request({ socketPath: socket, method: "GET", path: `/events${query}`, headers, agent: false });
    up.on("error", () => answer(unreachable()));
    up.on("response", (res) => {
      if (res.statusCode === 200) return answer({ status: 200, headers: { "Content-Type": "text/event-stream" }, body: res });
      collect(res).then(
        (text) => answer({ status: res.statusCode ?? 502, headers: { "Content-Type": contentTypeOf(res) }, body: text }),
        () => answer(unreachable()),
      );
    });
    onAbort(gone, () => {
      up.destroy();
      answer(unreachable());
    });
    up.end();
  });
}

/**
 * POST /api/uploads?name=. The body streams to Alfred's /uploads with the
 * client's content type and length. A declared length over the limit is 413
 * before anything is sent; without one, the body is counted and cut with 413
 * once it passes the limit, so Alfred never gets a complete over-size upload.
 */
export function forwardUpload(req: http.IncomingMessage, name: string | null, socket: string | undefined, gone: AbortSignal): Promise<Reply> {
  const declared = req.headers["content-length"];
  if (declared !== undefined && Number(declared) > MAX_UPLOAD_BYTES) return Promise.resolve(tooLarge(`upload is over ${MAX_UPLOAD_BYTES} bytes`));
  if (!socket) return Promise.resolve(unreachable(true));
  const query = name === null ? "" : `?${new URLSearchParams({ name })}`;
  const headers: http.OutgoingHttpHeaders = { "Content-Type": req.headers["content-type"] ?? "application/octet-stream" };
  if (declared !== undefined) headers["Content-Length"] = declared;
  return new Promise((resolve) => {
    let answered = false;
    const answer = (reply: Reply) => {
      if (answered) return;
      answered = true;
      resolve(reply);
    };
    let size = 0;
    const up = http.request({ socketPath: socket, method: "POST", path: `/uploads${query}`, headers, agent: false });
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_UPLOAD_BYTES) return;
      // Past the limit nothing more is forwarded, so Alfred sees the upload cut short.
      req.off("data", onData);
      req.unpipe(up);
      up.destroy();
      answer(tooLarge(`upload is over ${MAX_UPLOAD_BYTES} bytes`));
    };
    up.on("error", () => answer(unreachable(!req.complete)));
    up.on("response", (res) => {
      collect(res).then(
        (text) => answer({ status: res.statusCode ?? 502, headers: { "Content-Type": contentTypeOf(res) }, body: text, closeConnection: !req.complete }),
        () => answer(unreachable(!req.complete)),
      );
    });
    onAbort(gone, () => {
      up.destroy();
      answer(unreachable(true));
    });
    req.on("data", onData);
    req.pipe(up);
  });
}
