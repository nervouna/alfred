// The handler the local scripts run: the real agent handler on the app channel, as `run` builds it.
// A reply to the owner is a message.created event, which is its delivery; the scripts follow the event
// log, and talk to the handler through the command API (src/api/server.ts), which each script starts
// itself. handler-smoke.ts and app-dev.ts both build their handler here.

import { createAgentHandler } from "../src/agent/handler.ts";
import type { AgentHandler } from "../src/agent/handler.ts";
import { appOutbound } from "../src/channels.ts";

/** The agent handler for the owner, with the app as its only channel. */
export function createLocalHandler(): AgentHandler {
  return createAgentHandler({ out: appOutbound() });
}
