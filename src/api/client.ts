// A client of the command API for the `api` CLI commands and the smoke test: plain
// node:http over the socket.

import http from "node:http";

import { EventSchema } from "./schema.ts";

export interface ApiResponse {
  status: number;
  body: string;
}

/** One event as the stream sends it: its id, its type and the JSON of the whole event. A live event has no id line, and its id is NaN. */
export interface Frame {
  id: number;
  type: string;
  data: string;
}

function unreachable(socket: string, err: unknown): Error {
  return new Error(`cannot reach Alfred's API at ${socket}`, { cause: err });
}

/**
 * One request to the API; a body is sent as JSON, or as it is when it is a Buffer (an upload). Resolves with the status and the body, whatever the status.
 * When `signal` aborts, the request is dropped and the promise rejects with the signal's reason.
 */
export function request(socket: string, method: string, target: string, body?: unknown, opts: { signal?: AbortSignal } = {}): Promise<ApiResponse> {
  const { signal } = opts;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body);
    const contentType = Buffer.isBuffer(body) ? "application/octet-stream" : "application/json";
    const headers = payload === undefined ? {} : { "Content-Type": contentType, "Content-Length": Buffer.byteLength(payload) };
    const req = http.request({ socketPath: socket, method, path: target, headers, agent: false }, (res) => {
      res.setEncoding("utf8");
      let text = "";
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      res.on("error", reject);
    });
    if (signal) {
      const onAbort = () => {
        reject(signal.reason);
        req.destroy();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => signal.removeEventListener("abort", onAbort));
    }
    req.on("error", (err) => reject(unreachable(socket, err)));
    req.end(payload);
  });
}

/** The frame in one block of an event stream; undefined for a block without data, such as a ping. */
function parseFrame(block: string): Frame | undefined {
  let id = Number.NaN;
  let type = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "id") id = Number(value);
    else if (field === "event") type = value;
    else if (field === "data") data.push(value);
  }
  return data.length ? { id, type, data: data.join("\n") } : undefined;
}

/**
 * Follows /events, yielding each event until the server ends the stream, `signal` aborts it
 * or the caller stops iterating. Resumes after `lastEventId` (sent as the Last-Event-ID
 * header, as a reconnecting EventSource does) or after `after` (the `after` query).
 */
export async function* streamEvents(
  socket: string,
  opts: { after?: number; lastEventId?: number; signal?: AbortSignal } = {},
): AsyncGenerator<Frame> {
  const query = opts.after === undefined ? "" : `?after=${opts.after}`;
  const headers = opts.lastEventId === undefined ? {} : { "Last-Event-ID": String(opts.lastEventId) };
  const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = http.get({ socketPath: socket, path: `/events${query}`, headers, agent: false, signal: opts.signal }, resolve);
    req.on("error", (err) => reject(unreachable(socket, err)));
  });
  res.setEncoding("utf8");
  try {
    if (res.statusCode !== 200) {
      let text = "";
      for await (const chunk of res) text += chunk;
      throw new Error(`GET /events answered ${res.statusCode}: ${text}`);
    }
    let pending = "";
    for await (const chunk of res) {
      pending += chunk;
      for (let end = pending.indexOf("\n\n"); end >= 0; end = pending.indexOf("\n\n")) {
        const frame = parseFrame(pending.slice(0, end));
        pending = pending.slice(end + 2);
        if (frame) yield frame;
      }
    }
  } finally {
    res.destroy();
  }
}

/** One line for an event: its id, its type and what it is about. */
export function describeEvent(frame: Frame): string {
  const flat = (text: string, max: number) => {
    const line = text.replace(/\s+/g, " ").trim();
    return line.length > max ? `${line.slice(0, max)}…` : line;
  };
  let summary = flat(frame.data, 80);
  try {
    const parsed = EventSchema.safeParse(JSON.parse(frame.data));
    if (parsed.success && parsed.data.type === "message.created") {
      const m = parsed.data.data;
      const files = m.files.length ? ` +${m.files.length} file${m.files.length === 1 ? "" : "s"}` : "";
      summary = `${m.channel} ${m.direction}${m.runId ? ` run=${m.runId}` : ""}${m.error ? " (not delivered)" : ""} ${flat(m.text, 60)}${files}`.trimEnd();
    } else if (parsed.success && parsed.data.type === "run.updated") {
      const r = parsed.data.data;
      summary = `${r.id} ${r.kind} ${r.status} $${r.costUsd.toFixed(4)} ${flat(r.title, 60)}`;
    }
  } catch {
    // Not JSON: the raw data stays.
  }
  return `${Number.isNaN(frame.id) ? "live" : frame.id} ${frame.type} ${summary}`;
}
