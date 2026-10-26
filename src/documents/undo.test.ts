// Undo on a real git dir and a document store of their own, with a stub for the revision runner: no model is called,
// nothing is sent anywhere. The revisions are made the way the handler ends one (commitRun, finishRevision), and the
// undo is called through documentCommands, as the command API calls it.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { DocumentResult, DocumentRevise, RevisionAccepted } from "../api/schema.ts";
import type { DocumentCommands, DocumentReply } from "../api/server.ts";
import type { Documents } from "./register.ts";
import type { Commit } from "./versions.ts";

// store.ts and runs.ts read STATE_DIR at import time, so set it before loading the modules under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-undo-")));
process.env.ALFRED_STATE_DIR = path.join(tmp, "state");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { DocumentResultSchema } = await import("../api/schema.ts");
const { EventLog } = await import("../events.ts");
const { documentCommands } = await import("./commands.ts");
const { deliverDocument } = await import("./register.ts");
const { DocumentRefused, DocumentStore } = await import("./store.ts");
const { Versions } = await import("./versions.ts");

const RUN_A = "k7m2qa"; // delivers a document
const RUN_B = "s2d8kp"; // revises it
const RUN_C = "t4w9xr"; // a later run, or a batch after RUN_B
const RUN_E = "c3r7vz"; // a batch sent through the command layer

let cases = 0;

/** A workspace, a git dir of its own and a document store, with the history initialized as at startup. */
async function fixture() {
  const dir = path.join(tmp, `case-${cases++}`);
  const workspace = path.join(dir, "workspace");
  const gitDir = path.join(dir, "workbench", "versions.git");
  fs.mkdirSync(workspace, { recursive: true });
  const versions = new Versions({ workspace, gitDir });
  await versions.init();
  const events = new EventLog(path.join(dir, "events", "events.jsonl"));
  const store = new DocumentStore({ file: path.join(dir, "workbench", "documents.json"), events });
  const documents: Documents = { versions, store };
  return { workspace, gitDir, versions, store, documents };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const write = (f: Fixture, rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(f.workspace, rel)), { recursive: true });
  fs.writeFileSync(path.join(f.workspace, rel), content);
};
const read = (f: Fixture, rel: string) => fs.readFileSync(path.join(f.workspace, rel), "utf8");
const git = (f: Fixture, ...args: string[]) =>
  execFileSync("git", [`--git-dir=${f.gitDir}`, `--work-tree=${f.workspace}`, ...args], { encoding: "utf8" }).trim();

function versionsOf(f: Fixture, documentId: string) {
  const versions = f.store.versions(documentId);
  assert.ok(versions, "the document has versions");
  return versions;
}

/** Delivers a file as a run does: committed under the run, registered as a document at that commit. */
async function deliver(f: Fixture, rel: string, content: string, runId = RUN_A): Promise<{ documentId: string; version: string }> {
  write(f, rel, content);
  const abs = path.join(f.workspace, rel);
  const delivered = await deliverDocument(f.documents, { path: rel, abs, size: fs.statSync(abs).size, runId });
  assert.ok(delivered, `${rel} is delivered as a document`);
  return delivered;
}

/** A batch of whole-document comments on the document's current version, recorded as the handler records one. */
function batch(f: Fixture, documentId: string, comments: string[], runId: string) {
  const version = f.store.get(documentId)?.version;
  assert.ok(version);
  return f.store.submit({
    documentId,
    version,
    annotations: comments.map((comment) => ({ target: { kind: "document" as const }, comment })),
    runId,
  });
}

/**
 * A revision run as the handler ends one: the files it wrote are committed under the run (commitRun), the document it
 * revises gets a revised version and any other document the commit changed a changed one. `null` removes a file.
 */
