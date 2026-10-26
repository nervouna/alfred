import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { VERSION_MAX_BYTES, Versions } from "./versions.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-versions-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let fixtures = 0;

/** A fresh workspace and git dir, the git dir outside the workspace as in production. */
function fixture() {
  const dir = path.join(tmp, `case-${fixtures++}`);
  const workspace = path.join(dir, "workspace");
  const gitDir = path.join(dir, "workbench", "versions.git");
  fs.mkdirSync(workspace, { recursive: true });
  return { workspace, gitDir, versions: new Versions({ workspace, gitDir }) };
}

function write(workspace: string, rel: string, content: string | Buffer): void {
  const abs = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function read(workspace: string, rel: string): string {
  return fs.readFileSync(path.join(workspace, rel), "utf8");
}

/** The subject of the newest commit, read with git itself. */
function subject(gitDir: string, workspace: string): string {
  return execFileSync("git", [`--git-dir=${gitDir}`, `--work-tree=${workspace}`, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim();
}

test("init on an empty workspace makes an empty first commit with the initial message, in a git dir that only its owner can use", async () => {
  const f = fixture();
  const head = await f.versions.init();
  assert.match(head, /^[0-9a-f]{40}$/);
  assert.equal(await f.versions.head(), head);
  assert.equal(subject(f.gitDir, f.workspace), "Initial version of the workspace");
  assert.deepEqual(await f.versions.changedFiles(head), []);
  assert.equal(await f.versions.parent(head), undefined);
  assert.equal(fs.statSync(f.gitDir).mode & 0o777, 0o700);
});

test("init on a non-empty workspace commits what the rules admit, and a second init changes nothing", async () => {
  const f = fixture();
  write(f.workspace, "notes/a.md", "a");
  write(f.workspace, "photo.png", "not versioned");
  const head = await f.versions.init();
  assert.deepEqual(await f.versions.changedFiles(head), ["notes/a.md"]);
  const exclude = fs.readFileSync(path.join(f.gitDir, "info", "exclude"), "utf8");
  assert.match(exclude, /^\/inbox\/$/m);
  assert.match(exclude, /^\/\.trash\/$/m);
  assert.match(exclude, /^\*\.\[pP\]\[nN\]\[gG\]$/m);

  write(f.workspace, "later.md", "after the first init");
  assert.equal(await f.versions.init(), head);
  assert.equal(await f.versions.head(), head);
  assert.equal(fs.readFileSync(path.join(f.gitDir, "info", "exclude"), "utf8"), exclude);
  assert.equal(await f.versions.show(head, "later.md"), undefined);
});

test("a plain commit versions text files, and leaves out inbox/ and .trash/", async () => {
  const f = fixture();
  const head = await f.versions.init();
  write(f.workspace, "notes/a.md", "a");
  write(f.workspace, "data.json", "{}");
  write(f.workspace, "page.html", "<p>x</p>");
  write(f.workspace, "chart.svg", "<svg/>");
  write(f.workspace, "table.csv", "a,b");
  write(f.workspace, "inbox/2026-10-27/upload.md", "not versioned");
  write(f.workspace, ".trash/old.md", "not versioned");
  const commit = await f.versions.commit("text");
  assert.ok(commit);
  assert.deepEqual(commit.files, ["chart.svg", "data.json", "notes/a.md", "page.html", "table.csv"]);
  assert.notEqual(commit.version, head);
});

test("the extension rule ignores case and covers the listed image, PDF, audio and video types", async () => {
  const f = fixture();
  await f.versions.init();
  for (const name of ["photo.PNG", "scan.pdf", "clip.Mp4", "voice.opus", "shot.heic", "frame.TIFF", "song.m4a"]) {
    write(f.workspace, name, "plain text content");
  }
  write(f.workspace, "text.md", "versioned");
  const commit = await f.versions.commit("types");
  assert.deepEqual(commit?.files, ["text.md"]);
});

test("a binary file without a listed extension is left out, and a NUL byte past the first 8000 bytes does not make a file binary", async () => {
  const f = fixture();
  await f.versions.init();
  write(f.workspace, "blob.dat", Buffer.from([1, 0, 2]));
  write(f.workspace, "early.txt", Buffer.from("a\0b"));
  write(f.workspace, "late.txt", Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])]));
  const commit = await f.versions.commit("binary");
  assert.deepEqual(commit?.files, ["late.txt"]);
});

test("a file over 20 MB is left out, and one of exactly 20 MB is versioned", async () => {
  const f = fixture();
  await f.versions.init();
  write(f.workspace, "big.txt", Buffer.alloc(VERSION_MAX_BYTES + 1, 0x61));
  write(f.workspace, "limit.txt", Buffer.alloc(VERSION_MAX_BYTES, 0x61));
  const commit = await f.versions.commit("sizes");
  assert.deepEqual(commit?.files, ["limit.txt"]);
});

