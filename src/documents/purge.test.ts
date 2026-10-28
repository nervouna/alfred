import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// store.ts reads these at import time, so set them before loading the module under test. The workspace is set too,
// so a test that forgot to pass one would sweep a scratch directory, not the owner's.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-purge-")));
Object.assign(process.env, { ALFRED_STATE_DIR: path.join(tmp, "state"), ALFRED_WORKSPACE: path.join(tmp, "unused-workspace") });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { TRASH_RETENTION_DAYS, TRASH_STATE_FILE, pruneTrash } = await import("./purge.ts");

const DAY = 86_400_000;
/** The clock the sweeps start at. Every sweep is given its time, so no test waits for a timer. */
const T0 = Date.parse("2026-10-01T00:00:00Z");
/** The stamp a sweep writes for a time `days` days after T0. */
const stamp = (days: number) => new Date(T0 + days * DAY).toISOString();

let cases = 0;
/** A workspace of its own, with the stamps file beside it: the inputs of a sweep. */
function sandbox() {
  const dir = path.join(tmp, `case-${cases++}`);
  const workspace = path.join(dir, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  return { workspace, trash: path.join(workspace, ".trash"), file: path.join(dir, "state", "trash.json") };
}
type Sandbox = ReturnType<typeof sandbox>;

/** A sweep of the sandbox at `days` days after T0. */
const sweep = (s: Sandbox, days: number, onPurged?: (paths: string[]) => void) =>
  pruneTrash({ now: T0 + days * DAY, workspace: s.workspace, file: s.file, onPurged });

/** Writes a file under .trash/ and returns its path. */
function put(s: Sandbox, rel: string, text = "x"): string {
  const abs = path.join(s.trash, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return abs;
}

/** Whether something is at a path, a link included: existsSync follows links, so a dangling one would look gone. */
function present(abs: string): boolean {
  try {
    fs.lstatSync(abs);
    return true;
  } catch {
    return false;
  }
}

const stamps = (s: Sandbox): Record<string, string> => JSON.parse(fs.readFileSync(s.file, "utf8"));

test("the stamps are in the workbench state directory, owner-only, and the retention is 30 days", () => {
  assert.equal(TRASH_RETENTION_DAYS, 30);
  assert.equal(TRASH_STATE_FILE, path.join(tmp, "state", "workbench", "trash.json"));
  const s = sandbox();
  put(s, "a.md");
  sweep(s, 0);
  assert.equal(fs.statSync(s.file).mode & 0o777, 0o600);
});

test("the first sweep stamps each file in .trash/ with the time it sees it, and removes nothing", () => {
  const s = sandbox();
  const a = put(s, "a.md", "keep");
  const b = put(s, "memory/b.md");
  assert.equal(sweep(s, 0), 0);
  assert.deepEqual(stamps(s), { "a.md": stamp(0), "memory/b.md": stamp(0) });
  assert.equal(fs.readFileSync(a, "utf8"), "keep");
  assert.ok(present(b));
});

test("the age of a file is the time the sweep first saw it, not its mtime", () => {
  const s = sandbox();
  const old = put(s, "old-mtime.md");
  const ninetyDaysAgo = new Date(T0 - 90 * DAY);
  fs.utimesSync(old, ninetyDaysAgo, ninetyDaysAgo);
  assert.equal(sweep(s, 0), 0, "a file that looks 90 days old is stamped, not removed");
  assert.deepEqual(stamps(s), { "old-mtime.md": stamp(0) });
});

test("a file is kept 29 days after the sweep first saw it, and removed 31 days after", () => {
  const s = sandbox();
  const a = put(s, "a.md");
  sweep(s, 0);
  assert.equal(sweep(s, 29), 0);
  assert.ok(present(a));
  assert.equal(sweep(s, 31), 1);
  assert.ok(!present(a));
  assert.deepEqual(stamps(s), {});
});

test("a directory of files is removed file by file, with the directories the removal empties; .trash/ itself stays", () => {
  const s = sandbox();
  const deep = put(s, "old/deep/a.md");
  put(s, "old/b.md");
  put(s, "mixed/gone.md");
  sweep(s, 0);
  const young = put(s, "mixed/young.md");
  sweep(s, 20);
  assert.equal(sweep(s, 31), 3);
  assert.ok(!present(deep));
  assert.ok(!present(path.join(s.trash, "old")), "the directory the removal emptied goes");
  assert.ok(present(young), "a file the sweep saw 11 days ago stays");
  assert.ok(present(path.join(s.trash, "mixed")), "a directory with a file left in it stays");
  assert.ok(present(s.trash));
});

test("a file added to a directory the sweep already knows has a stamp of its own", () => {
  const s = sandbox();
  const a = put(s, "memory/a.md");
  sweep(s, 0);
  const b = put(s, "memory/b.md");
  sweep(s, 20);
  assert.equal(sweep(s, 31), 1);
  assert.ok(!present(a));
  assert.ok(present(b));
  assert.deepEqual(stamps(s), { "memory/b.md": stamp(20) });
});

test("a file restored out of .trash/ loses its stamp, and trashed again it is stamped afresh", () => {
  const s = sandbox();
  const a = put(s, "a.md");
  sweep(s, 0);
  fs.mkdirSync(path.join(s.workspace, "notes"));
  fs.renameSync(a, path.join(s.workspace, "notes", "a.md"));
  sweep(s, 1);
  assert.deepEqual(stamps(s), {}, "the stamp of a file that is gone is dropped");
  put(s, "a.md");
  assert.equal(sweep(s, 31), 0, "trashed again it is stamped, not removed for its old stamp");
  assert.deepEqual(stamps(s), { "a.md": stamp(31) });
});

test("a symlink in .trash/ is removed as a link, and what it points to is left alone", () => {
  const s = sandbox();
  const target = path.join(s.workspace, "notes", "target.md");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "keep me");
  const dir = path.join(s.workspace, "notes", "dir");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "inside.md"), "keep me too");
  fs.mkdirSync(s.trash);
  const fileLink = path.join(s.trash, "file-link.md");
  const dirLink = path.join(s.trash, "dir-link");
  fs.symlinkSync(target, fileLink);
  fs.symlinkSync(dir, dirLink);
  sweep(s, 0);
  assert.equal(sweep(s, 31), 2);
  assert.ok(!present(fileLink));
  assert.ok(!present(dirLink));
  assert.equal(fs.readFileSync(target, "utf8"), "keep me");
  assert.equal(fs.readFileSync(path.join(dir, "inside.md"), "utf8"), "keep me too");
});

