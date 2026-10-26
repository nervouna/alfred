import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

// runs.ts reads STATE_DIR at import time (through store.ts), so set it before loading the modules under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-documents-")));
process.env.ALFRED_STATE_DIR = path.join(tmp, "state");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { EventLog } = await import("../events.ts");
const { AnnotationSchema, DocumentSchema, DocumentVersionSchema } = await import("../api/schema.ts");
const { DocumentRefused, DocumentStore, documentKind, documentTitle, readDocumentFile } = await import("./store.ts");
type AnnotationDraft = import("./store.ts").AnnotationDraft;

const at = (iso: string) => new Date(iso);
const START = at("2026-10-26T01:00:00Z");
/** The clock the stores read when a call gives no time; each test starts at START and may move it. */
let clock = START;
const now = () => clock;
beforeEach(() => {
  clock = START;
});

/** A version id: a 40-character commit id, numbered for the test. */
const commit = (n: number) => n.toString(16).padStart(40, "0");
const RUN_A = "k7m2qa";
const RUN_B = "s2d8kp";
const RUN_C = "t4w9xr";
const TASK = "a7k2mq";

let opened = 0;
/** A store on files of its own, reading the clock. */
function open() {
  const dir = path.join(tmp, `store-${opened++}`);
  const file = path.join(dir, "documents.json");
  const events = new EventLog(path.join(dir, "events.jsonl"));
  return { file, events, store: new DocumentStore({ file, events, now }) };
}

/** The document.updated events of a log, oldest first. */
function documentUpdates(events: InstanceType<typeof EventLog>) {
  return events.readSince(0).flatMap((event) => (event.type === "document.updated" ? [event.data] : []));
}

/** The annotation.updated events of a log, oldest first. */
function annotationUpdates(events: InstanceType<typeof EventLog>) {
  return events.readSince(0).flatMap((event) => (event.type === "annotation.updated" ? [event.data] : []));
}

const draft = (comment: string): AnnotationDraft => ({ target: { kind: "document" }, comment });

/** A Markdown document at commit 1, delivered by RUN_A. */
function essay(store: InstanceType<typeof DocumentStore>, workspacePath = "essay.md") {
  return store.deliver({ path: workspacePath, version: commit(1), at: START, runId: RUN_A, title: "文章", kind: "markdown" });
}

test("documentKind reads the extension in any case, as the app's file viewer does", () => {
  const kinds: [string, string][] = [
    ["notes/a.md", "markdown"],
    ["a.MARKDOWN", "markdown"],
    ["data/a.json", "text"],
    ["a.JSONL", "text"],
    ["a.csv", "text"],
    ["a.tsv", "text"],
    ["a.log", "text"],
    ["a.yaml", "text"],
    ["a.yml", "text"],
    ["a.xml", "text"],
    ["a.js", "text"],
    ["a.ts", "text"],
    ["a.py", "text"],
    ["a.sh", "text"],
    ["a.css", "text"],
    ["a.txt", "text"],
    ["page.html", "html"],
    ["page.HTM", "html"],
    ["chart.svg", "html"],
    ["report.pdf", "pdf"],
    ["REPORT.PDF", "pdf"],
    ["photo.png", "image"],
    ["photo.JPG", "image"],
    ["photo.jpeg", "image"],
    ["a.gif", "image"],
    ["a.webp", "image"],
    ["IMG.HEIC", "image"],
    ["archive.zip", "other"],
    ["x.docx", "other"],
    ["README", "other"],
    [".hidden", "other"],
    ["dir.md/README", "other"],
    ["a.", "other"],
  ];
  for (const [workspacePath, kind] of kinds) assert.equal(documentKind(workspacePath), kind, workspacePath);
});

