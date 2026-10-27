// The owner's ideas, in $STATE_DIR/workbench/ideas.json, which only this store writes. An idea is a suggestion Alfred
// made from memory and recent conversations: open until the owner accepts it as a task or rejects it, or until it is
// archived unanswered. Every change is written at once and appended to the event log as idea.updated with the whole
// idea. Nothing here generates ideas, creates tasks or answers commands.

import path from "node:path";

import { type Idea, type IdeaList, IdeaListSchema, IdeaSchema, type Rejection } from "../api/schema.ts";
import { type EventLog, sharedEventLog } from "../events.ts";
import { log } from "../log.ts";
import { WORKBENCH_STATE_DIR, newRunId } from "../runs.ts";
import { readJson, writeJson } from "../store.ts";

export const IDEAS_FILE = path.join(WORKBENCH_STATE_DIR, "ideas.json");

const DAY_MS = 86_400_000;
/** An open idea created this long ago is archived. */
export const IDEA_ARCHIVE_MS = 7 * DAY_MS;
/** The most closed ideas (accepted, rejected or archived) the store keeps: the ones updated last. */
export const MAX_CLOSED_IDEAS = 200;

/** What a generation proposes: an idea before the store gives it an id, a state and its timestamps. */
export type IdeaDraft = Pick<Idea, "title" | "why" | "brief" | "kind" | "schedule" | "model" | "estimateUsd">;

/** A change to an idea that is not open. Its message says the state the idea is in. */
export class IdeaNotOpen extends Error {
  constructor(state: Idea["state"]) {
    super(`the idea is ${state}`);
  }
}

export interface IdeaStoreOptions {
  /** The ideas file. By default workbench/ideas.json under the state directory. */
  file?: string;
  events?: EventLog;
  now?: () => Date;
}

export class IdeaStore {
  private readonly file: string;
  private readonly events: EventLog;
  private readonly now: () => Date;
  /** Newest created first. A change replaces an idea's object, so an idea returned earlier does not change. */
  private ideas: Idea[];
  private generating: string | undefined;

  constructor({ file = IDEAS_FILE, events = sharedEventLog(), now = () => new Date() }: IdeaStoreOptions = {}) {
    this.file = file;
    this.events = events;
    this.now = now;
    const loaded = loadIdeas(file);
    this.ideas = loaded.ideas;
    this.generating = loaded.generatingRunId;
    // A generation left in the file was cut short by a restart, so it is not running.
    if (this.generating !== undefined) this.save(this.ideas, [], undefined);
  }

  list(): Idea[] {
    return [...this.ideas];
  }

  get(id: string): Idea | undefined {
    return this.ideas.find((idea) => idea.id === id);
  }

  /** The run that is generating ideas, when one is. */
  generatingRunId(): string | undefined {
    return this.generating;
  }

  /**
   * Adds the drafts as open ideas of the generation run, in front of the list in the order given, and returns them.
   * A draft the schema refuses is logged with the reason and left out; the others are added.
   */
  add(drafts: IdeaDraft[], runId: string): Idea[] {
    const stamp = this.now().toISOString();
    const taken = new Set(this.ideas.map((idea) => idea.id));
    const added: Idea[] = [];
    for (const draft of drafts) {
      const id = newRunId((candidate) => taken.has(candidate));
      const idea: Idea = {
        id,
        title: draft.title,
        why: draft.why,
        brief: draft.brief,
        kind: draft.kind,
        ...(draft.schedule ? { schedule: draft.schedule } : {}),
        model: draft.model,
        estimateUsd: draft.estimateUsd,
        state: "open",
        runId,
        createdAt: stamp,
        updatedAt: stamp,
      };
      const checked = IdeaSchema.safeParse(idea);
      if (!checked.success) {
        const [issue] = checked.error.issues;
        log.error(`not adding an idea of run ${runId}: ${issue?.path.map(String).join(".") ?? ""} ${issue?.message ?? "invalid"}`);
        continue;
      }
      taken.add(id);
      added.push(idea);
    }
    if (added.length === 0) return [];
    this.save([...added, ...this.ideas], added, this.generating);
    return added;
  }

