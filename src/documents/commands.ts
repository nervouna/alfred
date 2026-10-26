// The document commands of the command API (see DocumentCommands in src/api/server.ts): a batch of annotations starts a
// revision run, which the handler queues beside the chat and the task runs, and an undo puts a revision's files back
// from git (see Versions in versions.ts). Both run one at a time in one lane, so an undo's checks and restore never
// interleave with a batch being recorded or with another undo.

import type { DocumentCommands, DocumentReply } from "../api/server.ts";
import type { DocumentResult, DocumentRevise, DocumentUndo, RevisionAccepted } from "../api/schema.ts";
import { describeError, log } from "../log.ts";
import type { Documents } from "./register.ts";

/** What takes a batch and starts its revision run: the agent handler. */
export interface RevisionRunner {
  /** Records the batch and queues its run, or refuses it. */
  reviseDocument(command: DocumentRevise): DocumentReply<RevisionAccepted>;
}

/** Runs each job after the ones started before it have settled. */
function lane(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const result = tail.then(job);
    tail = result.catch(() => undefined);
    return result;
  };
}

/**
 * Undoes the revision the command names, or refuses it. Refused, with nothing changed: 404 for a document or a run that
 * made no revision of it, 409 when that revision is not the document's current version, when a batch on the document is
 * queued or running, or when a file the revision changed differs from its commit. Otherwise the files the revision
 * changed go back to their content at the revision's parent commit, are committed as "Undo revision <run id>", every
 * document among them gets an undone version, and the batch's annotations go back to the owner as undone.
 *
 * A failure before the commit puts the revision's files back, records nothing and answers 500 with the error. A failure
 * after the commit answers 500 too, but leaves the files as the undo put them: the undo is then in the history.
 */
async function undoRevision(documents: Documents, { documentId, runId }: DocumentUndo): Promise<DocumentReply<DocumentResult>> {
  const { versions, store } = documents;
  const document = store.get(documentId);
  if (!document) return { ok: false, status: 404, error: "no such document" };
  const revision = store.versions(documentId)?.find((version) => version.reason === "revised" && version.runId === runId);
  if (!revision) return { ok: false, status: 404, error: "no such revision of this document" };
  if (document.version !== revision.version) return { ok: false, status: 409, error: "only the latest revision can be undone" };
  if (store.revisionOf(documentId) !== undefined) return { ok: false, status: 409, error: "a revision of this document is queued or running" };
  const files = await versions.changedFiles(revision.version);
  const changed = await versions.differs(revision.version, files);
  if (changed.length > 0) return { ok: false, status: 409, error: `files changed since the revision: ${changed.join(", ")}` };

  let committed = false;
  try {
    const parent = await versions.parent(revision.version);
    if (parent === undefined) throw new Error(`revision ${revision.version} has no parent to undo to`);
    await versions.restore(parent, files);
    // Forced: the files are the ones the history already held, so the rules that leave new files out of a commit do not apply.
    const commit = await versions.commit(`Undo revision ${runId}`, { paths: files, force: files });
    if (!commit) throw new Error(`the undo of revision ${runId} changed nothing`);
    committed = true;
    store.recordVersion({ paths: commit.files, version: commit.version, at: new Date(commit.at), reason: "undone", undoes: runId });
    store.returnUndone(runId);
    const updated = store.get(documentId);
    if (!updated) throw new Error(`document ${documentId} vanished during its undo`);
    log.info(`undid revision ${runId} of ${document.path} as ${commit.version.slice(0, 8)}: ${commit.files.length} file(s) back to ${parent.slice(0, 8)}`);
    return { ok: true, body: { document: updated } };
  } catch (err) {
    const message = describeError(err);
    log.error(`undoing revision ${runId} of ${document.path} failed: ${message}`);
    if (!committed) {
      await versions.restore(revision.version, files).catch((restoreErr: unknown) => {
        log.error(`putting back the files of revision ${runId} failed: ${describeError(restoreErr)}`);
      });
    }
    return { ok: false, status: 500, error: message };
  }
}

/**
 * The document commands. `revise` is the runner's; `undo` is there only with the documents (without them the API
 * answers document.undo with 503). Both go through one lane, in the order they are called.
 */
export function documentCommands(runner: RevisionRunner, documents?: Documents): DocumentCommands {
  const inLane = lane();
  return {
    revise: (command) => inLane(async () => runner.reviseDocument(command)),
    ...(documents ? { undo: (command) => inLane(() => undoRevision(documents, command)) } : {}),
  };
}