test("documentTitle takes the first level-1 or level-2 heading of Markdown, and falls back to the file name", () => {
  assert.equal(documentTitle("reports/vps.md", "# VPS 价格\n\n正文\n\n## 其他\n"), "VPS 价格");
  assert.equal(documentTitle("a.md", "前言\n\n## 第二节\n# 第一\n"), "第二节", "the first heading in the text, whatever its level");
  assert.equal(documentTitle("a.md", "### 三级\n#### 四级\n"), "a.md", "a level-3 heading is not a title");
  assert.equal(documentTitle("a.md", "# Title ##\n"), "Title", "closing hashes are not part of the title");
  assert.equal(documentTitle("a.md", "# C#\n"), "C#");
  assert.equal(documentTitle("a.md", "#   spaced \t out  \n"), "spaced out");
  assert.equal(documentTitle("a.md", "---\ntitle: 草稿\n# 注释\n---\n\n# 正文\n"), "正文", "front matter is not read");
  assert.equal(documentTitle("a.md", "```\n# 代码\n```\n\n~~~\n## 也是代码\n~~~\n\n# 标题\n"), "标题", "code is not read");
  assert.equal(documentTitle("a.md", "没有标题\n"), "a.md");
  assert.equal(documentTitle("notes/a.md"), "a.md", "without the text, the file name");
  assert.equal(documentTitle("a.txt", "# 不是 Markdown\n"), "a.txt", "only Markdown has headings");
});

test("an HTML title is its <title>, with the five entities decoded once", () => {
  assert.equal(
    documentTitle("page.html", "<html><head><TITLE>Q3 &amp; Q4 &lt;草稿&gt; &quot;x&quot; &#39;y&#39;</TITLE></head></html>"),
    `Q3 & Q4 <草稿> "x" 'y'`,
  );
  assert.equal(documentTitle("page.html", "<title>&amp;lt;</title>"), "&lt;", "&amp; is decoded last, once");
  assert.equal(documentTitle("page.htm", "<h1>No title</h1>"), "page.htm");
  assert.equal(documentTitle("page.htm", "<title>  </title>"), "page.htm");
});

test("a title is at most 200 characters, and its whitespace is collapsed", () => {
  assert.equal(documentTitle("a.md", `# ${"长".repeat(300)}\n`), "长".repeat(200));
  assert.equal([...documentTitle("a.md", `# ${"😀".repeat(300)}\n`)].length, 200, "counted in code points");
  assert.equal(documentTitle(`${"a".repeat(300)}.md`), "a".repeat(200), "a long file name is cut too");
});

test("delivering a new path registers a document with one delivered version", () => {
  const { events, store } = open();
  const doc = store.deliver({
    path: "reports/vps.md",
    version: commit(1),
    at: at("2026-10-26T01:00:00Z"),
    runId: RUN_A,
    title: "VPS 价格",
    kind: "markdown",
  });

  assert.match(doc.id, /^[2-9a-hjkmnp-z]{6}$/);
  assert.deepEqual(doc, {
    id: doc.id,
    path: "reports/vps.md",
    title: "VPS 价格",
    kind: "markdown",
    version: commit(1),
    createdAt: "2026-10-26T01:00:00.000Z",
    updatedAt: "2026-10-26T01:00:00.000Z",
  });
  assert.deepEqual(store.versions(doc.id), [{ version: commit(1), at: "2026-10-26T01:00:00.000Z", reason: "delivered", runId: RUN_A }]);
  assert.deepEqual(store.get(doc.id), doc);
  assert.deepEqual(store.byPath("reports/vps.md"), doc);
  assert.deepEqual(documentUpdates(events), [doc]);
});

test("delivering a path again adds a version, newest first, and takes the new title", () => {
  const { events, store } = open();
  const first = store.deliver({
    path: "reports/vps.md",
    version: commit(1),
    at: at("2026-10-26T01:00:00Z"),
    runId: RUN_A,
    title: "VPS 价格",
    kind: "markdown",
  });
  const second = store.deliver({
    path: "reports/vps.md",
    version: commit(2),
    at: at("2026-10-26T02:00:00Z"),
    runId: RUN_B,
    title: "VPS 价格（改）",
    kind: "markdown",
  });

  assert.deepEqual(second, { ...first, version: commit(2), title: "VPS 价格（改）", updatedAt: "2026-10-26T02:00:00.000Z" });
  assert.deepEqual(
    store.versions(first.id)?.map((v) => [v.version, v.reason, v.runId]),
    [
      [commit(2), "delivered", RUN_B],
      [commit(1), "delivered", RUN_A],
    ],
  );
  assert.deepEqual(store.list(), [second]);
  assert.deepEqual(
    documentUpdates(events).map((doc) => doc.version),
    [commit(1), commit(2)],
  );
});

