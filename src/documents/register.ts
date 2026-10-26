// Registering a delivered file as a document: the commit that gives it a version, and its entry in the document store.
// The versions repository (versions.ts) and the store (store.ts) know nothing of each other; this is where they meet.

import fs from "node:fs";

import type { DeliveredDocument } from "../channels.ts";
import { type DocumentStore, documentKind, documentTitle } from "./store.ts";
import { VERSION_MAX_BYTES, type Versions } from "./versions.ts";

/** What the handler, its tools and everything else that works on documents share: one history of the workspace and one document store. */
export interface Documents {
  versions: Versions;
  store: DocumentStore;
}

/** What a delivery registers: the file's workspace path and where it is, its size, and the run (and task) that delivers it. */
export interface DeliveredFile {
  /** Relative to the workspace. */
  path: string;
  abs: string;
  size: number;
  runId?: string;
  taskId?: string;
}

/** The title a file gives its document: the one in its content for Markdown and HTML (which are the only files read), else its name. */
export function fileTitle(workspacePath: string, abs: string): string {
  const kind = documentKind(workspacePath);
  return documentTitle(workspacePath, kind === "markdown" || kind === "html" ? fs.readFileSync(abs, "utf8") : undefined);
}

/**
 * Makes the delivered file a document, or adds a version to the one it already is: the file is committed with the run
 * in the message, whatever its type, and the document is at that commit. When there is nothing to commit the file is
 * as the workspace's history already holds it: the document's own version if the file still matches it (so delivering a
 * file again unchanged adds no version), else the latest commit. Resolves to the document and version the send carries,
 * or to undefined for a file over the size that is versioned, which is delivered without one. Rejects when the file
 * cannot be committed or registered; the caller then delivers it without a document.
 */
export async function deliverDocument(documents: Documents, file: DeliveredFile): Promise<DeliveredDocument | undefined> {
  if (file.size > VERSION_MAX_BYTES) return undefined;
  const { versions, store } = documents;
  const title = fileTitle(file.path, file.abs);
  const commit = await versions.commit(`Deliver ${file.path}${file.runId ? ` (run ${file.runId})` : ""}`, { paths: [file.path], force: [file.path] });
  const version = commit?.version ?? (await unchangedVersion(documents, file.path));
  const document = store.deliver({ path: file.path, version, runId: file.runId, taskId: file.taskId, title, kind: documentKind(file.path) });
  return { documentId: document.id, version };
}

/** The version a file is at when a delivery found nothing to commit; throws when no commit holds the file as it is. */
async function unchangedVersion({ versions, store }: Documents, workspacePath: string): Promise<string> {
  const current = store.byPath(workspacePath)?.version;
  if (current !== undefined) {
    // A version the repository no longer knows is as good as one the file has left.
    const matches = await versions.differs(current, [workspacePath]).then((differing) => differing.length === 0, () => false);
    if (matches) return current;
  }
  const head = await versions.head();
  if (!head) throw new Error("the workspace has no version yet");
  if ((await versions.differs(head, [workspacePath])).length > 0) throw new Error(`${workspacePath} is not as the workspace's latest version holds it`);
  return head;
}
