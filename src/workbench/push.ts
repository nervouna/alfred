// Push notifications for the app. notificationFor is the one rule that says which
// events notify the owner and what each notification says. The dispatcher follows
// Alfred's event stream from a saved cursor and sends each notifying event to every
// device with a registration, through the APNs client. Delivery is best effort.

import path from "node:path";

import { z } from "zod";

import { request, streamEvents } from "../api/client.ts";
import type { Frame } from "../api/client.ts";
import { apiSocketPath } from "../api/server.ts";
import { EventSchema } from "../api/schema.ts";
import type { Event, Message, PushRegistration } from "../api/schema.ts";
import { describeError, log } from "../log.ts";
import { readJson, writeJson } from "../store.ts";
import { ApnsClient, apnsSettings } from "./apns.ts";
import type { ApnsResult } from "./apns.ts";
import { DeviceStore, deviceStateDir } from "./devices.ts";

/** What the APNs payload carries: the alert, the sound and thread, and the app's own keys. */
export interface Notification {
  aps: { alert: { title: string; body: string }; sound: "default"; "thread-id": "chat" };
  /** The event the notification is about, so the app can open it. */
  eventId?: number;
  runId?: string;
}

/** The part of the APNs client the dispatcher uses. */
export type Sender = Pick<ApnsClient, "send">;

const TITLE = "Alfred";
const BODY_CHARS = 100;
const QUESTION_ASKED = "Alfred 想问你：";

/** A notification with this body; `eventId` and `runId` are included only when given. */
export function notify(body: string, eventId?: number, runId?: string): Notification {
  const note: Notification = { aps: { alert: { title: TITLE, body }, sound: "default", "thread-id": "chat" } };
  if (eventId !== undefined) note.eventId = eventId;
  if (runId !== undefined) note.runId = runId;
  return note;
}

/**
 * The push rule: which events notify the owner, and what each notification says. An
 * outbound message on the app channel does; so does a question Alfred asks, with the first
 * question as its body: a run is waiting for the answer. Nothing else does, and a message of
 * a retired channel that is still in the log never does. A new event that should notify is
 * added here.
 */
export function notificationFor(event: Event): Notification | undefined {
  if (event.type === "question.asked") {
    const first = event.data.questions[0];
    return first ? notify(`${QUESTION_ASKED}${clip(first.question)}`, event.id, event.data.runId) : undefined;
  }
  if (event.type !== "message.created") return undefined;
  const message = event.data;
  if (message.direction !== "out" || message.channel !== "app") return undefined;
  return notify(clip(bodyText(message)), event.id, message.runId);
}

/** The message's text, or for a file-only message the name of its first file. */
function bodyText(message: Message): string {
  const text = message.text.trim();
  if (text !== "") return text;
  const first = message.files[0];
  return first ? `文件：${path.posix.basename(first.path)}` : "";
}

/** The first 100 characters, and an ellipsis after them when there were more. */
function clip(text: string): string {
  const chars = [...text];
  return chars.length > BODY_CHARS ? `${chars.slice(0, BODY_CHARS).join("")}…` : text;
}

export interface PushOutcome {
  deviceId: string;
  result: ApnsResult;
}

/** APNs says this token will never get a notification again. */
function isDead(result: ApnsResult): boolean {
  return result.status === 410 || (result.status === 400 && result.reason === "BadDeviceToken");
}

/** "HTTP 200", APNs's refusal with its reason, or why there was no answer. */
export function describeResult(result: ApnsResult): string {
  if (result.status === 0) return `no answer: ${result.reason ?? "unknown"}`;
  return result.reason ? `HTTP ${result.status} ${result.reason}` : `HTTP ${result.status}`;
}

/**
 * Sends a notification to every unrevoked device that has a registration. A token APNs
 * reports dead (410, or 400 BadDeviceToken) is removed from its device. Any other answer
 * is logged and not retried.
 */
export async function pushToDevices(note: Notification, devices: DeviceStore, apns: Sender): Promise<PushOutcome[]> {
  const targets: { deviceId: string; push: PushRegistration }[] = [];
  for (const device of devices.list()) {
    if (!device.revokedAt && device.push) targets.push({ deviceId: device.id, push: device.push });
  }
  return Promise.all(
    targets.map(async ({ deviceId, push }) => {
      const result = await apns.send(push, note);
      if (result.status === 200) {
        log.info(`push: sent to device ${deviceId}`);
      } else if (isDead(result)) {
        devices.forgetPush(deviceId, push.token);
        log.warn(`push: APNs no longer takes device ${deviceId}'s token (${describeResult(result)}); its registration is removed`);
      } else {
        log.warn(`push: device ${deviceId} not notified (${describeResult(result)}); not retried`);
      }
      return { deviceId, result };
    }),
  );
}

/** The wait before a reconnect: it doubles from `current`, up to `max`. */
export function nextDelay(current: number, max: number): number {
  return Math.min(current * 2, max);
}

const BACKOFF = { minMs: 1000, maxMs: 30_000 };
const HEALTH_TIMEOUT_MS = 10_000;
const CursorSchema = z.object({ lastEventId: z.number().int().nonnegative() });