test("delivering the current version again adds no version, and an event only when something changed", () => {
  const { events, store } = open();
  const first = store.deliver({ path: "a.md", version: commit(1), at: at("2026-10-26T01:00:00Z"), runId: RUN_A, title: "A", kind: "markdown" });

  const again = store.deliver({ path: "a.md", version: commit(1), at: at("2026-10-26T02:00:00Z"), runId: RUN_B, title: "A", kind: "markdown" });
  assert.deepEqual(again, first);
  assert.equal(store.versions(first.id)?.length, 1);
  assert.equal(documentUpdates(events).length, 1, "nothing changed the second time");

  const retitled = store.deliver({ path: "a.md", version: commit(1), at: at("2026-10-26T03:00:00Z"), runId: RUN_B, title: "B", kind: "markdown" });
  assert.deepEqual(retitled, { ...first, title: "B", updatedAt: "2026-10-26T03:00:00.000Z" });
  assert.equal(store.versions(first.id)?.length, 1, "a new title is not a new version");
  assert.equal(documentUpdates(events).length, 2);
});

test("a task's delivery records the task, and no later delivery clears it", () => {
  const { store } = open();
  const chat = store.deliver({ path: "a.md", version: commit(1), at: START, runId: RUN_A, title: "A", kind: "markdown" });
  assert.equal("taskId" in chat, false);

  const fromTask = store.deliver({ path: "b.md", version: commit(1), at: START, runId: RUN_B, taskId: TASK, title: "B", kind: "markdown" });
  assert.equal(fromTask.taskId, TASK);
  const later = store.deliver({ path: "b.md", version: commit(2), at: at("2026-10-26T02:00:00Z"), runId: RUN_C, title: "B", kind: "markdown" });
  assert.equal(later.taskId, TASK);
});

test("a call without a time uses the store's clock", () => {
  const { store } = open();
  clock = at("2026-10-26T09:00:00Z");
  const doc = store.deliver({ path: "a.md", version: commit(1), runId: RUN_A, title: "A", kind: "markdown" });
  assert.equal(doc.createdAt, "2026-10-26T09:00:00.000Z");
});

test("recordVersion adds a version to the documents at the paths that are not at it yet, and returns those", () => {
  const { events, store } = open();
  const a = store.deliver({ path: "a.md", version: commit(1), at: START, runId: RUN_A, title: "A", kind: "markdown" });
  store.deliver({ path: "b.md", version: commit(1), at: START, runId: RUN_A, title: "B", kind: "markdown" });
  const c = store.deliver({ path: "c.md", version: commit(2), at: START, runId: RUN_A, title: "C", kind: "markdown" });

  const changed = store.recordVersion({
    paths: ["a.md", "b.md", "c.md", "gone.md"],
    version: commit(2),
    at: at("2026-10-26T04:00:00Z"),
    reason: "changed",
    runId: RUN_C,
  });

  assert.deepEqual(changed.map((doc) => doc.path).sort(), ["a.md", "b.md"]);
  assert.deepEqual(store.get(a.id), { ...a, version: commit(2), updatedAt: "2026-10-26T04:00:00.000Z" });
  assert.deepEqual(store.versions(a.id)?.[0], { version: commit(2), at: "2026-10-26T04:00:00.000Z", reason: "changed", runId: RUN_C });
  assert.equal(store.versions(a.id)?.length, 2);
  assert.deepEqual(store.get(c.id), c, "c was already at that version");
  assert.equal(store.versions(c.id)?.length, 1);
  assert.equal(documentUpdates(events).length, 3 + 2);
  assert.deepEqual(store.recordVersion({ paths: ["a.md"], version: commit(2), at: START, reason: "changed" }), [], "nothing changed");
});

