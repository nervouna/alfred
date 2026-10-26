// What Alfred does about the workspace's history and the owner's documents when it starts, before the API and the
// scheduler: it opens the repository, commits what changed while it was not running, and, the first time, makes the
// files it delivered before documents existed into documents.

import fs from "node:fs";
import path from "node:path";

import { resolveInside } from "../agent/guard.ts";
import { type EventLog, sharedEventLog } from "../events.ts";
import { describeError, log } from "../log.ts";
import { WORKSPACE_DIR } from "../store.ts";
import { type Documents, fileTitle } from "./register.ts";
import { DOCUMENTS_FILE, DocumentStore, documentKind } from "./store.ts";
import { VERSIONS_GIT_DIR, VERSION_MAX_BYTES, Versions } from "./versions.ts";

export interface StartDocumentsOptions {
  /** The workspace; ALFRED_WORKSPACE by default. */
  workspace?: string;
  /** The git dir of its history; workbench/versions.git under the state dir by default. */
  gitDir?: string;
  /** The documents file; workbench/documents.json under the state dir by default. */
  file?: string;
  /** The log the documents' events go to and earlier deliveries are read from; the shared event log by default. */
  events?: EventLog;
}

const STARTUP_MESSAGE = "Changes found at startup";
const IMPORT_MESSAGE = "Import files delivered before documents";

/** A file an earlier outbound message on the app channel delivered, with the message's time and run. */
interface EarlierDelivery {
  path: string;
  at: Date;
  runId?: string;
  taskId?: string;
}

/**
 * Creates the one Versions and the one DocumentStore the process shares, then:
 * - opens the repository (init);
 * - commits whatever changed while Alfred was not running, as "Changes found at startup", and gives the documents among
 *   those files a changed version;
 * - when there is no documents file yet, imports the files earlier deliveries named: every one of an outbound app
 *   message in the event log that still exists in the workspace and is at most VERSION_MAX_BYTES goes into one commit,
 *   "Import files delivered before documents", forced in whatever its type, and becomes a document in event-log order,
 *   at that message's time and run. A file named more than once is one document; WeChat messages are skipped.
 * A failure is logged and resolves to undefined: Alfred then runs without documents, and delivers files as before.
 */
export async function startDocuments(options: StartDocumentsOptions = {}): Promise<Documents | undefined> {
  const workspace = options.workspace ?? WORKSPACE_DIR;
  const gitDir = options.gitDir ?? VERSIONS_GIT_DIR;
  const file = options.file ?? DOCUMENTS_FILE;
  const events = options.events ?? sharedEventLog();
  try {
    // Asked before the store exists: only a first start finds no file.
    const first = !fs.existsSync(file);
    const versions = new Versions({ workspace, gitDir });
    const store = new DocumentStore({ file, events });
    await versions.init();
    const stopped = await versions.commit(STARTUP_MESSAGE);
    if (stopped) {
      store.recordVersion({ paths: stopped.files, version: stopped.version, at: new Date(stopped.at), reason: "changed" });
      log.info(`committed ${stopped.files.length} file(s) found changed at startup`);
    }
    if (first) await importEarlierDeliveries({ versions, store }, workspace, events);
    return { versions, store };
  } catch (err) {
    log.error(`versions and documents are off, files are delivered without them: ${describeError(err)}`);
    return undefined;
  }
}

/** The usable files of outbound app messages in the log, in the order they were sent. */
function earlierDeliveries(events: EventLog, workspace: string): EarlierDelivery[] {
  const found: EarlierDelivery[] = [];
  for (const event of events.readSince(0, Number.MAX_SAFE_INTEGER)) {
    if (event.type !== "message.created") continue;
    const message = event.data;
    if (message.channel !== "app" || message.direction !== "out") continue;
    for (const file of message.files) {
      if (!importable(workspace, file.path)) continue;
      found.push({ path: file.path, at: new Date(message.at), runId: message.runId, taskId: message.taskId });
    }
  }
  return found;
}

/** Whether a workspace path is a regular file inside the workspace that is small enough to be versioned, and not in a .git directory. */
function importable(workspace: string, workspacePath: string): boolean {
  if (workspacePath.split("/").some((segment) => segment.toLowerCase() === ".git")) return false;
  if (!resolveInside(workspace, workspacePath)) return false;
  try {
    const stat = fs.lstatSync(path.join(workspace, workspacePath));
    return stat.isFile() && stat.size <= VERSION_MAX_BYTES;
  } catch {
    return false;
  }
}

async function importEarlierDeliveries({ versions, store }: Documents, workspace: string, events: EventLog): Promise<void> {
  const deliveries = earlierDeliveries(events, workspace);
  if (deliveries.length === 0) return;
  const paths = [...new Set(deliveries.map((delivery) => delivery.path))];
  const commit = await versions.commit(IMPORT_MESSAGE, { paths, force: paths });
  const version = commit?.version ?? (await versions.head());
  if (!version) throw new Error("the workspace has no version yet");
  const titles = new Map<string, string>();
  for (const delivery of deliveries) {
    try {
      const title = titles.get(delivery.path) ?? fileTitle(delivery.path, path.join(workspace, delivery.path));
      titles.set(delivery.path, title);
      store.deliver({
        path: delivery.path,
        version,
        at: delivery.at,
        runId: delivery.runId,
        taskId: delivery.taskId,
        title,
        kind: documentKind(delivery.path),
      });
    } catch (err) {
      log.warn(`not importing ${delivery.path} as a document: ${describeError(err)}`);
    }
  }
  log.info(`imported ${store.list().length} document(s) from the ${paths.length} file(s) delivered before documents`);
}