export interface DispatcherOptions {
  /** Alfred's command socket, for /health and /events. */
  socket: string;
  /** Where the id of the last event handled is saved. */
  cursorFile: string;
  devices: DeviceStore;
  apns: Sender;
  /** Stops the dispatcher when it aborts. */
  signal: AbortSignal;
  /** The first and the longest wait between reconnects; 1 s and 30 s by default. */
  backoff?: { minMs: number; maxMs: number };
  /** How long GET /health may take before it counts as a failure; 10 s by default. */
  healthTimeoutMs?: number;
}

/**
 * Follows Alfred's event stream and pushes what the rule notifies about. It resumes
 * after the saved cursor. With no cursor it starts after the latest event on /health, so
 * old events never push. The cursor is saved after each event is handled, and an event
 * whose id is not past the cursor is skipped, so a restart pushes nothing twice. Frames
 * without an id (live frames) are never pushed. When the socket is unreachable or the
 * stream ends, it reconnects after a wait that doubles up to 30 s; a frame resets the wait.
 */
export async function runPushDispatcher(opts: DispatcherOptions): Promise<void> {
  const backoff = opts.backoff ?? BACKOFF;
  let delay = backoff.minMs;
  // Kept across reconnects, so an event pushed in this process is never pushed again even if the cursor file cannot be written.
  let cursor: number | undefined;
  while (!opts.signal.aborted) {
    try {
      cursor ??= await resumePoint(opts);
      for await (const frame of streamEvents(opts.socket, { after: cursor, signal: opts.signal })) {
        delay = backoff.minMs;
        if (!Number.isSafeInteger(frame.id) || frame.id <= cursor) continue;
        await handle(frame, opts);
        cursor = frame.id;
        writeJson(opts.cursorFile, { lastEventId: cursor });
      }
    } catch (err) {
      if (opts.signal.aborted) break;
      log.warn(`push: following Alfred's events failed, retrying in ${delay} ms: ${describeError(err)}`);
    }
    if (opts.signal.aborted) break;
    await sleep(delay, opts.signal);
    delay = nextDelay(delay, backoff.maxMs);
  }
}

/** The event to resume after: the saved cursor, or else the latest event on Alfred, which is saved as the cursor. */
async function resumePoint(opts: DispatcherOptions): Promise<number> {
  const saved = readCursor(opts.cursorFile);
  if (saved !== undefined) return saved;
  const timeout = AbortSignal.timeout(opts.healthTimeoutMs ?? HEALTH_TIMEOUT_MS);
  const health = await request(opts.socket, "GET", "/health", undefined, { signal: AbortSignal.any([opts.signal, timeout]) });
  if (health.status !== 200) throw new Error(`GET /health answered ${health.status}`);
  const { lastEventId } = CursorSchema.parse(JSON.parse(health.body));
  writeJson(opts.cursorFile, { lastEventId });
  log.info(`push: following Alfred's events after event ${lastEventId}`);
  return lastEventId;
}

/** The saved cursor, or undefined when there is none. A cursor that cannot be read is logged and ignored: push then starts from the latest event. */
function readCursor(file: string): number | undefined {
  let saved: unknown;
  try {
    saved = readJson(file);
  } catch (err) {
    log.warn(`push: ${file} cannot be read, so push starts from the latest event: ${describeError(err)}`);
    return undefined;
  }
  if (saved === undefined) return undefined;
  const parsed = CursorSchema.safeParse(saved);
  if (!parsed.success) {
    log.warn(`push: ${file} does not hold a cursor, so push starts from the latest event`);
    return undefined;
  }
  return parsed.data.lastEventId;
}

/** Pushes what the rule notifies about in one frame. */
async function handle(frame: Frame, opts: DispatcherOptions): Promise<void> {
  let json: unknown;
  try {
    json = JSON.parse(frame.data);
  } catch {
    log.warn(`push: event ${frame.id} is not JSON, so it is not checked for a push`);
    return;
  }
  const parsed = EventSchema.safeParse(json);
  if (!parsed.success) {
    log.warn(`push: event ${frame.id} does not fit the client schema, so it is not checked for a push`);
    return;
  }
  const note = notificationFor(parsed.data);
  if (note) await pushToDevices(note, opts.devices, opts.apns);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

const noop = async () => {};

/**
 * Starts the dispatcher when push is configured and returns the function that stops it.
 * When it is not, one log line says why, and the function does nothing. The command API's
 * socket comes from the environment, as the workbench forwards to it.
 */
export function startPush(env: Record<string, string | undefined> = process.env, devices: DeviceStore = new DeviceStore()): () => Promise<void> {
  let setting: ReturnType<typeof apnsSettings>;
  try {
    setting = apnsSettings(env);
  } catch (err) {
    log.error(`push is off: ${describeError(err)}`);
    return noop;
  }
  if (!setting.ok) {
    log.info(`push is off: ${setting.missing.join(", ")} not set`);
    return noop;
  }
  const socket = apiSocketPath();
  if (!socket) {
    log.info("push is off: the command API is off (ALFRED_API_SOCKET=off)");
    return noop;
  }
  const { key, keyId, teamId, topic } = setting.settings;
  const apns = new ApnsClient({ key, keyId, teamId, topic });
  const abort = new AbortController();
  const running = runPushDispatcher({
    socket,
    cursorFile: path.join(deviceStateDir(), "push-cursor.json"),
    devices,
    apns,
    signal: abort.signal,
  });
  log.info(`push is on for ${topic}`);
  return async () => {
    abort.abort();
    await running;
    apns.close();
  };
}
