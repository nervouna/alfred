// The event log: the durable changes a client must see, one JSON line per event
// in $STATE_DIR/events/events.jsonl. Ids grow by one and follow file order, so a
// client that reconnects asks for the events after the last id it saw. Only
// durable events go here; streaming deltas and per-step progress never do.

import fs from "node:fs";
import path from "node:path";

import { type Event, EventSchema } from "./api/schema.ts";
import { describeError, log } from "./log.ts";
import { STATE_DIR } from "./store.ts";

export const EVENTS_LOG = path.join(STATE_DIR, "events", "events.jsonl");

/** Events readSince returns when the caller does not say how many. */
const DEFAULT_READ_LIMIT = 1000;

type EventOf<T extends Event["type"]> = Extract<Event, { type: T }>;
export type EventListener = (event: Event) => void;

/**
 * An append-only log in one file. Several instances on the same file see each
 * other's events: each reads the file again when its size has changed.
 */
export class EventLog {
  private readonly file: string;
  private readonly listeners = new Set<EventListener>();
  /** Id of the last event, as of the file size `seenSize`. */
  private last = 0;
  /** File size when `last` was read; -1 until the first read, and after a failed write. */
  private seenSize = -1;
  /** The file ends in a line a crash cut short, so the next append starts a new line. */
  private torn = false;

  constructor(file = EVENTS_LOG) {
    this.file = file;
  }

  /** The id of the last event; 0 when the log is empty. */
  lastId(): number {
    this.refresh();
    return this.last;
  }

  /**
   * Validates an event with the next id, appends it as one line and tells the
   * listeners. Returns the event, or undefined when it is invalid or cannot be
   * written. Never throws.
   */
  append<T extends Event["type"]>(type: T, data: EventOf<T>["data"]): Event | undefined {
    try {
      this.refresh();
      const parsed = EventSchema.safeParse({ id: this.last + 1, at: new Date().toISOString(), type, data });
      if (!parsed.success) {
        const [issue] = parsed.error.issues;
        log.error(`not appending an invalid ${type} event: ${issue?.path.map(String).join(".") ?? ""}: ${issue?.message ?? "invalid"}`);
        return undefined;
      }
      const event = parsed.data;
      const text = `${this.torn ? "\n" : ""}${JSON.stringify(event)}\n`;
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.file, text, { mode: 0o600 });
      this.last = event.id;
      this.seenSize += Buffer.byteLength(text);
      this.torn = false;
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch (err) {
          log.error(`an event listener failed on ${event.type} ${event.id}: ${describeError(err)}`);
        }
      }
      return event;
    } catch (err) {
      // The file may now end in a partial line: read it again before the next append.
      this.seenSize = -1;
      log.error(`appending a ${type} event failed: ${describeError(err)}`);
      return undefined;
    }
  }

  /** Events with an id above `afterId`, oldest first, at most `limit` of them. */
  readSince(afterId: number, limit = DEFAULT_READ_LIMIT): Event[] {
    // Reads the whole file, which is acceptable for now: the log holds only durable events.
    const events: Event[] = [];
    for (const event of parseLog(readFile(this.file), this.file)) {
      if (event.id <= afterId) continue;
      if (events.length === limit) break;
      events.push(event);
    }
    return events;
  }

  /** Calls `listener` after each append. The returned function stops it. */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private refresh(): void {
    const size = fileSize(this.file);
    if (size === this.seenSize) return;
    const text = readFile(this.file);
    this.last = parseLog(text, this.file).at(-1)?.id ?? 0;
    this.torn = text !== "" && !text.endsWith("\n");
    this.seenSize = size;
  }
}

let shared: EventLog | undefined;

/** The log production code appends to. Created on first use. */
export function sharedEventLog(): EventLog {
  shared ??= new EventLog();
  return shared;
}

/** The valid events in a log's text, in file order. Other lines are skipped with a warning. */
function parseLog(text: string, file: string): Event[] {
  const events: Event[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const event = parseEvent(line);
    if (event) events.push(event);
    else log.warn(`skipping a line of ${file} that is not a valid event (a write cut short by a crash?)`);
  }
  return events;
}

function parseEvent(line: string): Event | undefined {
  try {
    const parsed = EventSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The file's text; empty when there is no file yet. */
function readFile(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/** The file's size in bytes; 0 when there is no file yet. */
function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
}
