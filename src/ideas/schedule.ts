// The daily generation of ideas: once the local time reaches ALFRED_IDEAS_AT on a day that has not had its scheduled
// generation, one is started, checked at startup and then every minute. The day is recorded in
// $STATE_DIR/ideas-schedule.json once a generation has started or the day was skipped for lateness or for the ideas
// already open, so a restart does not run it twice. A refusal (the cap is reached, a generation runs, Alfred is
// closing) leaves the day open: the next check tries again.

import path from "node:path";

import { parseIdeasAt } from "../agent/config.ts";
import type { IdeaGenerationAccepted, IdeaTrigger } from "../api/schema.ts";
import type { IdeaReply } from "../api/server.ts";
import { humanAge, localDate } from "../files.ts";
import { describeError, log } from "../log.ts";
import { STATE_DIR, readJson, writeJson } from "../store.ts";
import { MISSED_RUN_MS } from "../tasks/schedule.ts";
import type { IdeaStore } from "./store.ts";

export const IDEAS_SCHEDULE_FILE = path.join(STATE_DIR, "ideas-schedule.json");
/** With this many ideas open, the day's generation is skipped. */
export const OPEN_IDEAS_SKIP = 5;
const CHECK_MS = 60_000;

export interface DailyIdeasOptions {
  /** The time of day, HH:MM in the process's time zone, which is the owner's. Undefined turns the daily generation off. */
  at: string | undefined;
  ideas: Pick<IdeaStore, "list">;
  /** Starts a generation, told what started it (always the daily schedule): the handler's generateIdeas. */
  generate: (trigger: IdeaTrigger) => IdeaReply<IdeaGenerationAccepted>;
  /** The file that records the last day done; ideas-schedule.json in the state directory by default. */
  file?: string;
  now?: () => Date;
  /** How often it checks; a minute by default. */
  checkMs?: number;
}

/** The last day the file records as done; undefined when there is none, or the file cannot be read (it is written over). */
function readLastDay(file: string): string | undefined {
  try {
    const lastDay = readJson<{ lastDay?: unknown }>(file)?.lastDay;
    return typeof lastDay === "string" ? lastDay : undefined;
  } catch (err) {
    log.warn(`${file} cannot be read, so no day counts as done: ${describeError(err)}`);
    return undefined;
  }
}

/**
 * Starts the daily generation and returns a function that stops it. It checks at once and then every `checkMs`. The
 * timer does not keep the process alive. A failure of a check is logged and the timer goes on. With no time the
 * generation is off, and nothing is started. A time that is not HH:MM throws.
 */
export function startDailyIdeas({ at, ideas, generate, file = IDEAS_SCHEDULE_FILE, now = () => new Date(), checkMs = CHECK_MS }: DailyIdeasOptions): () => void {
  if (at === undefined) return () => {};
  const time = parseIdeasAt(at);
  if (time === undefined) return () => {};
  const hours = Number(time.slice(0, 2));
  const minutes = Number(time.slice(3, 5));
  let doneDay = readLastDay(file);
  /** The last reason said, so the same one is not said again every minute. */
  let said: string | undefined;

  const say = (day: string, text: string): void => {
    const line = `daily ideas ${day}: ${text}`;
    if (line === said) return;
    said = line;
    log.info(line);
  };
  const finishDay = (day: string): void => {
    // Remembered here too, so a write that fails cannot make the day run again.
    doneDay = day;
    try {
      writeJson(file, { lastDay: day });
    } catch (err) {
      log.error(`saving ${file} failed: ${describeError(err)}`);
    }
  };

  const check = (): void => {
    try {
      const current = now();
      const day = localDate(current);
      if (doneDay === day) return;
      const due = new Date(current.getFullYear(), current.getMonth(), current.getDate(), hours, minutes);
      if (current < due) return;
      const late = current.getTime() - due.getTime();
      if (late > MISSED_RUN_MS) {
        say(day, `skipped, ${humanAge(late)} late`);
        finishDay(day);
        return;
      }
      const open = ideas.list().filter((idea) => idea.state === "open").length;
      if (open >= OPEN_IDEAS_SKIP) {
        say(day, `skipped, ${open} open ideas`);
        finishDay(day);
        return;
      }
      const reply = generate("daily");
      if (!reply.ok) {
        say(day, `not started (${reply.error}), trying again on the next check`);
        return;
      }
      say(day, `started run ${reply.body.runId}`);
      finishDay(day);
    } catch (err) {
      log.error(`the daily ideas check failed: ${describeError(err)}`);
    }
  };

  check();
  const timer = setInterval(check, checkMs);
  timer.unref();
  return () => clearInterval(timer);
}