test("recordVersion names the revision an undo reverted, and refuses a version with the wrong fields", () => {
  const { store } = open();
  const doc = essay(store);
  store.recordVersion({ paths: ["essay.md"], version: commit(2), at: START, reason: "revised", runId: RUN_B });
  store.recordVersion({ paths: ["essay.md"], version: commit(3), at: START, reason: "undone", undoes: RUN_B });

  assert.deepEqual(store.versions(doc.id)?.slice(0, 2), [
    { version: commit(3), at: "2026-10-26T01:00:00.000Z", reason: "undone", undoes: RUN_B },
    { version: commit(2), at: "2026-10-26T01:00:00.000Z", reason: "revised", runId: RUN_B },
  ]);
  assert.throws(() => store.recordVersion({ paths: ["essay.md"], version: commit(4), at: START, reason: "undone" }));
  assert.throws(() => store.recordVersion({ paths: ["nowhere.md"], version: commit(4), at: START, reason: "undone" }), "refused even with no document");
  assert.throws(() =>
    store.recordVersion({ paths: ["essay.md"], version: commit(4), at: START, reason: "undone", undoes: RUN_B, runId: RUN_C }),
  );
  assert.equal(store.get(doc.id)?.version, commit(3), "a refused version changes nothing");
});

test("move carries a file, or a directory with its files, to the new path", () => {
  const { events, store } = open();
  const note = store.deliver({ path: "reports/a.md", version: commit(1), at: START, runId: RUN_A, title: "A", kind: "markdown" });
  const sub = store.deliver({ path: "reports/sub/b.md", version: commit(1), at: START, runId: RUN_A, title: "B", kind: "markdown" });
  const sibling = store.deliver({ path: "reportsX/c.md", version: commit(1), at: START, runId: RUN_A, title: "C", kind: "markdown" });

  const single = store.move("reports/sub/b.md", "archive/b.md", at("2026-10-26T05:00:00Z"));
  assert.deepEqual(
    single.map((doc) => doc.path),
    ["archive/b.md"],
  );
  assert.deepEqual(store.get(sub.id), { ...sub, path: "archive/b.md", updatedAt: "2026-10-26T05:00:00.000Z" });
  assert.equal(store.byPath("reports/sub/b.md"), undefined);

  const directory = store.move("reports", "archive/reports", at("2026-10-26T06:00:00Z"));
  assert.deepEqual(
    directory.map((doc) => doc.path),
    ["archive/reports/a.md"],
  );
  assert.equal(store.get(note.id)?.path, "archive/reports/a.md");
  assert.equal(store.get(sibling.id)?.path, "reportsX/c.md", "a name that only starts with the directory does not move");
  assert.equal(documentUpdates(events).length, 3 + 2);
});

test("a move onto a path another document has leaves both as they were, and the rest of the move goes ahead", () => {
  const { store } = open();
  const taken = store.deliver({ path: "new/x.md", version: commit(1), at: START, runId: RUN_A, title: "新", kind: "markdown" });
  const clash = store.deliver({ path: "old/x.md", version: commit(1), at: START, runId: RUN_A, title: "旧", kind: "markdown" });
  const free = store.deliver({ path: "old/y.md", version: commit(1), at: START, runId: RUN_A, title: "旧", kind: "markdown" });

  const moved = store.move("old", "new", at("2026-10-26T05:00:00Z"));

  assert.deepEqual(
    moved.map((doc) => doc.path),
    ["new/y.md"],
  );
  assert.equal(store.get(clash.id)?.path, "old/x.md");
  assert.deepEqual(store.get(taken.id), taken);
  assert.equal(store.get(free.id)?.path, "new/y.md");
});

test("a move takes the kind of the new name, and keeps the kind when the extension is the same", () => {
  const { store } = open();
  const doc = essay(store, "a.md");
  const renamed = store.move("a.md", "a.txt", at("2026-10-26T05:00:00Z"));
  assert.deepEqual(renamed, [{ ...doc, path: "a.txt", kind: "text", updatedAt: "2026-10-26T05:00:00.000Z" }]);
  assert.deepEqual(store.get(doc.id), renamed[0]);

  const sameKind = store.move("a.txt", "b.txt", at("2026-10-26T06:00:00Z"));
  assert.equal(sameKind[0]?.kind, "text");
  assert.equal(store.move("b.txt", "c.md", at("2026-10-26T07:00:00Z"))[0]?.kind, "markdown");
});

test("a move to the path a document already has changes nothing", () => {
  const { events, store } = open();
  const doc = essay(store, "a.md");
  assert.deepEqual(store.move("a.md", "a.md", at("2026-10-26T05:00:00Z")), []);
  assert.deepEqual(store.get(doc.id), doc);
  assert.equal(documentUpdates(events).length, 1);
});

