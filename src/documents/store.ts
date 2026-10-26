// The owner's documents, in $STATE_DIR/workbench/documents.json, which only this store writes. A document is a file
// Alfred delivered, known by its workspace path. It has versions (commits of the workspace, newest first), the
// annotations the owner submitted on it and the replies of its revision runs. Every change is written at once and
// appended to the event log as document.updated or annotation.updated with the whole object. Nothing here runs an
// agent or makes a commit: the callers say which version a change is at.

import path from "node:path";

import { z } from "zod";

import {
  type Annotation,
  AnnotationSchema,
  type AnnotationTarget,
  type Document,
  DocumentSchema,
  type DocumentVersion,
  DocumentVersionSchema,
  MAX_DOCUMENT_TITLE_CHARS,
} from "../api/schema.ts";
import { type EventLog, sharedEventLog } from "../events.ts";
import { log } from "../log.ts";
import { WORKBENCH_STATE_DIR, newRunId } from "../runs.ts";
import { readJson, writeJson } from "../store.ts";

export const DOCUMENTS_FILE = path.join(WORKBENCH_STATE_DIR, "documents.json");

/** The most characters of a reply, as AnnotationReplySchema in src/api/schema.ts allows. */
const MAX_REPLY_CHARS = 4000;

export type DocumentKind = Document["kind"];

/** A document with its versions, newest first: the first is the document's current version. */
export interface DocumentEntry {
  document: Document;
  versions: DocumentVersion[];
}

/** What the file holds. Annotations are newest first, as the store keeps them. */
export interface DocumentFile {
  documents: DocumentEntry[];
  annotations: Annotation[];
}

const DocumentFileSchema = z.object({
  documents: z.array(
    z.object({
      document: DocumentSchema,
      versions: z.array(DocumentVersionSchema).min(1, "must have at least 1 version"),
    }),
  ),
  annotations: z.array(AnnotationSchema),
});

/**
 * The documents and annotations in the file, as stored; empty when there is no file. A file that is not a document
 * file is an error naming it, since starting over would lose the documents. The workbench reads the file through this.
 */
export function readDocumentFile(file: string = DOCUMENTS_FILE): DocumentFile {
  let raw: unknown;
  try {
    raw = readJson<unknown>(file);
  } catch (err) {
    if (err instanceof SyntaxError) throw new Error(`${file} is not valid JSON: ${err.message}`);
    throw err;
  }
  if (raw === undefined) return { documents: [], annotations: [] };
  const parsed = DocumentFileSchema.safeParse(raw);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    throw new Error(`${file} is not a document file: ${issue?.path.map(String).join(".") ?? ""} ${issue?.message ?? ""}`.trim());
  }
  return parsed.data;
}

const KINDS: [DocumentKind, string[]][] = [
  ["markdown", ["md", "markdown"]],
  ["text", ["txt", "json", "jsonl", "csv", "tsv", "log", "yaml", "yml", "xml", "js", "ts", "py", "sh", "css"]],
  ["html", ["html", "htm", "svg"]],
  ["pdf", ["pdf"]],
  ["image", ["png", "jpg", "jpeg", "gif", "webp", "heic"]],
];
const KIND_BY_EXTENSION = new Map<string, DocumentKind>(KINDS.flatMap(([kind, extensions]) => extensions.map((ext) => [ext, kind])));

/** The last segment of a workspace path: the file's name. */
function fileName(workspacePath: string): string {
  return workspacePath.split("/").pop() ?? workspacePath;
}

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * What a document at this workspace path is, by the extension of its name, in any case. It is the app's FileViewerKind
 * table: a name with no extension, or one that starts with a dot, is other.
 */
export function documentKind(workspacePath: string): DocumentKind {
  const name = fileName(workspacePath);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "other";
  return KIND_BY_EXTENSION.get(name.slice(dot + 1).toLowerCase()) ?? "other";
}

/**
 * The title of a document: for Markdown, the text of its first level-1 or level-2 heading; for HTML, its `<title>`.
 * The file name when there is none, or when `content` (the file's text) is not given. Whitespace is collapsed and the
 * title is cut to MAX_DOCUMENT_TITLE_CHARS characters.
 */
export function documentTitle(workspacePath: string, content?: string): string {
  const kind = documentKind(workspacePath);
  const found =
    content === undefined ? undefined : kind === "markdown" ? markdownHeading(content) : kind === "html" ? htmlTitle(content) : undefined;
  const title = collapse(found ?? "") || collapse(fileName(workspacePath));
  return [...title].slice(0, MAX_DOCUMENT_TITLE_CHARS).join("");
}

