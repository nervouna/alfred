// The boundary between the agent and the app the owner talks to it from.
//
// The channel takes Alfred's output (Outbound) and hands the owner's messages in
// (Inbound). Delivery on the app channel is the message.created event itself, so
// its Outbound sends nothing. Every message in either direction is recorded as
// that event; recorded() and recordInbound() do it.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Channel, FileRef } from "./api/schema.ts";
import type { EventLog } from "./events.ts";
import { describeError, log } from "./log.ts";

export type FileKind = NonNullable<FileRef["kind"]>;

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v"]);

/** How a sent file shows in its event: an image, a video or a file, by its extension. */
export function outboundKind(fileName: string): FileKind {
  const ext = path.extname(fileName).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  return "file";
}

/** Where Alfred's output to the owner goes. */
export interface Outbound {
  readonly channel: Channel;
  /** Rejects when the channel refuses the message. */
  text(text: string): Promise<void>;
  /** Sends the file at an absolute path, after `caption` as a message of its own. Returns how the channel sent it. */
  file(absPath: string, caption?: string): Promise<FileKind>;
}

/** A message from the owner. */
export interface Inbound {
  text: string;
  /** Files saved for this message, relative to the workspace. */
  files: FileRef[];
  /** The id the client gave the message; echoed on its event. */
  clientId?: string;
}

/** What the channel talks to: the owner's intake queue. */
export interface Intake {
  /** Queues a message behind those that arrived before it; resolves once intake for it is done. */
  submit(inbound: Inbound): Promise<void>;
  /** Stops a live run of the owner's (the task, one of its background subagents, or a queued one) and says so. False when there is no such run. */
  stopRun(runId: string): Promise<boolean>;
  /**
   * Answers an open question with `answers`, keyed by the texts of its questions. False when no such question is open.
   * Rejects with InvalidAnswer, leaving the question open, when a key is not the text of one of its questions.
   */
  answerQuestion(id: string, answers: Record<string, string>): Promise<boolean>;
}

/** An answer to a question keyed by something that is not the text of one of the question's questions. */
export class InvalidAnswer extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAnswer";
  }
}

/** The app channel: nothing is sent anywhere, the message event is the delivery. */
export function appOutbound(): Outbound {
  return {
    channel: "app",
    async text() {},
    async file(absPath) {
      return outboundKind(absPath);
    },
  };
}

/** Runs tasks one at a time in the order they were added. A task that fails is logged and does not stop the queue. */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  run(task: () => Promise<void>): Promise<void> {
    const next = this.tail.then(task).catch((err) => log.error(`handler failed: ${describeError(err)}`));
    this.tail = next;
    return next;
  }
}

/** The path as the event shows it: relative to the workspace. */
function workspaceRelative(workspace: string, absPath: string): string {
  const outside = (rel: string) => rel === ".." || rel.startsWith(`..${path.sep}`);
  let real = workspace;
  try {
    real = fs.realpathSync(workspace);
  } catch {
    // The plain path is all there is.
  }
  const rel = path.relative(real, absPath);
  return outside(rel) ? path.relative(workspace, absPath) : rel;
}

function recordMessage(
  events: EventLog,
  message: { channel: Channel; direction: "in" | "out"; text: string; files: FileRef[]; runId?: string; clientId?: string; error?: string },
): void {
  // A voice note without a transcript, or media that failed to save, leaves nothing to show.
  if (!message.text.trim() && message.files.length === 0) return;
  const { runId, clientId, error, ...rest } = message;
  events.append("message.created", {
    id: crypto.randomUUID(),
    ...rest,
    at: new Date().toISOString(),
    ...(runId ? { runId } : {}),
    ...(clientId ? { clientId } : {}),
    ...(error ? { error } : {}),
  });
}

/** Records a message from the owner on `channel`, with its files and the run it started or steered, if any. */
export function recordInbound(events: EventLog, channel: Channel, inbound: Inbound, runId?: string): void {
  recordMessage(events, { channel, direction: "in", text: inbound.text, files: inbound.files, runId, clientId: inbound.clientId });
}

/**
 * Records what is sent through `out` as outbound messages, after each attempt,
 * with the error when the channel refused it. A caption and its file are two
 * messages.
 */
export function recorded(out: Outbound, events: EventLog, opts: { workspace: string; runId?: string }): Outbound {
  const record = (text: string, files: FileRef[], error?: string) =>
    recordMessage(events, { channel: out.channel, direction: "out", text, files, runId: opts.runId, error });
  const text = async (body: string): Promise<void> => {
    try {
      await out.text(body);
    } catch (err) {
      record(body, [], describeError(err));
      throw err;
    }
    record(body, []);
  };
  return {
    channel: out.channel,
    text,
    async file(absPath, caption) {
      if (caption) await text(caption);
      const ref = (kind: FileKind): FileRef => ({ path: workspaceRelative(opts.workspace, absPath), kind });
      let kind: FileKind;
      try {
        kind = await out.file(absPath);
      } catch (err) {
        record("", [ref(outboundKind(absPath))], describeError(err));
        throw err;
      }
      record("", [ref(kind)]);
      return kind;
    },
  };
}