test("submit refuses an unknown document, a version that is not current, a second revision and passages on HTML", () => {
  const { store } = open();
  const md = essay(store);
  const page = store.deliver({ path: "page.html", version: commit(1), at: START, runId: RUN_A, title: "页面", kind: "html" });
  const whole = draft("再短些");
  const passage: AnnotationDraft = { target: { kind: "passage", quote: "文章", prefix: "", suffix: "" }, comment: "改" };

  assert.throws(
    () => store.submit({ documentId: "zzzzzz", version: commit(1), annotations: [whole], runId: RUN_B, at: START }),
    (err: unknown) => err instanceof DocumentRefused && err.status === 404,
  );
  assert.throws(
    () => store.submit({ documentId: md.id, version: commit(9), annotations: [whole], runId: RUN_B, at: START }),
    (err: unknown) => err instanceof DocumentRefused && err.status === 409 && err.message === "the document has changed since; reload it",
  );
  assert.throws(
    () => store.submit({ documentId: page.id, version: commit(1), annotations: [passage], runId: RUN_B, at: START }),
    (err: unknown) =>
      err instanceof DocumentRefused && err.status === 400 && err.message === "only Markdown and text documents take passage annotations",
  );
  assert.equal(store.annotations(md.id).length, 0, "a refused batch is not recorded");

  assert.equal(store.submit({ documentId: page.id, version: commit(1), annotations: [whole], runId: RUN_B, at: START }).length, 1);
  store.submit({ documentId: md.id, version: commit(1), annotations: [whole], runId: RUN_B, at: START });
  assert.throws(
    () => store.submit({ documentId: md.id, version: commit(1), annotations: [whole], runId: RUN_C, at: START }),
    (err: unknown) => err instanceof DocumentRefused && err.status === 409 && err.message === "a revision of this document is queued or running",
  );
});

test("a batch is submitted to its run in the owner's order, and each annotation is announced in that order", () => {
  const { events, store } = open();
  const doc = essay(store);
  const batch = store.submit({
    documentId: doc.id,
    version: commit(1),
    runId: RUN_A,
    at: at("2026-10-26T02:00:00Z"),
    annotations: [
      { target: { kind: "passage", quote: "第二段", prefix: "然后\n", suffix: "\n结论" }, comment: "改短" },
      draft("语气再正式些"),
      { target: { kind: "passage", quote: "结论", prefix: "第二段", suffix: "。" }, comment: "加数据" },
    ],
  });

  assert.deepEqual(
    batch.map((annotation) => annotation.comment),
    ["改短", "语气再正式些", "加数据"],
  );
  assert.deepEqual(
    batch.map((annotation) => [annotation.state, annotation.runId, annotation.version, annotation.documentId]),
    Array.from({ length: 3 }, () => ["submitted", RUN_A, commit(1), doc.id]),
  );
  assert.equal(new Set(batch.map((annotation) => annotation.id)).size, 3);
  for (const annotation of batch) {
    assert.match(annotation.id, /^[2-9a-hjkmnp-z]{6}$/);
    assert.equal(annotation.reply, undefined);
    assert.equal(annotation.returnReason, undefined);
    assert.equal(annotation.createdAt, "2026-10-26T02:00:00.000Z");
    AnnotationSchema.parse(annotation);
  }
  assert.deepEqual(annotationUpdates(events), batch);
  assert.deepEqual(store.annotations(doc.id), batch);
  assert.deepEqual(store.annotation(batch[1]?.id ?? ""), batch[1]);
  assert.equal(store.revisionOf(doc.id), RUN_A);
});