async function revise(f: Fixture, runId: string, writes: Record<string, string | null>, revised?: string): Promise<string> {
  for (const [rel, content] of Object.entries(writes)) {
    if (content === null) fs.rmSync(path.join(f.workspace, rel));
    else write(f, rel, content);
  }
  const commit = await f.versions.commit(`Run ${runId}: 修订`, { paths: Object.keys(writes) });
  assert.ok(commit, "the revision changed something");
  const stamp = { version: commit.version, at: new Date(commit.at), runId };
  if (revised !== undefined && commit.files.includes(revised)) f.store.recordVersion({ ...stamp, paths: [revised], reason: "revised" });
  f.store.recordVersion({ ...stamp, paths: commit.files, reason: "changed" });
  return commit.version;
}

/** The end of a run: the annotations named are answered, and the rest of its batch goes back to the owner as unanswered. */
function finish(f: Fixture, runId: string, answered: string[]): void {
  for (const id of answered) {
    const reply = f.store.reply(id, runId, "已改");
    assert.equal("refused" in reply, false, `${id} is answered`);
  }
  f.store.finishRevision(runId, "done");
}

/** The revision runner the undo tests need: a batch goes into the store under RUN_E, and nothing runs. */
function stubRunner(store: InstanceType<typeof DocumentStore>) {
  return {
    reviseDocument(command: DocumentRevise): DocumentReply<RevisionAccepted> {
      try {
        const annotations = store.submit({ documentId: command.documentId, version: command.version, annotations: command.annotations, runId: RUN_E });
        return { ok: true, body: { runId: RUN_E, annotations } };
      } catch (err) {
        if (err instanceof DocumentRefused) return { ok: false, status: err.status, error: err.message };
        throw err;
      }
    },
  };
}

/** The command layer over a documents' set, as the command API holds it. Tests that call undo twice share one. */
function commandsOver(documents: Documents): DocumentCommands {
  return documentCommands(stubRunner(documents.store), documents);
}

async function undoWith(commands: DocumentCommands, documentId: string, runId: string): Promise<DocumentReply<DocumentResult>> {
  assert.ok(commands.undo, "undo is wired when documents are");
  return commands.undo({ type: "document.undo", documentId, runId });
}

/** The body of an accepted reply; a refusal fails the test with its reason. */
function accepted<T>(reply: DocumentReply<T>): T {
  if (!reply.ok) assert.fail(`refused ${reply.status}: ${reply.error}`);
  return reply.body;
}

/** The status and reason of a refused reply, which must be one. */
function refusal<T>(reply: DocumentReply<T>): { status: number; error: string } {
  if (reply.ok) assert.fail("accepted, but a refusal was expected");
  return { status: reply.status, error: reply.error };
}

/** What a refused or failed undo must leave alone: the history, the document, its versions and annotations, and the files. */
function snapshot(f: Fixture, documentId: string, files: string[]): string {
  return JSON.stringify({
    head: git(f, "rev-parse", "HEAD"),
    document: f.store.get(documentId),
    versions: f.store.versions(documentId),
    annotations: f.store.annotations(documentId),
    files: files.map((rel) => (fs.existsSync(path.join(f.workspace, rel)) ? read(f, rel) : null)),
  });
}

/** A store and history whose restore or commit fails on request: the undo's failures without a broken disk. */
class RestoreFails extends Versions {
  /** The one commit whose files can still be restored: the revision's, so a failed undo can put them back. */
  keep = "";

  override restore(version: string, paths: string[]): Promise<void> {
    return version === this.keep ? super.restore(version, paths) : Promise.reject(new Error("disk full"));
  }
}

class CommitFails extends Versions {
  override commit(): Promise<Commit | undefined> {
    return Promise.reject(new Error("git refused"));
  }
}

