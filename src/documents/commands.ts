// The document commands of the command API (see DocumentCommands in src/api/server.ts) on the agent handler: a batch
// of annotations starts a revision run, which the handler queues beside the chat and the task runs. Undo is not here yet,
// so the API answers document.undo with 503.

import type { DocumentCommands, DocumentReply } from "../api/server.ts";
import type { DocumentRevise, RevisionAccepted } from "../api/schema.ts";

/** What takes a batch and starts its revision run: the agent handler. */
export interface RevisionRunner {
  /** Records the batch and queues its run, or refuses it. */
  reviseDocument(command: DocumentRevise): DocumentReply<RevisionAccepted>;
}

export function documentCommands(runner: RevisionRunner): DocumentCommands {
  return {
    revise: (command) => runner.reviseDocument(command),
  };
}