test("reply answers a submitted annotation of its run with the trimmed text, and refuses the rest", () => {
  const { events, store } = open();
  const doc = essay(store);
  const [first, second] = store.submit({ documentId: doc.id, version: commit(1), runId: RUN_A, at: START, annotations: [draft("一"), draft("二")] });
  const when = at("2026-10-26T03:00:00Z");
  if (!first || !second) throw new Error("the batch has two annotations");

  assert.deepEqual(store.reply("zzzzzz", RUN_A, "已改", when), { refused: "unknown" });
  assert.deepEqual(store.reply(first.id, RUN_B, "已改", when), { refused: "other-run" });
  assert.deepEqual(store.reply(first.id, RUN_A, " \n\t ", when), { refused: "blank" });
  assert.deepEqual(store.reply(first.id, RUN_A, "字".repeat(4001), when), { refused: "too-long" });

  const answered = store.reply(first.id, RUN_A, "  已改为两句。\n", when);
  assert.deepEqual(answered, { ...first, state: "resolved", reply: "已改为两句。", updatedAt: "2026-10-26T03:00:00.000Z" });
  assert.deepEqual(store.annotation(first.id), answered);
  assert.deepEqual(store.reply(first.id, RUN_A, "再改", when), { refused: "closed" }, "an answer is final");

  assert.deepEqual(
    store.reply(second.id, RUN_A, "字".repeat(4000), when),
    { ...second, state: "resolved", reply: "字".repeat(4000), updatedAt: "2026-10-26T03:00:00.000Z" },
    "4000 characters is the most",
  );
  assert.equal(annotationUpdates(events).length, 2 + 2, "the batch and the two answers");
});

test("finishRevision sends a run's unanswered annotations back with the outcome, and leaves answered ones resolved", () => {
  const { events, store } = open();
  const doc = essay(store);
  const [answered, open1, open2] = store.submit({
    documentId: doc.id,
    version: commit(1),
    runId: RUN_B,
    at: START,
    annotations: [draft("一"), draft("二"), draft("三")],
  });
  if (!answered || !open1 || !open2) throw new Error("the batch has three annotations");
  store.reply(answered.id, RUN_B, "好", START);
  const when = at("2026-10-26T06:00:00Z");

  const returned = store.finishRevision(RUN_B, "stopped", when);
  assert.deepEqual(
    returned.map((annotation) => [annotation.id, annotation.state, annotation.returnReason]),
    [
      [open1.id, "returned", "stopped"],
      [open2.id, "returned", "stopped"],
    ],
  );
  assert.equal(store.annotation(answered.id)?.state, "resolved", "an answered annotation stays answered");
  assert.equal(store.annotation(open1.id)?.updatedAt, "2026-10-26T06:00:00.000Z");
  assert.deepEqual(store.finishRevision(RUN_B, "done", when), [], "nothing is left to return");
  assert.deepEqual(store.reply(open1.id, RUN_B, "晚了", when), { refused: "closed" }, "a returned annotation takes no answer");
  assert.equal(store.revisionOf(doc.id), undefined);
  assert.equal(annotationUpdates(events).length, 3 + 1 + 2);

  assert.equal(store.submit({ documentId: doc.id, version: commit(1), runId: RUN_C, at: when, annotations: [draft("四")] }).length, 1);
});

test("the outcome of a revision run gives its unanswered annotations their reason", () => {
  const { store } = open();
  const outcomes = [
    ["done", "unanswered"],
    ["failed", "failed"],
  ] as const;
  for (const [index, [outcome, reason]] of outcomes.entries()) {
    const doc = store.deliver({ path: `doc-${index}.md`, version: commit(1), at: START, runId: RUN_A, title: "文", kind: "markdown" });
    store.submit({ documentId: doc.id, version: commit(1), runId: RUN_B, at: START, annotations: [draft("一")] });
    const returned = store.finishRevision(RUN_B, outcome, at("2026-10-26T06:00:00Z"));
    assert.deepEqual(
      returned.map((annotation) => [annotation.state, annotation.returnReason]),
      [["returned", reason]],
      outcome,
    );
  }
});

test("returnUndone sends every annotation of the run back as undone, and keeps the replies", () => {
  const { events, store } = open();
  const doc = essay(store);
  const [answered, unanswered] = store.submit({ documentId: doc.id, version: commit(1), runId: RUN_A, at: START, annotations: [draft("一"), draft("二")] });
  if (!answered || !unanswered) throw new Error("the batch has two annotations");
  store.reply(answered.id, RUN_A, "已改", START);
  store.finishRevision(RUN_A, "done", at("2026-10-26T06:00:00Z"));

  const undone = store.returnUndone(RUN_A, at("2026-10-26T07:00:00Z"));
  assert.deepEqual(
    undone.map((annotation) => [annotation.id, annotation.state, annotation.returnReason, annotation.reply]),
    [
      [answered.id, "returned", "undone", "已改"],
      [unanswered.id, "returned", "undone", undefined],
    ],
  );
  assert.equal(store.annotation(answered.id)?.updatedAt, "2026-10-26T07:00:00.000Z");
  assert.deepEqual(store.returnUndone(RUN_A, at("2026-10-26T08:00:00Z")), [], "nothing is left to undo");
  assert.equal(annotationUpdates(events).length, 2 + 1 + 1 + 2);
});