test("an undo restores the files its revision changed, removes the one it added, and records one undone version with the batch back to the owner", async () => {
  const f = await fixture();
  const doc = await deliver(f, "essay.md", "# 文章\n\n一\n");
  const [first, second] = batch(f, doc.documentId, ["第一句", "结尾"], RUN_B);
  assert.ok(first && second);
  await revise(f, RUN_B, { "essay.md": "# 文章\n\n一二\n", "added.md": "新文件\n" }, "essay.md");
  finish(f, RUN_B, [first.id]);

  const result = accepted(await undoWith(commandsOver(f.documents), doc.documentId, RUN_B));
  assert.ok(DocumentResultSchema.safeParse(result).success, "the answer fits the contract");
  const head = git(f, "rev-parse", "HEAD");
  assert.equal(git(f, "log", "-1", "--format=%s"), `Undo revision ${RUN_B}`);
  assert.equal(read(f, "essay.md"), "# 文章\n\n一\n");
  assert.equal(fs.existsSync(path.join(f.workspace, "added.md")), false, "the file the revision added is gone");
  assert.deepEqual(await f.versions.changedFiles(head), ["added.md", "essay.md"]);
  assert.equal(result.document.version, head);
  assert.equal(f.store.get(doc.documentId)?.version, head);

  const versions = versionsOf(f, doc.documentId);
  assert.deepEqual(
    versions.map((v) => v.reason),
    ["undone", "revised", "delivered"],
    "one undone version is added, the others stay",
  );
  assert.deepEqual(
    { version: versions[0]?.version, undoes: versions[0]?.undoes, runId: versions[0]?.runId },
    { version: head, undoes: RUN_B, runId: undefined },
    "an undone version names the revision it undid and has no run",
  );

  assert.deepEqual(
    f.store.annotations(doc.documentId).map((a) => [a.comment, a.state, a.returnReason, a.reply]),
    [
      ["第一句", "returned", "undone", "已改"],
      ["结尾", "returned", "undone", undefined],
    ],
    "every annotation of the batch goes back as undone, the answered one with its reply",
  );
});

test("an undo of an unknown document, or of a run that made no revision of it, is refused with 404 and changes nothing", async () => {
  const f = await fixture();
  const doc = await deliver(f, "essay.md", "一\n");
  batch(f, doc.documentId, ["改"], RUN_B);
  await revise(f, RUN_B, { "essay.md": "一二\n" }, "essay.md");
  finish(f, RUN_B, []);
  const commands = commandsOver(f.documents);
  const before = snapshot(f, doc.documentId, ["essay.md"]);

  assert.deepEqual(refusal(await undoWith(commands, "zzzzzz", RUN_B)), { status: 404, error: "no such document" });
  assert.deepEqual(refusal(await undoWith(commands, doc.documentId, RUN_A)), { status: 404, error: "no such revision of this document" }, "a delivery is not a revision");
  assert.deepEqual(refusal(await undoWith(commands, doc.documentId, RUN_C)), { status: 404, error: "no such revision of this document" });
  assert.equal(snapshot(f, doc.documentId, ["essay.md"]), before);
});

test("only a document's latest revision can be undone, and a revision is undone once", async () => {
  const f = await fixture();
  const doc = await deliver(f, "essay.md", "一\n");
  batch(f, doc.documentId, ["改一"], RUN_B);
  await revise(f, RUN_B, { "essay.md": "一二\n" }, "essay.md");
  finish(f, RUN_B, []);
  batch(f, doc.documentId, ["改二"], RUN_C);
  await revise(f, RUN_C, { "essay.md": "一二三\n" }, "essay.md");
  finish(f, RUN_C, []);
  const commands = commandsOver(f.documents);

  const before = snapshot(f, doc.documentId, ["essay.md"]);
  assert.deepEqual(refusal(await undoWith(commands, doc.documentId, RUN_B)), { status: 409, error: "only the latest revision can be undone" });
  assert.equal(snapshot(f, doc.documentId, ["essay.md"]), before);

  accepted(await undoWith(commands, doc.documentId, RUN_C));
  assert.equal(read(f, "essay.md"), "一二\n", "the revision before it is what the file holds");
  assert.deepEqual(refusal(await undoWith(commands, doc.documentId, RUN_C)), { status: 409, error: "only the latest revision can be undone" });
  assert.deepEqual(refusal(await undoWith(commands, doc.documentId, RUN_B)), { status: 409, error: "only the latest revision can be undone" });
  assert.equal(read(f, "essay.md"), "一二\n");
});

