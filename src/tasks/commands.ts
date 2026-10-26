// The task commands of the command API (see TaskCommands in src/api/server.ts) on the task store and the agent
// handler: creating and changing tasks goes to the store, and a run now goes to the handler's queue.

import type { TaskCommands, TaskReply } from "../api/server.ts";
import { InvalidTask } from "./store.ts";
import type { TaskStore } from "./store.ts";

/** What starts a run of a task now: the agent handler. */
export interface TaskRunner {
  /** Queues a run of the task; false when there is no such task. */
  runTask(taskId: string): boolean;
}

/** A change the store refuses for the moment's sake is the owner's to fix, so it is a 400 with the store's own message. */
function answer(change: () => TaskReply): TaskReply {
  try {
    return change();
  } catch (err) {
    if (err instanceof InvalidTask) return { ok: false, status: 400, error: err.message };
    throw err;
  }
}

export function taskCommands(store: TaskStore, runner: TaskRunner): TaskCommands {
  return {
    create: ({ title, brief, schedule, model, budgetUsd }) =>
      answer(() => ({ ok: true, task: store.create({ title, brief, schedule, model, budgetUsd }, "manual") })),
    update: ({ taskId, title, brief, schedule, model, budgetUsd, status }) =>
      answer(() => {
        const task = store.update(taskId, { title, brief, schedule, model, budgetUsd, status });
        return task ? { ok: true, task } : { ok: false, status: 404, error: `no task ${taskId}` };
      }),
    run: (taskId) => runner.runTask(taskId),
  };
}