test("a tracked file that grows past 20 MB keeps its last version", async () => {
  const f = fixture();
  await f.versions.init();
  write(f.workspace, "grow.txt", "small");
  const first = await f.versions.commit("small");
  assert.ok(first);
  write(f.workspace, "grow.txt", Buffer.alloc(VERSION_MAX_BYTES + 1, 0x61));
  write(f.workspace, "other.md", "x");
  const second = await f.versions.commit("grown");
  assert.deepEqual(second?.files, ["other.md"]);
  assert.equal((await f.versions.show(second!.version, "grow.txt"))?.toString(), "small");
});

test("forced files are committed whatever their type or directory, a forced file over 20 MB is not, and a plain commit picks up later changes to a forced file", async () => {
  const f = fixture();
  await f.versions.init();
  write(f.workspace, "scan.pdf", "v1");
  write(f.workspace, "inbox/memo.md", "v1");
  const forced = await f.versions.commit("forced", { force: ["scan.pdf", "inbox/memo.md"] });
  assert.deepEqual(forced?.files, ["inbox/memo.md", "scan.pdf"]);

  write(f.workspace, "scan.pdf", "v2");
  const plain = await f.versions.commit("plain");
  assert.deepEqual(plain?.files, ["scan.pdf"]);
  assert.equal((await f.versions.show(plain!.version, "scan.pdf"))?.toString(), "v2");

  write(f.workspace, "huge.pdf", Buffer.alloc(VERSION_MAX_BYTES + 1, 0x61));
  assert.equal(await f.versions.commit("huge", { force: ["huge.pdf"] }), undefined);
});

test("commit with paths leaves other changes uncommitted", async () => {
  const f = fixture();
  await f.versions.init();
  write(f.workspace, "a.md", "a");
  write(f.workspace, "b.md", "b");
  const first = await f.versions.commit("a only", { paths: ["a.md"] });
  assert.deepEqual(first?.files, ["a.md"]);
  assert.equal(await f.versions.show(first!.version, "b.md"), undefined);
  const rest = await f.versions.commit("rest");
  assert.deepEqual(rest?.files, ["b.md"]);
});

test("a commit with nothing to commit resolves to undefined and makes no commit", async () => {
  const f = fixture();
  const head = await f.versions.init();
  assert.equal(await f.versions.commit("nothing"), undefined);
  assert.equal(await f.versions.head(), head);
});

test("Commit reports the time in UTC and the files of an add, a change and a delete", async () => {
  const f = fixture();
  write(f.workspace, "a.md", "a");
  write(f.workspace, "b.md", "b");
  await f.versions.init();
  write(f.workspace, "a.md", "changed");
  fs.rmSync(path.join(f.workspace, "b.md"));
  write(f.workspace, "c.md", "new");
  const commit = await f.versions.commit("mixed");
  assert.ok(commit);
  assert.deepEqual(commit.files, ["a.md", "b.md", "c.md"]);
  assert.equal(commit.version, await f.versions.head());
  assert.equal(commit.at, new Date(commit.at).toISOString());
  assert.ok(Math.abs(Date.parse(commit.at) - Date.now()) < 5 * 60 * 1000);
});

test("show returns a file at an old version, undefined for a path missing there, and rejects what is not a commit", async () => {
  const f = fixture();
  write(f.workspace, "a.md", "v1");
  const first = await f.versions.init();
  write(f.workspace, "a.md", "v2");
  const second = await f.versions.commit("v2");
  assert.equal((await f.versions.show(first, "a.md"))?.toString(), "v1");
  assert.equal((await f.versions.show(second!.version, "a.md"))?.toString(), "v2");
  assert.equal(await f.versions.show(second!.version, "missing.md"), undefined);
  assert.equal(await f.versions.show(second!.version, "nothing-here/x.md"), undefined);
  await assert.rejects(f.versions.show("0".repeat(40), "a.md"));
  await assert.rejects(f.versions.show("HEAD", "a.md"), /not a commit id/);
});

test("show reads a version from a git dir that is read-only", async () => {
  const f = fixture();
  write(f.workspace, "a.md", "v1");
  const head = await f.versions.init();
  execFileSync("chmod", ["-R", "a-w", f.gitDir]);
  try {
    assert.equal((await f.versions.show(head, "a.md"))?.toString(), "v1");
    assert.deepEqual(await f.versions.changedFiles(head), ["a.md"]);
  } finally {
    execFileSync("chmod", ["-R", "u+w", f.gitDir]);
  }
});

test("changedFiles and parent cover the first commit and later ones", async () => {
  const f = fixture();
  write(f.workspace, "a.md", "a");
  write(f.workspace, "b.md", "b");
  const first = await f.versions.init();
  assert.equal(await f.versions.parent(first), undefined);
  assert.deepEqual(await f.versions.changedFiles(first), ["a.md", "b.md"]);

  write(f.workspace, "c.md", "c");
  const second = await f.versions.commit("c");
  assert.equal(await f.versions.parent(second!.version), first);
  assert.deepEqual(await f.versions.changedFiles(second!.version), ["c.md"]);
});