test("an undo is refused while a batch on the document is queued or running", async () => {
  const f = await fixture();
  const doc = await deliver(f, "essay.md", "一\n");
  batch(f, doc.documentId, ["改"], RUN_B);
  await revise(f, RUN_B, { "essay.md": "一二\n" }, "essay.md");
  finish(f, RUN_B, []);
  batch(f, doc.documentId, ["再改"], RUN_C); // queued: its run has not started
  const before = snapshot(f, doc.documentId, ["essay.md"]);

  assert.deepEqual(refusal(await undoWith(commandsOver(f.documents), doc.documentId, RUN_B)), {
    status: 409,
    error: "a revision of this document is queued or running",
  });
  assert.equal(snapshot(f, doc.documentId, ["essay.md"]), before);
});

test("an undo is refused, naming the files, when one the revision changed differs from its commit, committed or not", async () => {
  const f = await fixture();
  const doc = await deliver(f, "essay.md", "一\n");
  batch(f, doc.documentId, ["改"], RUN_B);
  await revise(f, RUN_B, { "essay.md": "一二\n", "added.md": "新\n" }, "essay.md");
  finish(f, RUN_B, []);
  const commands = commandsOver(f.documents);

  write(f, "essay.md", "一二，手动改的\n"); // not committed by anyone
  const before = snapshot(f, doc.documentId, ["essay.md", "added.md"]);
  assert.deepEqual(refusal(await undoWith(commands, doc.documentId, RUN_B)), { status: 409, error: "files changed since the revision: essay.md" });
  assert.equal(snapshot(f, doc.documentId, ["essay.md", "added.md"]), before);

  write(f, "essay.md", "一二\n");
  // A later run changes the other file and commits it; the document itself is still at the revision.
  await revise(f, RUN_C, { "added.md": "新，后来改的\n" });
  assert.deepEqual(refusal(await undoWith(commands, doc.documentId, RUN_B)), { status: 409, error: "files changed since the revision: added.md" });
  assert.equal(read(f, "added.md"), "新，后来改的\n");
});

test("a revision that changed two documents' files gives both an undone version", async () => {
  const f = await fixture();
  const essay = await deliver(f, "essay.md", "一\n");
  const notes = await deliver(f, "notes.md", "甲\n");
  batch(f, essay.documentId, ["改"], RUN_B);
  await revise(f, RUN_B, { "essay.md": "一二\n", "notes.md": "甲乙\n" }, "essay.md");
  finish(f, RUN_B, []);

  accepted(await undoWith(commandsOver(f.documents), essay.documentId, RUN_B));
  const head = git(f, "rev-parse", "HEAD");
  assert.equal(read(f, "essay.md"), "一\n");
  assert.equal(read(f, "notes.md"), "甲\n");
  for (const id of [essay.documentId, notes.documentId]) {
    assert.deepEqual(
      versionsOf(f, id).slice(0, 1).map((v) => [v.version, v.reason, v.undoes]),
      [[head, "undone", RUN_B]],
      "each document gets the undone version",
    );
  }
});

test("a restore that fails records nothing, answers 500, and leaves the revision's files as they were", async () => {
  const f = await fixture();
  const doc = await deliver(f, "essay.md", "一\n");
  batch(f, doc.documentId, ["改"], RUN_B);
  const revisedAt = await revise(f, RUN_B, { "essay.md": "一二\n", "added.md": "新\n" }, "essay.md");
  finish(f, RUN_B, []);
  const failing = new RestoreFails({ workspace: f.workspace, gitDir: f.gitDir });
  failing.keep = revisedAt;

  const before = snapshot(f, doc.documentId, ["essay.md", "added.md"]);
  assert.deepEqual(refusal(await undoWith(commandsOver({ versions: failing, store: f.store }), doc.documentId, RUN_B)), { status: 500, error: "disk full" });
  assert.equal(snapshot(f, doc.documentId, ["essay.md", "added.md"]), before);
  assert.equal(read(f, "essay.md"), "一二\n");
});