test("a .trash/ that is itself a link is not followed: nothing in its target is swept", () => {
  const s = sandbox();
  const elsewhere = path.join(s.workspace, "..", "elsewhere");
  fs.mkdirSync(elsewhere);
  const victim = path.join(elsewhere, "victim.md");
  fs.writeFileSync(victim, "keep");
  fs.symlinkSync(elsewhere, s.trash);
  assert.equal(sweep(s, 0), 0);
  assert.equal(sweep(s, 31), 0);
  assert.equal(fs.readFileSync(victim, "utf8"), "keep");
  assert.ok(fs.lstatSync(s.trash).isSymbolicLink());
});

test("a missing .trash/ removes nothing, and a corrupt stamps file starts over without throwing", () => {
  const s = sandbox();
  assert.equal(sweep(s, 0), 0, "there is no .trash/ yet");
  fs.mkdirSync(path.dirname(s.file), { recursive: true });
  fs.writeFileSync(s.file, "{ not json");
  const a = put(s, "a.md");
  assert.equal(sweep(s, 0), 0);
  assert.deepEqual(stamps(s), { "a.md": stamp(0) }, "the corrupt stamps are dropped and the file stamped anew");
  assert.ok(present(a));
});

test("an entry that is neither a file, a directory nor a link is left alone", () => {
  const s = sandbox();
  fs.mkdirSync(s.trash);
  const pipe = path.join(s.trash, "pipe");
  execFileSync("mkfifo", [pipe]);
  sweep(s, 0);
  assert.equal(sweep(s, 31), 0);
  assert.ok(present(pipe));
  assert.deepEqual(stamps(s), {});
});

test("a file that cannot be removed keeps its stamp, and the sweep goes on", () => {
  const s = sandbox();
  const locked = put(s, "locked/x.md");
  const other = put(s, "other.md");
  sweep(s, 0);
  fs.chmodSync(path.dirname(locked), 0o500);
  try {
    assert.equal(sweep(s, 31), 1);
    assert.ok(!present(other));
    assert.ok(present(locked));
    assert.deepEqual(stamps(s), { "locked/x.md": stamp(0) });
  } finally {
    fs.chmodSync(path.dirname(locked), 0o700);
  }
});

test("onPurged gets the workspace paths of the files a sweep removed, once, and is not called when it removed none", () => {
  const s = sandbox();
  put(s, "a.md");
  put(s, "dir/b.md");
  sweep(s, 0);
  const calls: string[][] = [];
  const record = (paths: string[]) => calls.push(paths);
  assert.equal(sweep(s, 10, record), 0);
  assert.deepEqual(calls, []);
  assert.equal(sweep(s, 31, record), 2);
  assert.deepEqual(calls, [[".trash/a.md", ".trash/dir/b.md"]]);
});

test("a failing onPurged is logged, and the files are removed and the stamps kept as the sweep left them", () => {
  const s = sandbox();
  const a = put(s, "a.md");
  sweep(s, 0);
  assert.equal(
    sweep(s, 31, () => {
      throw new Error("the documents file is full");
    }),
    1,
  );
  assert.ok(!present(a));
  assert.deepEqual(stamps(s), {});
});
