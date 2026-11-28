// The owner's bots, in $STATE_DIR/workbench/bots.json, which only this store writes. A bot is a role with its own
// instructions, model, run budget and tools. Every change is written at once and appended to the event log as
// bot.updated with the whole bot. Nothing here runs a bot or creates its folder: bots are never removed.

import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { ZodError } from "zod";

import { type Bot, BotListSchema, BotSchema, type BotList, DEFAULT_BOT_ID } from "../api/schema.ts";
import { type EventLog, sharedEventLog } from "../events.ts";
import { describeError } from "../log.ts";
import { WORKBENCH_STATE_DIR } from "../runs.ts";
import { readJson, writeJson } from "../store.ts";

export const BOTS_FILE = path.join(WORKBENCH_STATE_DIR, "bots.json");

/** A change the schema does not allow, or an id that is taken or unknown. Its message is for the owner. */
export class InvalidBot extends Error {}

export interface BotStoreOptions {
  /** The bots file. By default workbench/bots.json under the state directory. */
  file?: string;
  events?: EventLog;
  now?: () => Date;
}

/** What create() takes: every field of a Bot but its times. */
export type BotInput = Omit<Bot, "createdAt" | "updatedAt">;

/** What update() sets. A field left out keeps its value. */
export type BotChanges = Partial<Pick<Bot, "name" | "description" | "instructions" | "model" | "runBudgetUsd" | "tools">>;

const CHANGEABLE = ["name", "description", "instructions", "model", "runBudgetUsd", "tools"] as const;

export class BotStore {
  private readonly file: string;
  private readonly events: EventLog;
  private readonly now: () => Date;
  /** Oldest created first. A change replaces a bot's object, so a bot returned earlier does not change. */
  private bots: Bot[];

  constructor({ file = BOTS_FILE, events = sharedEventLog(), now = () => new Date() }: BotStoreOptions = {}) {
    this.file = file;
    this.events = events;
    this.now = now;
    this.bots = loadBots(file);
  }

  list(): Bot[] {
    return [...this.bots];
  }

  get(id: string): Bot | undefined {
    return this.bots.find((bot) => bot.id === id);
  }

  /** A new bot, with both times set to now. Its id is fixed from here on. */
  create(input: BotInput): Bot {
    if (input.id === DEFAULT_BOT_ID) throw new InvalidBot(`"${DEFAULT_BOT_ID}" is the default bot, not a bot that can be created.`);
    if (this.get(input.id)) throw new InvalidBot(`A bot with the id "${input.id}" already exists.`);
    const stamp = this.now().toISOString();
    const parsed = BotSchema.safeParse({ ...input, createdAt: stamp, updatedAt: stamp });
    if (!parsed.success) throw new InvalidBot(schemaMessage(parsed.error));
    return this.save(parsed.data, true);
  }

  /**
   * Changes the bot and returns it. A change that sets every field to the value it has is a no-op: nothing is written
   * or logged, and the bot is returned as it is.
   */
  update(id: string, changes: BotChanges): Bot {
    const current = this.get(id);
    if (!current) throw new InvalidBot(`There is no bot with the id "${id}".`);
    const fields = Object.fromEntries(CHANGEABLE.filter((key) => changes[key] !== undefined).map((key) => [key, changes[key]])) as BotChanges;
    const unchanged = CHANGEABLE.every((key) => fields[key] === undefined || isDeepStrictEqual(fields[key], current[key]));
    if (unchanged) return current;
    const parsed = BotSchema.safeParse({ ...current, ...fields, updatedAt: this.now().toISOString() });
    if (!parsed.success) throw new InvalidBot(schemaMessage(parsed.error));
    return this.save(parsed.data, false);
  }

  /** Checks nothing further: the caller has parsed the bot. Writes the whole list, then tells the log. */
  private save(bot: Bot, isNew: boolean): Bot {
    const bots = isNew ? [...this.bots, bot] : this.bots.map((other) => (other.id === bot.id ? bot : other));
    const list: BotList = { bots };
    writeJson(this.file, list);
    this.bots = bots;
    this.events.append("bot.updated", bot);
    return bot;
  }
}

/** The first problem the schema found, in words for the owner. */
function schemaMessage(error: ZodError): string {
  const [issue] = error.issues;
  return `${issue?.path.map(String).join(".") ?? ""} ${issue?.message ?? "is invalid"}`.trim();
}

/**
 * The bots in the file, oldest created first. A missing file holds none. A file that cannot be read or is not a bot
 * list is an error, naming the file: starting over would lose the bots.
 */
function loadBots(file: string): Bot[] {
  let raw: unknown;
  try {
    raw = readJson<unknown>(file);
  } catch (err) {
    throw new Error(`cannot read ${file}: ${describeError(err)}`);
  }
  if (raw === undefined) return [];
  const parsed = BotListSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${file} is not a bot list: ${schemaMessage(parsed.error)}`);
  return parsed.data.bots;
}