test("a commit that fails records nothing, answers 500, and puts the revision's files back", async () => {
  const f = await fixture();
  const doc = await deliver(f, "essay.md", "一\n");
  batch(f, doc.documentId, ["改"], RUN_B);
  await revise(f, RUN_B, { "essay.md": "一二\n", "added.md": "新\n" }, "essay.md");
  finish(f, RUN_B, []);
  const failing = new CommitFails({ workspace: f.workspace, gitDir: f.gitDir });

  const before = snapshot(f, doc.documentId, ["essay.md", "added.md"]);
  assert.deepEqual(refusal(await undoWith(commandsOver({ versions: failing, store: f.store }), doc.documentId, RUN_B)), { status: 500, error: "git refused" });
  assert.equal(snapshot(f, doc.documentId, ["essay.md", "added.md"]), before, "history, store and files are as before the undo");
  assert.equal(read(f, "essay.md"), "一二\n");
  assert.equal(read(f, "added.md"), "新\n");
});

test("an undo brings back a file the revision removed and commits it, though the rules leave such a file out of an ordinary commit", async () => {
  const f = await fixture();
  const image = await deliver(f, "cover.png", "png 字节\n");
  batch(f, image.documentId, ["换掉"], RUN_B);
  await revise(f, RUN_B, { "cover.png": null }, "cover.png");
  finish(f, RUN_B, []);

  accepted(await undoWith(commandsOver(f.documents), image.documentId, RUN_B));
  assert.equal(read(f, "cover.png"), "png 字节\n");
  assert.deepEqual(await f.versions.changedFiles(git(f, "rev-parse", "HEAD")), ["cover.png"]);
});

test("two undos started at once: the first undoes the revision, the second is refused as not the latest", async () => {
  const f = await fixture();
  const doc = await deliver(f, "essay.md", "一\n");
  batch(f, doc.documentId, ["改"], RUN_B);
  await revise(f, RUN_B, { "essay.md": "一二\n" }, "essay.md");
  finish(f, RUN_B, []);
  const commands = commandsOver(f.documents);

  const [first, second] = await Promise.all([undoWith(commands, doc.documentId, RUN_B), undoWith(commands, doc.documentId, RUN_B)]);
  accepted(first);
  assert.deepEqual(refusal(second), { status: 409, error: "only the latest revision can be undone" });
  assert.equal(versionsOf(f, doc.documentId).filter((v) => v.reason === "undone").length, 1, "one undone version");
  assert.equal(read(f, "essay.md"), "一\n");
});

test("an undo and a batch on the same document never interleave: whichever is called first goes first", async () => {
  const batchAt = (documentId: string, version: string): DocumentRevise => ({
    type: "document.revise",
    documentId,
    version,
    annotations: [{ target: { kind: "document" }, comment: "再改" }],
  });

  // The undo first: the batch then names a version the undo has replaced.
  const undoFirst = await fixture();
  const doc = await deliver(undoFirst, "essay.md", "一\n");
  batch(undoFirst, doc.documentId, ["改"], RUN_B);
  const revisedAt = await revise(undoFirst, RUN_B, { "essay.md": "一二\n" }, "essay.md");
  finish(undoFirst, RUN_B, []);
  const commands = commandsOver(undoFirst.documents);
  const [undone, late] = await Promise.all([undoWith(commands, doc.documentId, RUN_B), commands.revise(batchAt(doc.documentId, revisedAt))]);
  accepted(undone);
  assert.deepEqual(refusal(late), { status: 409, error: "the document has changed since; reload it" });

  // The batch first: the undo is then refused while the batch is queued.
  const batchFirst = await fixture();
  const other = await deliver(batchFirst, "essay.md", "一\n");
  batch(batchFirst, other.documentId, ["改"], RUN_B);
  const version = await revise(batchFirst, RUN_B, { "essay.md": "一二\n" }, "essay.md");
  finish(batchFirst, RUN_B, []);
  const ordered = commandsOver(batchFirst.documents);
  const [queued, refused] = await Promise.all([ordered.revise(batchAt(other.documentId, version)), undoWith(ordered, other.documentId, RUN_B)]);
  accepted(queued);
  assert.deepEqual(refusal(refused), { status: 409, error: "a revision of this document is queued or running" });
  assert.equal(read(batchFirst, "essay.md"), "一二\n", "the file is not undone");
});
