import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { MemoryListSchema, MemoryResultSchema } from "../api/schema.ts";
import type { MemoryCreate, MemoryDelete, MemoryUpdate } from "../api/schema.ts";
import { Versions } from "../documents/versions.ts";
import { MEMORY_FILE_RE, formatMemory, loadMemories, parseMemory, syncMemoryIndex } from "./memory.ts";
import type { Locked } from "./memory.ts";
import { type MemoryLocker, createMemory, deleteMemory, memoryCommands, memoryFileName, memoryList, updateMemory } from "./memory-edit.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-memory-edit-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let seq = 0;

/** A workspace with an empty memory/ folder, or with none. */
function workspace(withMemoryDir = true): string {
  const dir = path.join(tmp, `ws-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  if (withMemoryDir) fs.mkdirSync(path.join(dir, "memory"));
  return dir;
}

const sha256 = (data: string | Buffer) => crypto.createHash("sha256").update(data).digest("hex");
const memoryFile = (ws: string, file: string) => path.join(ws, "memory", file);
const readMemoryFile = (ws: string, file: string) => fs.readFileSync(memoryFile(ws, file), "utf8");
const index = (ws: string) => fs.readFileSync(memoryFile(ws, "MEMORY.md"), "utf8");

function write(ws: string, file: string, fields: { name: string; description?: string; type?: string; updated: string; body?: string }): string {
  const text = formatMemory({ description: "", type: "preference", body: "A fact.", ...fields });
  fs.writeFileSync(memoryFile(ws, file), text);
  return text;
}

const TODAY = "2026-10-29";
const create = (over: Partial<MemoryCreate> = {}): MemoryCreate => ({
  type: "memory.create",
  name: "Prefers metric units",
  description: "Use kilometres.",
  kind: "preference",
  body: "Convert miles.",
  ...over,
});
const update = (file: string, version: string, over: Partial<MemoryUpdate> = {}): MemoryUpdate => ({
  type: "memory.update",
  file,
  version,
  name: "Edited",
  description: "Edited description.",
  kind: "project",
  body: "Edited body.",
  ...over,
});
const del = (file: string, version: string): MemoryDelete => ({ type: "memory.delete", file, version });

/** The reply of an outcome that is ok. */
function okBody<T>(outcome: { reply: { ok: true; body: T } | { ok: false; status: number; error: string } }): T {
  assert.ok(outcome.reply.ok, JSON.stringify(outcome.reply));
  return outcome.reply.body;
}

function refusal(outcome: { reply: { ok: boolean; status?: number; error?: string } }): [number | undefined, string | undefined] {
  assert.equal(outcome.reply.ok, false);
  return [outcome.reply.status, outcome.reply.error];
}

// --- The list -----------------------------------------------------------------

test("the list is most recently updated first, a memory with no date last, and each version is the hash of the file's bytes", () => {
  const ws = workspace();
  write(ws, "b-old.md", { name: "Beta", updated: "2026-10-01" });
  write(ws, "a-old.md", { name: "Alpha", updated: "2026-10-01" });
  write(ws, "new.md", { name: "New", updated: "2026-10-20", type: "user" });
  fs.writeFileSync(memoryFile(ws, "bare.md"), "just text, no frontmatter\r\n");
  const { memories, promptCount } = memoryList(ws);

  assert.deepEqual(memories.map((m) => m.file), ["new.md", "a-old.md", "b-old.md", "bare.md"], "newest first, a tie by name, no date last");
  for (const m of memories) assert.equal(m.version, sha256(fs.readFileSync(memoryFile(ws, m.file))), `${m.file}: the hash of the bytes`);
  assert.equal(memories[0]?.kind, "user");
  assert.equal(memories[0]?.updated, "2026-10-20");
  assert.deepEqual(memories[3], {
    file: "bare.md",
    name: "bare",
    description: "",
    kind: "",
    updated: "",
    body: "just text, no frontmatter",
    version: sha256("just text, no frontmatter\r\n"),
  });
  assert.equal(promptCount, 4, "all of them fit the prompt's index");
  assert.deepEqual(MemoryListSchema.parse({ memories, promptCount }), { memories, promptCount });
});

test("the list leaves out what the index leaves out, and reads an updated that is not a date as none", () => {
  const ws = workspace();
  write(ws, "real.md", { name: "Real", updated: "2026-10-02" });
  fs.writeFileSync(memoryFile(ws, "odd.md"), "---\nname: Odd\ntype: user\nupdated: yesterday\n---\n\nBody\n");
  syncMemoryIndex(ws);
  fs.writeFileSync(memoryFile(ws, "notes.txt"), "not a memory");
  fs.mkdirSync(memoryFile(ws, "folder.md"));
  fs.symlinkSync(path.join(tmp, "elsewhere.md"), memoryFile(ws, "link.md"));

  const { memories } = memoryList(ws);
  // The order is the index's (it sorts on the text the file holds), so that promptCount counts the right memories.
  assert.deepEqual(memories.map((m) => [m.file, m.updated]), [["odd.md", ""], ["real.md", "2026-10-02"]]);
  assert.deepEqual(memories.map((m) => m.file), loadMemories(ws).map((m) => m.file));
  assert.deepEqual(memoryList(workspace(false)), { memories: [], promptCount: 0 }, "no memory folder is an empty list");
});

test("promptCount is how many of the first memories fit the index under capIndex's caps", () => {
  const ws = workspace();
  for (let i = 0; i < 5; i++) write(ws, `m${i}.md`, { name: `Memory ${i}`, description: "d".repeat(40), updated: `2026-10-0${i + 1}` });
  assert.equal(memoryList(ws).promptCount, 5, "under the real caps");
  assert.equal(memoryList(ws, { maxLines: 2 }).promptCount, 2, "under a cap of two lines");
  assert.equal(memoryList(ws, { maxBytes: 150 }).promptCount, 2, "under a cap of bytes: 3 lines of about 70 bytes do not fit");
  assert.equal(memoryList(ws, { maxBytes: 10 }).promptCount, 0);
  const { memories, promptCount } = memoryList(ws, { maxLines: 2 });
  assert.equal(memories.length, 5, "the list holds all of them");
  assert.deepEqual(memories.slice(0, promptCount).map((m) => m.file), ["m4.md", "m3.md"], "the first ones are in the prompt");

  const many = workspace();
  for (let i = 0; i < 205; i++) write(many, `m${String(i).padStart(3, "0")}.md`, { name: `M${i}`, updated: "2026-10-01" });
  const real = memoryList(many);
  assert.equal(real.memories.length, 205);
  assert.equal(real.promptCount, 200, "the real cap is 200 lines");
});

// --- memory.create ------------------------------------------------------------

test("a file name comes from the name: lowercase ASCII letters and digits with hyphens between", () => {
  const none = () => false;
  assert.equal(memoryFileName("Prefers metric units", TODAY, none), "prefers-metric-units.md");
  assert.equal(memoryFileName("  Mixed_CASE, v2.0 (draft)! ", TODAY, none), "mixed-case-v2-0-draft.md");
  assert.equal(memoryFileName("Alfred 项目", TODAY, none), "alfred.md", "non-ASCII characters are separators");
  assert.equal(memoryFileName("2026", TODAY, none), "2026.md");
  assert.equal(memoryFileName("---a---b---", TODAY, none), "a-b.md");
  for (const name of ["住在上海", "!!!", "😀", "—"]) {
    assert.match(memoryFileName(name, TODAY, none), /^memory-20261029-[a-z0-9]{4}\.md$/, `a name with no ASCII letter or digit: ${name}`);
  }
  assert.notEqual(memoryFileName("住在上海", TODAY, none), memoryFileName("住在上海", TODAY, none), "the four characters are drawn at random");
});

test("a file name never has more than 80 characters before .md, a collision gets -2, -3 and on, and every name matches MEMORY_FILE_RE", () => {
  const taken = new Set<string>();
  const next = (name: string) => {
    const file = memoryFileName(name, TODAY, (candidate) => taken.has(candidate));
    taken.add(file);
    return file;
  };
  assert.deepEqual([next("Same"), next("Same"), next("Same"), next("same!")], ["same.md", "same-2.md", "same-3.md", "same-4.md"]);

  const long = "a".repeat(80);
  assert.equal(next(long), `${long}.md`, "80 characters fit");
  const second = next(long);
  assert.equal(second, `${"a".repeat(78)}-2.md`, "the suffix is made to fit");
  const hyphenated = `${"a".repeat(77)}-b`;
  assert.equal(next(hyphenated), `${hyphenated}.md`);
  const cut = next(hyphenated);
  assert.equal(cut, `${"a".repeat(77)}-2.md`, "a hyphen the cut leaves at the end is dropped");

  for (const file of taken) {
    assert.match(file, MEMORY_FILE_RE);
    assert.ok(file.length - 3 <= 80, file);
  }
  for (let i = 0; i < 15; i++) assert.match(next("x".repeat(80)), MEMORY_FILE_RE);
});

test("memory.create writes the file with the five fields, dated today, and answers with the memory as the file holds it", () => {
  const ws = workspace();
  const body = okBody(createMemory(ws, create({ body: "  Convert miles.\n\nAnd pounds.  " }), TODAY));
  assert.equal(body.memory.file, "prefers-metric-units.md");
  assert.deepEqual(
    { ...body.memory, version: undefined },
    {
      file: "prefers-metric-units.md",
      name: "Prefers metric units",
      description: "Use kilometres.",
      kind: "preference",
      updated: TODAY,
      body: "Convert miles.\n\nAnd pounds.",
      version: undefined,
    },
  );
  const text = readMemoryFile(ws, "prefers-metric-units.md");
  assert.equal(text, "---\nname: \"Prefers metric units\"\ndescription: \"Use kilometres.\"\ntype: preference\nupdated: 2026-10-29\n---\n\nConvert miles.\n\nAnd pounds.\n");
  assert.equal(body.memory.version, sha256(text), "the version is the hash of the file");
  assert.deepEqual(MemoryResultSchema.parse(body), body);
  assert.deepEqual(memoryList(ws).memories, [body.memory], "the list agrees with the answer");
});

test("memory.create rebuilds the index, and a Chinese name gets a generated file name that is a MEMORY_FILE_RE match", () => {
  const ws = workspace();
  const { memory } = okBody(createMemory(ws, create({ name: "住在上海", description: "主人住在上海。", kind: "user", body: "独立开发。" }), TODAY));
  assert.match(memory.file, /^memory-20261029-[a-z0-9]{4}\.md$/);
  assert.match(memory.file, MEMORY_FILE_RE);
  assert.equal(memory.name, "住在上海");
  assert.ok(index(ws).includes(`- [住在上海](${memory.file}) — 主人住在上海。`), index(ws));
});

test("two memories with one name get two files, and an existing file is never replaced, a symlink included", () => {
  const ws = workspace();
  const first = okBody(createMemory(ws, create({ body: "First." }), TODAY)).memory;
  const second = okBody(createMemory(ws, create({ body: "Second." }), TODAY)).memory;
  assert.deepEqual([first.file, second.file], ["prefers-metric-units.md", "prefers-metric-units-2.md"]);
  assert.equal(parseMemory(first.file, readMemoryFile(ws, first.file)).body, "First.", "the first is as it was");

  const outside = path.join(tmp, "outside-target.md");
  fs.symlinkSync(outside, memoryFile(ws, "prefers-metric-units-3.md"));
  const third = okBody(createMemory(ws, create({ body: "Third." }), TODAY)).memory;
  assert.equal(third.file, "prefers-metric-units-4.md", "a dangling link is a taken name, and nothing is written through it");
  assert.equal(fs.existsSync(outside), false);
  assert.deepEqual(memoryList(ws).memories.map((m) => m.file).sort(), ["prefers-metric-units-2.md", "prefers-metric-units-4.md", "prefers-metric-units.md"]);
});

test("memory.create makes a missing memory folder, and refuses when `memory` is a link that leaves the workspace", () => {
  const bare = workspace(false);
  assert.equal(okBody(createMemory(bare, create(), TODAY)).memory.file, "prefers-metric-units.md");
  assert.ok(fs.existsSync(path.join(bare, "memory", "MEMORY.md")), "and its index");

  const ws = workspace(false);
  const elsewhere = path.join(tmp, `elsewhere-${seq}`);
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(ws, "memory"));
  const [status, error] = refusal(createMemory(ws, create(), TODAY));
  assert.equal(status, 409);
  assert.match(error ?? "", /not a folder in the workspace/);
  assert.deepEqual(fs.readdirSync(elsewhere), [], "nothing was written outside");
});

// --- memory.update ------------------------------------------------------------

test("memory.update replaces the fields, dates the memory today, keeps only the five known fields and rebuilds the index", () => {
  const ws = workspace();
  const text = "---\nname: \"Old name\"\ndescription: \"Old description\"\ntype: user\nupdated: 2026-01-01\nsource: chat\n---\n\nOld body\n";
  fs.writeFileSync(memoryFile(ws, "old.md"), text);
  syncMemoryIndex(ws);
  assert.ok(index(ws).includes("[Old name](old.md)"));

  const { memory } = okBody(updateMemory(ws, update("old.md", sha256(text)), TODAY));
  assert.deepEqual(
    { ...memory, version: undefined },
    { file: "old.md", name: "Edited", description: "Edited description.", kind: "project", updated: TODAY, body: "Edited body.", version: undefined },
  );
  const after = readMemoryFile(ws, "old.md");
  assert.equal(after, "---\nname: \"Edited\"\ndescription: \"Edited description.\"\ntype: project\nupdated: 2026-10-29\n---\n\nEdited body.\n", "the source field is gone");
  assert.equal(memory.version, sha256(after));
  assert.ok(index(ws).includes("- [Edited](old.md) — Edited description."));
  assert.ok(!index(ws).includes("Old name"));
  assert.equal(fs.readdirSync(path.join(ws, "memory")).filter((f) => f.endsWith(".tmp")).length, 0, "no temporary file is left");
});

test("memory.update against a stale version is 409 and changes nothing; an unknown file is 404", () => {
  const ws = workspace();
  const first = write(ws, "a.md", { name: "A", updated: "2026-10-01" });
  const version = sha256(first);
  okBody(updateMemory(ws, update("a.md", version), TODAY));

  const changed = readMemoryFile(ws, "a.md");
  const [status, error] = refusal(updateMemory(ws, update("a.md", version, { name: "Late" }), TODAY));
  assert.equal(status, 409, "the version read before the first update is stale now");
  assert.match(error ?? "", /^version: not the current version of a\.md/);
  assert.equal(readMemoryFile(ws, "a.md"), changed);
  assert.equal(refusal(updateMemory(ws, update("a.md", ""), TODAY))[0], 409, "an empty version is stale too");

  assert.deepEqual(refusal(updateMemory(ws, update("missing.md", version), TODAY)), [404, "no memory missing.md"]);
  assert.equal(refusal(updateMemory(workspace(false), update("a.md", version), TODAY))[0], 404, "no folder, no memory");
});

test("memory.update leaves alone what is not a memory: the index, a link and a folder are 404", () => {
  const ws = workspace();
  write(ws, "a.md", { name: "A", updated: "2026-10-01" });
  syncMemoryIndex(ws);
  const indexBytes = fs.readFileSync(memoryFile(ws, "MEMORY.md"));
  // On a file system that ignores case, memory.md would find MEMORY.md.
  assert.equal(refusal(updateMemory(ws, update("memory.md", sha256(indexBytes)), TODAY))[0], 404);
  assert.deepEqual(fs.readFileSync(memoryFile(ws, "MEMORY.md")), indexBytes);

  const target = path.join(tmp, "link-target.md");
  fs.writeFileSync(target, "target");
  fs.symlinkSync(target, memoryFile(ws, "link.md"));
  assert.equal(refusal(updateMemory(ws, update("link.md", sha256("target")), TODAY))[0], 404);
  assert.equal(fs.readFileSync(target, "utf8"), "target", "nothing was written through the link");
  fs.mkdirSync(memoryFile(ws, "dir.md"));
  assert.equal(refusal(updateMemory(ws, update("dir.md", sha256("")), TODAY))[0], 404);
});

// --- memory.delete ------------------------------------------------------------

test("memory.delete moves the file into .trash/memory/ unchanged, and the index drops it", () => {
  const ws = workspace();
  const text = write(ws, "gone.md", { name: "Gone", updated: "2026-10-01" });
  write(ws, "stays.md", { name: "Stays", updated: "2026-10-02" });
  syncMemoryIndex(ws);
  assert.ok(index(ws).includes("(gone.md)"));

  assert.deepEqual(okBody(deleteMemory(ws, del("gone.md", sha256(text)))), { deleted: true });
  assert.equal(fs.existsSync(memoryFile(ws, "gone.md")), false);
  assert.equal(fs.readFileSync(path.join(ws, ".trash", "memory", "gone.md"), "utf8"), text, "the bytes are as they were");
  assert.ok(!index(ws).includes("gone.md"));
  assert.ok(index(ws).includes("(stays.md)"));
  assert.deepEqual(memoryList(ws).memories.map((m) => m.file), ["stays.md"]);
});

test("a second delete with the same name gets a number suffix in .trash/memory/, and nothing there is overwritten", () => {
  const ws = workspace();
  const firstText = write(ws, "same.md", { name: "One", updated: "2026-10-01", body: "First." });
  okBody(deleteMemory(ws, del("same.md", sha256(firstText))));
  const secondText = write(ws, "same.md", { name: "Two", updated: "2026-10-02", body: "Second." });
  okBody(deleteMemory(ws, del("same.md", sha256(secondText))));
  const thirdText = write(ws, "same.md", { name: "Three", updated: "2026-10-03", body: "Third." });
  okBody(deleteMemory(ws, del("same.md", sha256(thirdText))));

  const trash = path.join(ws, ".trash", "memory");
  assert.deepEqual(fs.readdirSync(trash).sort(), ["same-1.md", "same-2.md", "same.md"]);
  assert.equal(fs.readFileSync(path.join(trash, "same.md"), "utf8"), firstText);
  assert.equal(fs.readFileSync(path.join(trash, "same-1.md"), "utf8"), secondText);
  assert.equal(fs.readFileSync(path.join(trash, "same-2.md"), "utf8"), thirdText);
});

test("memory.delete against a stale version is 409 and an unknown file 404, and both leave the file where it is", () => {
  const ws = workspace();
  const text = write(ws, "a.md", { name: "A", updated: "2026-10-01" });
  const [status, error] = refusal(deleteMemory(ws, del("a.md", sha256("other bytes"))));
  assert.equal(status, 409);
  assert.match(error ?? "", /^version: not the current version of a\.md/);
  assert.deepEqual(refusal(deleteMemory(ws, del("b.md", sha256(text)))), [404, "no memory b.md"]);
  assert.equal(readMemoryFile(ws, "a.md"), text);
  assert.equal(fs.existsSync(path.join(ws, ".trash")), false, "nothing was moved");
});

test("memory.delete refuses a .trash that leaves the workspace, and the file stays", () => {
  const ws = workspace();
  const text = write(ws, "a.md", { name: "A", updated: "2026-10-01" });
  const elsewhere = path.join(tmp, `trash-elsewhere-${seq}`);
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(ws, ".trash"));
  assert.equal(refusal(deleteMemory(ws, del("a.md", sha256(text))))[0], 409);
  assert.equal(readMemoryFile(ws, "a.md"), text);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

// --- The commands: the lock and the history -----------------------------------

const free: MemoryLocker = { withMemoryLock: async <T>(job: () => T): Promise<Locked<T>> => ({ locked: true, value: job() }) };

/** Stands in for the handler's lock while a memory scan holds it: it gives up without running the job. */
function busy() {
  const asked: number[] = [];
  const locker: MemoryLocker = {
    withMemoryLock: async <T>(_job: () => T, waitMs: number): Promise<Locked<T>> => {
      asked.push(waitMs);
      return { locked: false };
    },
  };
  return { locker, asked };
}

test("a command waits up to 3 s for the lock and is refused with 409 when a scan still holds it, and nothing changes", async () => {
  const ws = workspace();
  const text = write(ws, "a.md", { name: "A", updated: "2026-10-01" });
  const { locker, asked } = busy();
  const commands = memoryCommands(locker, { workspace: ws });
  const replies = [
    await commands.create(create()),
    await commands.update(update("a.md", sha256(text))),
    await commands.delete(del("a.md", sha256(text))),
  ];
  for (const reply of replies) {
    assert.equal(reply.ok, false);
    if (!reply.ok) {
      assert.equal(reply.status, 409);
      assert.match(reply.error, /tidying memory/);
      assert.match(reply.error, /try again shortly/);
    }
  }
  assert.deepEqual(asked, [3000, 3000, 3000]);
  assert.deepEqual(fs.readdirSync(path.join(ws, "memory")), ["a.md"], "no file was added, changed or moved");
  assert.equal(readMemoryFile(ws, "a.md"), text);

  const quick = busy();
  await memoryCommands(quick.locker, { workspace: ws, lockWaitMs: 40 }).create(create());
  assert.deepEqual(quick.asked, [40], "the wait can be set");
});

test("the three commands answer with what they did when the lock is free", async () => {
  const ws = workspace();
  const commands = memoryCommands(free, { workspace: ws });
  const created = await commands.create(create({ name: "Via commands" }));
  assert.ok(created.ok);
  const memory = created.ok ? (created.body as { memory: { file: string; version: string } }).memory : undefined;
  assert.equal(memory?.file, "via-commands.md");
  const updated = await commands.update(update("via-commands.md", memory?.version ?? ""));
  assert.ok(updated.ok);
  const version = updated.ok ? (updated.body as { memory: { version: string } }).memory.version : "";
  assert.deepEqual(await commands.delete(del("via-commands.md", version)), { ok: true, body: { deleted: true } });
  assert.equal((await commands.delete(del("via-commands.md", version))).ok, false, "a second delete finds no file");
});

test("two updates made against one version cannot both win: the second is 409, not a lost update", async () => {
  const ws = workspace();
  const text = write(ws, "a.md", { name: "A", updated: "2026-10-01" });
  const commands = memoryCommands(free, { workspace: ws });
  const version = sha256(text);
  const [one, two] = await Promise.all([
    commands.update(update("a.md", version, { name: "From one" })),
    commands.update(update("a.md", version, { name: "From two" })),
  ]);
  assert.deepEqual([one.ok, two.ok], [true, false]);
  assert.equal(parseMemory("a.md", readMemoryFile(ws, "a.md")).name, "From one");
});

/** A history of its own for a workspace; the commit messages, oldest first, and the files each commit changed. */
async function history(ws: string) {
  const gitDir = path.join(tmp, `git-${seq}`);
  const versions = new Versions({ workspace: ws, gitDir });
  await versions.init();
  const log = (): { message: string; files: string[] }[] =>
    execFileSync("git", [`--git-dir=${gitDir}`, `--work-tree=${ws}`, "log", "--reverse", "--name-status", "--no-renames", "--format=%x00%s"], { encoding: "utf8" })
      .split("\0")
      .filter((entry) => entry.trim())
      .map((entry) => {
        const [message = "", ...files] = entry.trim().split("\n").filter((line) => line);
        return { message, files: files.map((line) => line.replace("\t", " ")).sort() };
      });
  return { versions, log };
}

test("each change is committed to the history as Add, Edit or Delete memory/<file>, with the index", async () => {
  const ws = workspace();
  const h = await history(ws);
  const commands = memoryCommands(free, { workspace: ws, versions: h.versions });

  const created = await commands.create(create({ name: "Committed" }));
  assert.ok(created.ok);
  const version = (created.ok ? created.body : undefined) as { memory: { version: string } };
  const updated = await commands.update(update("committed.md", version.memory.version));
  assert.ok(updated.ok);
  const next = (updated.ok ? updated.body : undefined) as { memory: { version: string } };
  assert.ok((await commands.delete(del("committed.md", next.memory.version))).ok);

  const [, add, edit, remove] = h.log();
  assert.deepEqual(add, { message: "Add memory/committed.md", files: ["A memory/MEMORY.md", "A memory/committed.md"] });
  assert.deepEqual(edit, { message: "Edit memory/committed.md", files: ["M memory/MEMORY.md", "M memory/committed.md"] });
  assert.deepEqual(remove, { message: "Delete memory/committed.md", files: ["D memory/committed.md", "M memory/MEMORY.md"] }, "the old path is deleted; .trash/ is not versioned");
  assert.equal(h.log().length, 4, "the initial version and one commit for each change");
});

test("a failed commit is logged and the answer stays ok; a refused command commits nothing", async () => {
  const ws = workspace();
  const committed: { message: string; paths?: string[] }[] = [];
  let failing = true;
  const versions = {
    commit: async (message: string, opts: { paths?: string[] } = {}) => {
      committed.push({ message, paths: opts.paths });
      if (failing) throw new Error("git is unhappy");
      return undefined;
    },
  };
  const commands = memoryCommands(free, { workspace: ws, versions });
  const created = await commands.create(create({ name: "Kept" }));
  assert.equal(created.ok, true, "the memory is written whatever the history says");
  assert.ok(fs.existsSync(memoryFile(ws, "kept.md")));
  assert.deepEqual(committed, [{ message: "Add memory/kept.md", paths: ["memory/kept.md", "memory/MEMORY.md"] }]);

  failing = false;
  const stale = await commands.update(update("kept.md", "stale"));
  assert.equal(stale.ok, false);
  assert.equal((await commands.update(update("nope.md", "x"))).ok, false);
  const { locker } = busy();
  assert.equal((await memoryCommands(locker, { workspace: ws, versions }).create(create())).ok, false);
  assert.equal(committed.length, 1, "a refusal is not committed");

  const current = parseMemory("kept.md", readMemoryFile(ws, "kept.md"));
  assert.equal(current.name, "Kept");
  const text = readMemoryFile(ws, "kept.md");
  assert.equal((await commands.delete(del("kept.md", sha256(text)))).ok, true);
  assert.deepEqual(committed.at(-1), { message: "Delete memory/kept.md", paths: ["memory/kept.md", ".trash/memory/kept.md", "memory/MEMORY.md"] });
});