  /** The open idea becomes accepted, with the task it made. Undefined when there is no such idea. */
  accept(id: string, taskId: string): Idea | undefined {
    const current = this.openIdea(id);
    if (!current) return undefined;
    const idea: Idea = { ...current, state: "accepted", taskId, updatedAt: this.now().toISOString() };
    this.save(this.replacing([idea]), [idea], this.generating);
    return idea;
  }

  /** The open idea becomes rejected, with the reason. Undefined when there is no such idea. */
  reject(id: string, rejection: Rejection): Idea | undefined {
    const current = this.openIdea(id);
    if (!current) return undefined;
    const idea: Idea = { ...current, state: "rejected", rejection, updatedAt: this.now().toISOString() };
    this.save(this.replacing([idea]), [idea], this.generating);
    return idea;
  }

  /** Archives every open idea created IDEA_ARCHIVE_MS or more ago, and returns them in list order. */
  archiveStale(): Idea[] {
    const now = this.now();
    const cutoff = now.getTime() - IDEA_ARCHIVE_MS;
    const stamp = now.toISOString();
    const archived = this.ideas
      .filter((idea) => idea.state === "open" && Date.parse(idea.createdAt) <= cutoff)
      .map((idea): Idea => ({ ...idea, state: "archived", updatedAt: stamp }));
    if (archived.length === 0) return [];
    this.save(this.replacing(archived), archived, this.generating);
    return archived;
  }

  /** Records that a generation of ideas is running. It is not an idea change, so no event is logged. */
  startGeneration(runId: string): void {
    this.save(this.ideas, [], runId);
  }

  /** Clears the running generation when it is this run's. A run that is not recorded finishes nothing. */
  finishGeneration(runId: string): void {
    if (this.generating !== runId) return;
    this.save(this.ideas, [], undefined);
  }

  /** The idea with the id when it is open; undefined when there is none, and IdeaNotOpen when it is closed. */
  private openIdea(id: string): Idea | undefined {
    const current = this.get(id);
    if (current && current.state !== "open") throw new IdeaNotOpen(current.state);
    return current;
  }

  /** The ideas with the changed ones in their places. */
  private replacing(changed: Idea[]): Idea[] {
    const byId = new Map(changed.map((idea): [string, Idea] => [idea.id, idea]));
    return this.ideas.map((idea) => byId.get(idea.id) ?? idea);
  }

  /**
   * Checks the changed ideas, then writes the ideas and the running generation, pruned, and tells the log of each
   * change. The list is kept in memory only once the file is written.
   */
  private save(ideas: Idea[], changed: Idea[], generating: string | undefined): void {
    for (const idea of changed) IdeaSchema.parse(idea);
    const kept = prune(ideas);
    writeJson(this.file, { ideas: kept, ...(generating ? { generatingRunId: generating } : {}) });
    this.ideas = kept;
    this.generating = generating;
    for (const idea of changed) this.events.append("idea.updated", idea);
  }
}

/**
 * The ideas to keep, in their order: every open one, and the MAX_CLOSED_IDEAS closed ones updated last. Among ideas
 * updated at the same moment, the earlier in the list is kept.
 */
function prune(ideas: Idea[]): Idea[] {
  const closed = ideas.filter((idea) => idea.state !== "open");
  const kept = new Set(closed.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, MAX_CLOSED_IDEAS));
  return ideas.filter((idea) => idea.state === "open" || kept.has(idea));
}

/**
 * The ideas in the file, newest created first, and the generation a restart cut short, if any. A missing file holds
 * none. A file that is not an idea list is an error: starting over would lose the ideas.
 */
function loadIdeas(file: string): IdeaList {
  let raw: unknown;
  try {
    raw = readJson<unknown>(file);
  } catch (err) {
    if (err instanceof SyntaxError) throw new Error(`${file} is not valid JSON: ${err.message}`);
    throw err;
  }
  if (raw === undefined) return { ideas: [] };
  const parsed = IdeaListSchema.safeParse(raw);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    throw new Error(`${file} is not an idea list: ${issue?.path.map(String).join(".") ?? ""} ${issue?.message ?? ""}`.trim());
  }
  const ideas = parsed.data.ideas.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return { ideas, generatingRunId: parsed.data.generatingRunId };
}