test("list is the most recently updated first, and queries about an unknown document say so", () => {
  const { store } = open();
  store.deliver({ path: "a.md", version: commit(1), at: at("2026-10-26T01:00:00Z"), runId: RUN_A, title: "A", kind: "markdown" });
  store.deliver({ path: "b.md", version: commit(1), at: at("2026-10-26T02:00:00Z"), runId: RUN_A, title: "B", kind: "markdown" });
  assert.deepEqual(
    store.list().map((doc) => doc.path),
    ["b.md", "a.md"],
  );
  store.deliver({ path: "a.md", version: commit(2), at: at("2026-10-26T03:00:00Z"), runId: RUN_A, title: "A", kind: "markdown" });
  assert.deepEqual(
    store.list().map((doc) => doc.path),
    ["a.md", "b.md"],
  );

  assert.equal(store.versions("zzzzzz"), undefined);
  assert.deepEqual(store.annotations("zzzzzz"), []);
  assert.equal(store.annotation("zzzzzz"), undefined);
  assert.equal(store.revisionOf("zzzzzz"), undefined);
});

test("a new store reads the same documents, versions and annotations in the same order, and the file passes the contract's schemas", () => {
  const { file, events, store } = open();
  const md = essay(store);
  store.deliver({ path: "page.html", version: commit(1), at: at("2026-10-26T01:01:00Z"), runId: RUN_A, taskId: TASK, title: "页面", kind: "html" });
  store.deliver({ path: "essay.md", version: commit(2), at: at("2026-10-26T01:02:00Z"), runId: RUN_B, title: "文章", kind: "markdown" });
  const [note] = store.submit({
    documentId: md.id,
    version: commit(2),
    runId: RUN_C,
    at: at("2026-10-26T01:03:00Z"),
    annotations: [{ target: { kind: "passage", quote: "文章", prefix: "", suffix: "" }, comment: "改" }],
  });
  if (!note) throw new Error("the batch has one annotation");
  store.reply(note.id, RUN_C, "改了", at("2026-10-26T01:04:00Z"));

  const reopened = new DocumentStore({ file, events, now });
  assert.deepEqual(reopened.list(), store.list());
  assert.deepEqual(reopened.versions(md.id), store.versions(md.id));
  assert.deepEqual(reopened.annotations(md.id), store.annotations(md.id));
  assert.equal(reopened.revisionOf(md.id), undefined);

  const data = JSON.parse(fs.readFileSync(file, "utf8")) as { documents: { document: unknown; versions: unknown[] }[]; annotations: unknown[] };
  assert.equal(data.documents.length, 2);
  for (const entry of data.documents) {
    DocumentSchema.parse(entry.document);
    for (const version of entry.versions) DocumentVersionSchema.parse(version);
  }
  for (const annotation of data.annotations) AnnotationSchema.parse(annotation);
});

test("readDocumentFile: a missing file is empty, and a file that is not a document file is an error naming it", () => {
  assert.deepEqual(readDocumentFile(path.join(tmp, "nothing", "documents.json")), { documents: [], annotations: [] });

  const dir = path.join(tmp, "broken");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "documents.json");
  const events = new EventLog(path.join(dir, "events.jsonl"));
  const broken = [
    "{ not json",
    JSON.stringify({ documents: "nope", annotations: [] }),
    JSON.stringify({ documents: [{ document: { id: "k7m2qa" }, versions: [] }], annotations: [] }),
  ];
  for (const text of broken) {
    fs.writeFileSync(file, text);
    assert.throws(() => readDocumentFile(file), (err: unknown) => err instanceof Error && err.message.includes(file));
    assert.throws(
      () => new DocumentStore({ file, events, now }),
      (err: unknown) => err instanceof Error && err.message.includes(file),
    );
  }
});
