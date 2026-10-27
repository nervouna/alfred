// The idea commands of the command API (see IdeaCommands in src/api/server.ts) on the idea store and the task store:
// accepting an idea makes a task, and rejecting one records why. Generating ideas goes to the generation given in the
// options, as one the owner requested; without one it is refused with 503 until a generation is wired in.

import type { IdeaCommands } from "../api/server.ts";
import type { IdeaGenerationAccepted, IdeaTrigger, Rejection, Schedule } from "../api/schema.ts";
import type { IdeaReply } from "../api/server.ts";
import { InvalidTask, type TaskStore } from "../tasks/store.ts";
import { IdeaNotOpen, type IdeaStore } from "./store.ts";

/** A one-time task accepted without a schedule is due this long after it is accepted. */
const ACCEPTED_DELAY_MS = 60_000;

export interface IdeaCommandsOptions {
  /** The clock; the real one by default. */
  now?: () => Date;
  /** Starts a generation of ideas, told what started it. Without it, generating is refused with 503. */
  generate?: (trigger: IdeaTrigger) => IdeaReply<IdeaGenerationAccepted>;
}

/** Refused unless the idea exists and is open: 404 for an unknown one, 409 with the store's message for a closed one. */
function refuseUnlessOpen(store: IdeaStore, id: string): { ok: false; status: 404 | 409; error: string } | undefined {
  const idea = store.get(id);
  if (!idea) return { ok: false, status: 404, error: `no idea ${id}` };
  if (idea.state !== "open") return { ok: false, status: 409, error: new IdeaNotOpen(idea.state).message };
  return undefined;
}

export function ideaCommands(store: IdeaStore, tasks: TaskStore, options: IdeaCommandsOptions = {}): IdeaCommands {
  const now = options.now ?? (() => new Date());
  const { generate } = options;
  return {
    accept(command) {
      // The check, the task and the acceptance run with no await between them, so two accepts of one idea cannot both make a task.
      const refused = refuseUnlessOpen(store, command.ideaId);
      if (refused) return refused;
      const schedule: Schedule = command.schedule ?? { kind: "once", at: new Date(now().getTime() + ACCEPTED_DELAY_MS).toISOString() };
      let task;
      try {
        task = tasks.create({ title: command.title, brief: command.brief, schedule, model: command.model, budgetUsd: command.budgetUsd }, "idea");
      } catch (err) {
        // A task the store refuses for the moment's sake (a one-time time that has passed) is the owner's to fix: the idea stays open.
        if (err instanceof InvalidTask) return { ok: false, status: 400, error: err.message };
        throw err;
      }
      const idea = store.accept(command.ideaId, task.id);
      if (!idea) throw new Error(`idea ${command.ideaId} vanished during its acceptance`);
      return { ok: true, body: { idea, task } };
    },
    reject(command) {
      const refused = refuseUnlessOpen(store, command.ideaId);
      if (refused) return refused;
      const rejection: Rejection = command.note === undefined ? { reason: command.reason } : { reason: command.reason, note: command.note };
      const idea = store.reject(command.ideaId, rejection);
      if (!idea) throw new Error(`idea ${command.ideaId} vanished during its rejection`);
      return { ok: true, body: { idea } };
    },
    // An idea.generate command is the owner asking.
    generate: () => generate?.("requested") ?? { ok: false, status: 503, error: "idea generation is not available" },
  };
}
