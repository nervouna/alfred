// Live input for one agent task (streaming input mode).
//
// The task prompt and every follow-up the user sends while the task runs are
// fed to a single query() through this iterable. Claude Code folds a follow-up
// into the running turn at the next tool-round boundary, or runs it as a turn
// of its own after the current one. Each result names the messages it
// answered, and the input closes once nothing is left unanswered and the
// caller has nothing else to wait for (background subagents still running), so
// the query can end. A push after that is refused and the caller starts the
// next task with it: a message is either answered in this query or becomes
// the next task, never lost in between.

import { randomUUID } from "node:crypto";

import type { SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

interface Entry {
  uuid: ReturnType<typeof randomUUID>;
  text: string;
  /** Sent by the user while the task ran; system messages from Alfred are not. */
  followUp: boolean;
  delivered: boolean;
}

/** Messages a result answered: every message folded into its turn, or just the one that started it. */
export function answeredBy(result: SDKResultMessage): string[] {
  return result.user_message_uuids ?? (result.user_message_uuid ? [result.user_message_uuid] : []);
}

export class TaskInput implements AsyncIterable<SDKUserMessage> {
  /** Pushed and not yet answered, in push order. */
  private entries: Entry[] = [];
  private open = true;
  /** Bumped by rewind() to end the iteration in progress. */
  private generation = 0;
  private wake: (() => void) | undefined;
  /** True while the caller still waits on work outside the input, which keeps it open with nothing pending. */
  private readonly keepOpen: () => boolean;

  constructor(prompt: string, opts: { keepOpen?: () => boolean } = {}) {
    this.keepOpen = opts.keepOpen ?? (() => false);
    this.add(prompt, false);
  }

  get closed(): boolean {
    return !this.open;
  }

  /** Messages not answered by a result yet, the task prompt included. */
  get pending(): number {
    return this.entries.length;
  }

  /** Follow-ups not answered by a result yet. */
  get followUps(): number {
    return this.entries.filter((e) => e.followUp).length;
  }

  /** Hand a follow-up to the running query. False once the input is closed: start the next task with it instead. */
  push(text: string): boolean {
    if (!this.open) return false;
    this.add(text, true);
    return true;
  }

  /** Hand the agent a message from Alfred itself, not a follow-up; returns its uuid, or undefined once closed. */
  pushSystem(text: string): string | undefined {
    return this.open ? this.add(text, false) : undefined;
  }

  isPending(uuid: string): boolean {
    return this.entries.some((e) => e.uuid === uuid);
  }

  /**
   * Record a result by the uuids of the messages it answered (see answeredBy).
   * A result without uuids answers the oldest delivered message, unless it
   * ended a turn that a background task's notification started, which answers
   * none. Closes the input once nothing is pending (see closeIfIdle) and
   * returns whether it is closed.
   */
  settle(uuids: readonly string[], opts: { notification?: boolean } = {}): boolean {
    if (uuids.length) {
      this.entries = this.entries.filter((e) => !uuids.includes(e.uuid));
    } else if (!opts.notification) {
      const oldest = this.entries.findIndex((e) => e.delivered);
      if (oldest >= 0) this.entries.splice(oldest, 1);
    }
    return this.closeIfIdle();
  }

  /** Close once nothing is pending and the caller waits on nothing else; returns whether it is closed. */
  closeIfIdle(): boolean {
    if (this.open && !this.entries.length && !this.keepOpen()) this.close();
    return !this.open;
  }

  /** Refuse further pushes and end the iteration. Unanswered messages still count as pending. */
  close(): void {
    this.open = false;
    this.notify();
  }

  /** End the iteration in progress; the next one delivers every unanswered message again, for a retry in a new query. */
  rewind(): void {
    this.generation++;
    for (const e of this.entries) e.delivered = false;
    this.notify();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    const generation = this.generation;
    while (this.open && generation === this.generation) {
      const next = this.entries.find((e) => !e.delivered);
      if (!next) {
        await new Promise<void>((resolve) => (this.wake = resolve));
        continue;
      }
      next.delivered = true;
      yield { type: "user", message: { role: "user", content: next.text }, parent_tool_use_id: null, uuid: next.uuid };
    }
  }

  private add(text: string, followUp: boolean): string {
    const uuid = randomUUID();
    this.entries.push({ uuid, text, followUp, delivered: false });
    this.notify();
    return uuid;
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}