/** The first level-1 or level-2 ATX heading outside front matter and code fences. */
function markdownHeading(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  let start = 0;
  // Front matter is a block of its own at the top, between two `---` lines.
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) start = end + 1;
  }
  let fence: string | undefined;
  for (const line of lines.slice(start)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== undefined) {
      // A closing fence has the opening one's character, at least its length, and nothing else on the line.
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    const heading = /^ {0,3}#{1,2}(?:[ \t]+(.*))?$/.exec(line);
    if (!heading) continue;
    const title = collapse((heading[1] ?? "").replace(/(^|[ \t]+)#+[ \t]*$/, ""));
    if (title !== "") return title;
  }
  return undefined;
}

function htmlTitle(text: string): string | undefined {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(text);
  if (!match) return undefined;
  // &amp; goes last, so that &amp;lt; decodes once, to &lt;.
  const title = collapse((match[1] ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&"));
  return title === "" ? undefined : title;
}

export interface DocumentStoreOptions {
  /** The documents file. By default workbench/documents.json under the state directory. */
  file?: string;
  events?: EventLog;
  now?: () => Date;
}

/** A file a run delivered: its path, the commit it is at, and the title and kind read from it. */
export interface DeliverInput {
  path: string;
  version: string;
  at?: Date;
  runId?: string;
  taskId?: string;
  title: string;
  kind: DocumentKind;
}

/** The version a run's commit gives several documents. `undoes` is set exactly for an undo, and `runId` is not set for one. */
export interface RecordVersionInput {
  paths: string[];
  version: string;
  at?: Date;
  reason: "changed" | "revised" | "undone";
  runId?: string;
  undoes?: string;
}

/** One annotation of a batch: what it is on, and the owner's comment. */
export interface AnnotationDraft {
  target: AnnotationTarget;
  comment: string;
}

export interface SubmitInput {
  documentId: string;
  version: string;
  annotations: AnnotationDraft[];
  runId: string;
  at?: Date;
}

/** Why reply() did not answer an annotation. */
export type ReplyRefusal = "unknown" | "other-run" | "closed" | "blank" | "too-long";

export interface ReplyRefused {
  refused: ReplyRefusal;
}

/** How a revision run ended. */
export type RevisionOutcome = "done" | "stopped" | "failed";

/**
 * submit() refused a batch. `status` is the HTTP status the command layer answers with; the message is for the owner.
 * Its three cases: 404 for an unknown document, 409 for a version that is not current or a second revision, 400 for a
 * passage on a document that is neither Markdown nor text.
 */
export class DocumentRefused extends Error {
  readonly status: 400 | 404 | 409;

  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = "DocumentRefused";
    this.status = status;
  }
}

export class DocumentStore {
  private readonly file: string;
  private readonly events: EventLog;
  private readonly now: () => Date;
  /** Newest created first. A change replaces the objects it changes, so an object returned earlier does not change. */
  private entries: DocumentEntry[];
  /** Newest first: a batch goes in front in the owner's order. */
  private allAnnotations: Annotation[];

  constructor({ file = DOCUMENTS_FILE, events = sharedEventLog(), now = () => new Date() }: DocumentStoreOptions = {}) {
    this.file = file;
    this.events = events;
    this.now = now;
    const loaded = readDocumentFile(file);
    this.entries = loaded.documents;
    this.allAnnotations = loaded.annotations;
  }

  /** The documents, most recently updated first. */
  list(): Document[] {
    return this.entries.map((entry) => entry.document).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  get(id: string): Document | undefined {
    return this.find(id)?.document;
  }

  byPath(workspacePath: string): Document | undefined {
    return this.entries.find((entry) => entry.document.path === workspacePath)?.document;
  }

  /** The versions of a document, newest first; undefined when there is no such document. */
  versions(id: string): DocumentVersion[] | undefined {
    const entry = this.find(id);
    return entry === undefined ? undefined : [...entry.versions];
  }

  /** The annotations of a document, newest first. */
  annotations(id: string): Annotation[] {
    return this.allAnnotations.filter((annotation) => annotation.documentId === id);
  }

  annotation(id: string): Annotation | undefined {
    return this.allAnnotations.find((annotation) => annotation.id === id);
  }

  /** The revision run that holds the document's batch while it is queued or running, if one does. */
  revisionOf(id: string): string | undefined {
    return this.allAnnotations.find((annotation) => annotation.documentId === id && annotation.state === "submitted")?.runId;
  }

  /**
   * Registers the file as a document, or adds to the document it already is: a delivered version when the version is
   * not the current one, and the title and task it was delivered with. Returns the document. An event only when
   * something changed.
   */
  deliver({ path: workspacePath, version, at = this.now(), runId, taskId, title, kind }: DeliverInput): Document {
    const stamp = at.toISOString();
    const entry = this.entries.find((other) => other.document.path === workspacePath);
    if (!entry) {
      const id = newRunId((candidate) => this.find(candidate) !== undefined);
      const document = DocumentSchema.parse({
        id,
        path: workspacePath,
        title,
        kind,
        ...(taskId === undefined ? {} : { taskId }),
        version,
        createdAt: stamp,
        updatedAt: stamp,
      });
      this.save([{ document, versions: [versionOf(version, at, "delivered", { runId })] }, ...this.entries], this.allAnnotations);
      this.events.append("document.updated", document);
      return document;
    }

    const current = entry.document;
    const sameVersion = version === current.version;
    const nextTaskId = taskId ?? current.taskId;
    if (sameVersion && title === current.title && nextTaskId === current.taskId) return current;

    const document = DocumentSchema.parse({
      ...current,
      version,
      title,
      ...(nextTaskId === undefined ? {} : { taskId: nextTaskId }),
      updatedAt: stamp,
    });
    const versions = sameVersion ? entry.versions : [versionOf(version, at, "delivered", { runId }), ...entry.versions];
    this.save(
      this.entries.map((other) => (other === entry ? { document, versions } : other)),
      this.allAnnotations,
    );
    this.events.append("document.updated", document);
    return document;
  }

  /**
   * Adds a version to each document at one of the paths that is not at it yet: the end of a run that changed those
   * files. Returns the documents that changed.
   */
  recordVersion({ paths, version, at = this.now(), reason, runId, undoes }: RecordVersionInput): Document[] {
    const stamp = at.toISOString();
    const newVersion = versionOf(version, at, reason, { runId, undoes });
    const wanted = new Set(paths);
    const changed: Document[] = [];
    const next = this.entries.map((entry) => {
      if (!wanted.has(entry.document.path) || entry.document.version === version) return entry;
      const document = DocumentSchema.parse({ ...entry.document, version, updatedAt: stamp });
      changed.push(document);
      return { document, versions: [newVersion, ...entry.versions] };
    });
    if (changed.length === 0) return [];
    this.save(next, this.allAnnotations);
    for (const document of changed) this.events.append("document.updated", document);
    return changed;
  }

  /**
   * Moves the document at `from`, and each document under it as a directory, to the same place under `to`. A document
   * whose new path another document has stays where it is and is logged. Returns the documents that moved.
   */
  move(from: string, to: string, at = this.now()): Document[] {
    const stamp = at.toISOString();
    const moved: Document[] = [];
    let next = this.entries;
    for (const entry of this.entries) {
      const current = entry.document.path;
      if (current !== from && !current.startsWith(`${from}/`)) continue;
      const target = to + current.slice(from.length);
      if (target === current) continue;
      if (next.some((other) => other.document.path === target)) {
        log.warn(`not moving document ${entry.document.id} from ${current} to ${target}: another document has that path`);
        continue;
      }
      const document = DocumentSchema.parse({ ...entry.document, path: target, updatedAt: stamp });
      next = next.map((other) => (other === entry ? { ...other, document } : other));
      moved.push(document);
    }
    if (moved.length === 0) return [];
    this.save(next, this.allAnnotations);
    for (const document of moved) this.events.append("document.updated", document);
    return moved;
  }

  /**
   * Records a revision batch against the document's current version, each annotation submitted to the run. Returns the
   * annotations in the owner's order. Throws a DocumentRefused for a batch it cannot take, and records nothing then.
   */
  submit({ documentId, version, annotations, runId, at = this.now() }: SubmitInput): Annotation[] {
    const entry = this.find(documentId);
    if (!entry) throw new DocumentRefused(404, "no such document");
    if (entry.document.version !== version) throw new DocumentRefused(409, "the document has changed since; reload it");
    if (this.allAnnotations.some((annotation) => annotation.documentId === documentId && annotation.state === "submitted")) {
      throw new DocumentRefused(409, "a revision of this document is queued or running");
    }
    const { kind } = entry.document;
    if (kind !== "markdown" && kind !== "text" && annotations.some((draft) => draft.target.kind === "passage")) {
      throw new DocumentRefused(400, "only Markdown and text documents take passage annotations");
    }

    const stamp = at.toISOString();
    const taken = new Set(this.allAnnotations.map((annotation) => annotation.id));
    const created = annotations.map((draft) => {
      const id = newRunId((candidate) => taken.has(candidate));
      taken.add(id);
      return AnnotationSchema.parse({
        id,
        documentId,
        version,
        target: draft.target,
        comment: draft.comment,
        state: "submitted",
        runId,
        createdAt: stamp,
        updatedAt: stamp,
      });
    });
    this.save(this.entries, [...created, ...this.allAnnotations]);
    for (const annotation of created) this.events.append("annotation.updated", annotation);
    return created;
  }

  /**
   * Answers a submitted annotation of the run with the reply, trimmed. Returns the annotation, or the reason it was
   * refused. A refusal changes nothing.
   */
  reply(annotationId: string, runId: string, text: string, at = this.now()): Annotation | ReplyRefused {
    const current = this.annotation(annotationId);
    if (!current) return { refused: "unknown" };
    if (current.runId !== runId) return { refused: "other-run" };
    if (current.state !== "submitted") return { refused: "closed" };
    const reply = text.trim();
    if (reply === "") return { refused: "blank" };
    if ([...reply].length > MAX_REPLY_CHARS) return { refused: "too-long" };

    const answered = AnnotationSchema.parse({ ...current, state: "resolved", reply, updatedAt: at.toISOString() });
    this.save(
      this.entries,
      this.allAnnotations.map((annotation) => (annotation.id === annotationId ? answered : annotation)),
    );
    this.events.append("annotation.updated", answered);
    return answered;
  }

  /**
   * The end of a revision run: its annotations still waiting for an answer go back to the owner, with the outcome as
   * the reason (done leaves them unanswered). Returns them.
   */
  finishRevision(runId: string, outcome: RevisionOutcome, at = this.now()): Annotation[] {
    const returnReason = outcome === "done" ? "unanswered" : outcome;
    return this.returnWhere((annotation) => annotation.runId === runId && annotation.state === "submitted", returnReason, at);
  }

  /** The undo of a revision: every annotation of its run goes back to the owner as undone, and keeps its reply. Returns them. */
  returnUndone(runId: string, at = this.now()): Annotation[] {
    return this.returnWhere(
      (annotation) => annotation.runId === runId && !(annotation.state === "returned" && annotation.returnReason === "undone"),
      "undone",
      at,
    );
  }

  private returnWhere(
    pick: (annotation: Annotation) => boolean,
    returnReason: NonNullable<Annotation["returnReason"]>,
    at: Date,
  ): Annotation[] {
    const stamp = at.toISOString();
    const returned: Annotation[] = [];
    const next = this.allAnnotations.map((annotation) => {
      if (!pick(annotation)) return annotation;
      const updated = AnnotationSchema.parse({ ...annotation, state: "returned", returnReason, updatedAt: stamp });
      returned.push(updated);
      return updated;
    });
    if (returned.length === 0) return [];
    this.save(this.entries, next);
    for (const annotation of returned) this.events.append("annotation.updated", annotation);
    return returned;
  }

  private find(id: string): DocumentEntry | undefined {
    return this.entries.find((entry) => entry.document.id === id);
  }

  /** Checks the whole file, writes it atomically, and only then keeps the new state. */
  private save(entries: DocumentEntry[], annotations: Annotation[]): void {
    const data = DocumentFileSchema.parse({ documents: entries, annotations });
    writeJson(this.file, data);
    this.entries = entries;
    this.allAnnotations = annotations;
  }
}

/** A version as the file holds it: `runId` and `undoes` only when given, so the file never holds an undefined key. */
function versionOf(
  version: string,
  at: Date,
  reason: DocumentVersion["reason"],
  { runId, undoes }: { runId?: string | undefined; undoes?: string | undefined },
): DocumentVersion {
  return DocumentVersionSchema.parse({
    version,
    at: at.toISOString(),
    reason,
    ...(runId === undefined ? {} : { runId }),
    ...(undoes === undefined ? {} : { undoes }),
  });
}