test("differs tells an unchanged, a changed, a deleted and a new file apart", async () => {
  const f = fixture();
  write(f.workspace, "keep.md", "k");
  write(f.workspace, "edit.md", "v1");
  write(f.workspace, "gone.md", "g");
  const head = await f.versions.init();
  write(f.workspace, "edit.md", "v2");
  fs.rmSync(path.join(f.workspace, "gone.md"));
  write(f.workspace, "new.md", "n");
  assert.deepEqual(await f.versions.differs(head, ["keep.md", "edit.md", "gone.md", "new.md"]), ["edit.md", "gone.md", "new.md"]);
});

test("restore puts a changed file back, removes a file that did not exist at the version, and creates parent directories, committing nothing", async () => {
  const f = fixture();
  write(f.workspace, "a.md", "v1");
  write(f.workspace, "sub/deep/x.md", "x");
  const head = await f.versions.init();
  write(f.workspace, "a.md", "v2");
  write(f.workspace, "new.md", "n");
  fs.rmSync(path.join(f.workspace, "sub"), { recursive: true });
  await f.versions.restore(head, ["a.md", "new.md", "sub/deep/x.md"]);
  assert.equal(read(f.workspace, "a.md"), "v1");
  assert.equal(fs.existsSync(path.join(f.workspace, "new.md")), false);
  assert.equal(read(f.workspace, "sub/deep/x.md"), "x");
  assert.equal(await f.versions.head(), head);
});

test("restore refuses a path outside the workspace or inside .git before writing anything", async () => {
  const f = fixture();
  write(f.workspace, "a.md", "v1");
  const head = await f.versions.init();
  write(f.workspace, "a.md", "v2");
  await assert.rejects(f.versions.restore(head, ["a.md", "../outside.md"]), /outside the workspace/);
  await assert.rejects(f.versions.restore(head, ["a.md", ".git/config"]), /\.git/);
  assert.equal(read(f.workspace, "a.md"), "v2");
});

test("a path outside the workspace, a symlink out of it, or a .git path is refused by every call that names it", async () => {
  const f = fixture();
  const outside = fs.mkdtempSync(path.join(tmp, "outside-"));
  fs.symlinkSync(outside, path.join(f.workspace, "escape"));
  write(f.workspace, "a.md", "a");
  const head = await f.versions.init();
  await assert.rejects(f.versions.commit("x", { paths: ["../outside.md"] }), /\.\.\/outside\.md is outside the workspace/);
  await assert.rejects(f.versions.commit("x", { force: [path.join(outside, "x.md")] }), /outside the workspace/);
  await assert.rejects(f.versions.commit("x", { paths: ["escape/x.md"] }), /outside the workspace/);
  await assert.rejects(f.versions.commit("x", { force: [".GIT/config"] }), /inside a \.git directory/);
  await assert.rejects(f.versions.show(head, ".git/config"), /\.git/);
  await assert.rejects(f.versions.differs(head, ["sub/.git/HEAD"]), /\.git/);
  assert.equal(await f.versions.head(), head);
});

test("a file named :(glob)* is staged and shown literally, not read as a pathspec", async () => {
  const f = fixture();
  await f.versions.init();
  write(f.workspace, ":(glob)*", "literal");
  write(f.workspace, "a.md", "a");
  const commit = await f.versions.commit("literal", { paths: [":(glob)*"] });
  assert.deepEqual(commit?.files, [":(glob)*"]);
  assert.equal((await f.versions.show(commit!.version, ":(glob)*"))?.toString(), "literal");
  assert.equal(await f.versions.show(commit!.version, "a.md"), undefined);
});

test("a commit hook planted in the git dir does not run", async () => {
  const f = fixture();
  await f.versions.init();
  const marker = path.join(path.dirname(f.gitDir), "hook-ran");
  for (const hook of ["pre-commit", "post-commit"]) {
    fs.mkdirSync(path.join(f.gitDir, "hooks"), { recursive: true });
    fs.writeFileSync(path.join(f.gitDir, "hooks", hook), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
  }
  write(f.workspace, "a.md", "a");
  assert.ok(await f.versions.commit("hooks"));
  assert.equal(fs.existsSync(marker), false);
});

test("two commits started at once both succeed, one after the other", async () => {
  const f = fixture();
  await f.versions.init();
  write(f.workspace, "a.md", "a");
  write(f.workspace, "b.md", "b");
  const [one, two] = await Promise.all([
    f.versions.commit("one", { paths: ["a.md"] }),
    f.versions.commit("two", { paths: ["b.md"] }),
  ]);
  assert.deepEqual(one?.files, ["a.md"]);
  assert.deepEqual(two?.files, ["b.md"]);
  assert.equal(await f.versions.parent(two!.version), one!.version);
});

test("git ignores the GIT_* variables of the parent process", async () => {
  const f = fixture();
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE };
  process.env.GIT_DIR = path.join(tmp, "not-a-repository");
  process.env.GIT_INDEX_FILE = path.join(tmp, "not-an-index");
  try {
    write(f.workspace, "a.md", "a");
    const head = await f.versions.init();
    assert.deepEqual(await f.versions.changedFiles(head), ["a.md"]);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
