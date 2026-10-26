// The handler the local scripts run: the real agent handler on the app channel, as `run` builds it.
// A reply to the owner is a message.created event, which is its delivery; the scripts follow the event
// log, and talk to the handler through the command API (src/api/server.ts), which each script starts
// itself. handler-smoke.ts and app-dev.ts both build their handler here; a script that serves the task
// commands makes the task store itself, as `run` does, and passes it in.

import { createAgentHandler } from "../src/agent/handler.ts";
import type { AgentHandler } from "../src/agent/handler.ts";
import { appOutbound } from "../src/channels.ts";
import type { TaskStore } from "../src/tasks/store.ts";

/** The agent handler for the owner, with the app as its only channel. With a task store it runs the tasks when they fall due, polling every `taskPollMs` (30 s by default). */
export function createLocalHandler(options: { tasks?: TaskStore; taskPollMs?: number } = {}): AgentHandler {
  return createAgentHandler({ out: appOutbound(), ...options });
}
