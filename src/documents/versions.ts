// Versions of the workspace in git. The workspace is the work tree of a repository whose git dir lives outside it,
// so no tool the agent has reaches the history (src/agent/guard.ts refuses .git paths). Every git call goes through
// runGit: no shell, the same configuration and environment, and calls on one Versions instance run one at a time.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { resolveInside } from "../agent/guard.ts";
import { STATE_DIR } from "../store.ts";
import { TRASH_DIR } from "./trash.ts";

/** The git dir of the workspace's history: under the state dir, never inside the workspace. */
export const VERSIONS_GIT_DIR = path.join(STATE_DIR, "workbench", "versions.git");

/** A file above this size is not versioned by rule; a tracked file that grows past it keeps its last version. */
export const VERSION_MAX_BYTES = 20 * 1024 * 1024;

/** Top-level directories whose files are never versioned by rule. */
const UNVERSIONED_DIRS = ["inbox", TRASH_DIR];

/** Extensions, in any case, that are never versioned by rule: images, PDFs, audio and video. */
const UNVERSIONED_EXTS = [
  "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tiff", "tif", "pdf",
  "mp3", "m4a", "wav", "aac", "ogg", "opus", "silk", "flac", "mp4", "mov", "m4v", "webm", "avi", "mkv",
];

/** Git's own binary test reads this many bytes from the start of a file: a NUL byte there makes it binary. */
const TEXT_SNIFF_BYTES = 8000;

const MAX_GIT_OUTPUT = 256 * 1024 * 1024;

const INITIAL_MESSAGE = "Initial version of the workspace";

const COMMIT_ID = /^[0-9a-f]{40}$/;

/** Written to info/exclude on every init, so plain git on the host agrees with the rules this module applies. */
const EXCLUDE_RULES = [
  "# Alfred's versioning rules (src/documents/versions.ts), written on every start. Size and content are checked by the module.",
  ...UNVERSIONED_DIRS.map((dir) => `/${dir}/`),
  ...UNVERSIONED_EXTS.map((ext) => `*.${[...ext].map((c) => `[${c}${c.toUpperCase()}]`).join("")}`),
  "",
].join("\n");

/** One commit of the workspace: its id, its time in UTC, and the workspace paths it changed. */
export interface Commit {
  version: string;
  at: string;
  files: string[];
}

/** Configuration passed on the command line of every git call. */
const GIT_CONFIG = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "core.quotePath=false",
  "safe.directory=*",
  "user.name=Alfred",
  "user.email=alfred@localhost",
  "commit.gpgSign=false",
].flatMap((setting) => ["-c", setting]);

/** The environment of every git call: the parent's PATH and nothing else from its GIT_* variables. */
function gitEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LITERAL_PATHSPECS: "1",
  };
}

/**
 * The one place git runs. Callers put paths after `--` and pass path lists on stdin. Resolves to stdout; rejects with
 * an Error whose message is git's first stderr line and whose exitCode is git's exit status.
 */
function runGit(gitDir: string, workspace: string, args: string[], input = ""): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      [...GIT_CONFIG, `--git-dir=${gitDir}`, `--work-tree=${workspace}`, ...args],
      { cwd: workspace, env: gitEnv(), encoding: "buffer", maxBuffer: MAX_GIT_OUTPUT },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const firstLine = stderr.toString("utf8").split("\n").find((line) => line.trim());
        reject(Object.assign(new Error(firstLine?.trim() || err.message), { exitCode: err.code }));
      },
    );
    child.stdin?.on("error", () => {}); // git may exit before it reads its input
    child.stdin?.end(input);
  });
}

function text(buf: Buffer): string {
  return buf.toString("utf8");
}

/** NUL-separated output (git's -z), without the empty tail. */
function splitNul(buf: Buffer): string[] {
  return text(buf).split("\0").filter((s) => s !== "");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function exitCodeOf(err: unknown): unknown {
  return err instanceof Error && "exitCode" in err ? err.exitCode : undefined;
}

/** The file's status, or undefined when nothing is there. A path that cannot exist (a parent is a file) counts as nothing. */
function lstatIfExists(abs: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(abs);
  } catch (err) {
    if (["ENOENT", "ENOTDIR"].includes((err as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw err;
  }
}

/** Whether `name` is one of `list`, or inside one of its directories; "" stands for the whole workspace. */
function within(name: string, list: readonly string[]): boolean {
  return list.some((p) => p === "" || name === p || name.startsWith(`${p}/`));
}

/** Git's text test on the first bytes of a file. */
function isText(abs: string, size: number): boolean {
  const fd = fs.openSync(abs, "r");
  try {
    const head = Buffer.alloc(Math.min(size, TEXT_SNIFF_BYTES));
    const n = fs.readSync(fd, head, 0, head.length, 0);
    return !head.subarray(0, n).includes(0);
  } finally {
    fs.closeSync(fd);
  }
}

/** Whether a file that is not tracked yet passes the rules: not in inbox/ or .trash/, not a listed type, small enough, text. */
function versionedByRule(rel: string, abs: string, size: number): boolean {
  if (rel.includes("/") && UNVERSIONED_DIRS.includes(rel.split("/")[0] ?? "")) return false;
  if (UNVERSIONED_EXTS.includes(path.extname(rel).slice(1).toLowerCase())) return false;
  return size <= VERSION_MAX_BYTES && isText(abs, size);
}

function sameBytes(a: Buffer | undefined, b: Buffer | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.equals(b);
}

/**
 * The versions of a workspace: a git repository whose work tree is `workspace` and whose git dir is `gitDir`.
 * Paths are workspace-relative, or absolute inside the workspace. Results list paths as workspace-relative with "/".
 */
export class Versions {
  private readonly workspace: string;
  private readonly gitDir: string;
  /** The last call in the chain; each call starts after the one before it has settled, so git's index lock is never contended. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: { workspace: string; gitDir: string }) {
    this.workspace = path.resolve(opts.workspace);
    this.gitDir = path.resolve(opts.gitDir);
  }

  /**
   * Creates the git dir when it is missing, writes the exclusion rules and, when the repository has no commit yet,
   * commits the workspace as it is under those rules. Resolves to the current commit id.
   */
  init(): Promise<string> {
    return this.exclusive(async () => {
      fs.mkdirSync(this.workspace, { recursive: true });
      fs.mkdirSync(this.gitDir, { recursive: true, mode: 0o700 });
      if (!fs.existsSync(path.join(this.gitDir, "HEAD"))) await this.git(["init", "-q"]);
      fs.mkdirSync(path.join(this.gitDir, "info"), { recursive: true });
      fs.writeFileSync(path.join(this.gitDir, "info", "exclude"), EXCLUDE_RULES);
      if (!(await this.headNow())) await this.commitNow(INITIAL_MESSAGE, { allowEmpty: true });
      return this.requireHead();
    });
  }

  /**
   * Commits the changes the rules admit (or all changes under `paths`, directories included). `force` names paths
   * committed whatever their directory, extension or content, as long as they are files of at most 20 MB. Resolves to
   * undefined, with no commit made, when there is nothing to commit.
   */
  commit(message: string, opts: { paths?: string[]; force?: string[] } = {}): Promise<Commit | undefined> {
    return this.exclusive(() => this.commitNow(message, opts));
  }

  /** The current commit id, or undefined when there is no commit yet. */
  head(): Promise<string | undefined> {
    return this.exclusive(() => this.headNow());
  }

  /** The first parent of a commit, or undefined for the first commit. */
  parent(version: string): Promise<string | undefined> {
    return this.exclusive(async () => {
      await this.assertCommit(version);
      return this.parentOf(version);
    });
  }

  /** The paths a commit changed against its first parent (every path, for the first commit), sorted. */
  changedFiles(version: string): Promise<string[]> {
    return this.exclusive(async () => {
      await this.assertCommit(version);
      return this.changedIn(version);
    });
  }

  /** The bytes of a file at a commit, or undefined when the path is not a file in it. */
  show(version: string, file: string): Promise<Buffer | undefined> {
    return this.exclusive(async () => {
      await this.assertCommit(version);
      return this.fileAt(version, this.relPath(file));
    });
  }

  /** The paths, among `paths` and in the order given, whose work tree content differs from their content at a commit. */
  differs(version: string, paths: string[]): Promise<string[]> {
    return this.exclusive(async () => {
      await this.assertCommit(version);
      const differing: string[] = [];
      for (const p of paths) {
        const rel = this.relPath(p);
        if (!sameBytes(await this.fileAt(version, rel), this.workFile(rel))) differing.push(rel);
      }
      return differing;
    });
  }

  /**
   * Puts each path back as it was at a commit: its content where it existed there, and the file removed where it did
   * not. Nothing is committed. A path outside the workspace or inside a .git directory rejects the call before any
   * file is written.
   */
  restore(version: string, paths: string[]): Promise<void> {
    return this.exclusive(async () => {
      await this.assertCommit(version);
      const rels = [...new Set(paths.map((p) => this.relPath(p)))];
      const plan: { rel: string; abs: string; content: Buffer | undefined }[] = [];
      for (const rel of rels) {
        if (rel === "") throw new Error("The workspace itself cannot be restored, only files in it.");
        const abs = this.abs(rel);
        this.checkRestorable(rel, abs);
        plan.push({ rel, abs, content: await this.fileAt(version, rel) });
      }
      for (const { abs, content } of plan) {
        if (content === undefined) {
          if (lstatIfExists(abs)) fs.rmSync(abs);
          continue;
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        if (lstatIfExists(abs)?.isSymbolicLink()) fs.unlinkSync(abs);
        fs.writeFileSync(abs, content);
      }
    });
  }

  /** Runs `job` after every call started before it has settled. */
  private exclusive<T>(job: () => Promise<T>): Promise<T> {
    const result = this.queue.then(job);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private git(args: string[], input?: string): Promise<Buffer> {
    return runGit(this.gitDir, this.workspace, args, input);
  }

  private abs(rel: string): string {
    return path.join(this.workspace, rel);
  }

  /**
   * A workspace-relative path for `p`, or a throw when it is outside the workspace (symlinks followed) or has a .git
   * segment in any case. Paths are relative to the workspace or absolute.
   */
  private relPath(p: string): string {
    const root = fs.realpathSync(this.workspace);
    const outside = (r: string) => r === ".." || r.startsWith(`..${path.sep}`) || path.isAbsolute(r);
    const rel = [this.workspace, root].map((base) => path.relative(base, path.resolve(base, p))).find((r) => !outside(r));
    if (rel === undefined || !resolveInside(this.workspace, p)) throw new Error(`${p} is outside the workspace; only files under ${root} are accessible.`);
    const segments = rel.split(path.sep);
    if (segments.some((segment) => segment.toLowerCase() === ".git")) throw new Error(`${p} is inside a .git directory, which no tool may use.`);
    return segments.join("/");
  }

  private async assertCommit(version: string): Promise<void> {
    if (!COMMIT_ID.test(version)) throw new Error(`${version} is not a commit id`);
    let type: string;
    try {
      type = text(await this.git(["cat-file", "-t", version])).trim();
    } catch (err) {
      throw new Error(`${version} is not a commit: ${errorMessage(err)}`);
    }
    if (type !== "commit") throw new Error(`${version} is not a commit`);
  }

  private async headNow(): Promise<string | undefined> {
    try {
      return text(await this.git(["rev-parse", "-q", "--verify", "HEAD"])).trim() || undefined;
    } catch (err) {
      if (exitCodeOf(err) === 1) return undefined; // no commit yet
      throw err;
    }
  }

  private async requireHead(): Promise<string> {
    const head = await this.headNow();
    if (!head) throw new Error("The versions repository has no commit.");
    return head;
  }

  private async parentOf(version: string): Promise<string | undefined> {
    const [, parent] = text(await this.git(["rev-list", "--parents", "-n", "1", version])).trim().split(/\s+/);
    return parent || undefined;
  }

  private async changedIn(version: string): Promise<string[]> {
    const parent = await this.parentOf(version);
    const out = parent
      ? await this.git(["diff-tree", "-r", "-z", "--name-only", "--no-renames", "--no-commit-id", parent, version])
      : await this.git(["ls-tree", "-r", "-z", "--name-only", "--full-tree", version]);
    return splitNul(out).sort();
  }

  /** The bytes of the file at `rel` in `version`, or undefined when it is not a file there. */
  private async fileAt(version: string, rel: string): Promise<Buffer | undefined> {
    if (rel === "") return undefined;
    // One entry, "<mode> <type> <id>\t<name>", NUL-terminated.
    const [line] = splitNul(await this.git(["ls-tree", "-z", "--full-tree", version, "--", rel]));
    if (line === undefined) return undefined;
    const tab = line.indexOf("\t");
    const [, type, id] = line.slice(0, tab).split(" ");
    if (line.slice(tab + 1) !== rel || type !== "blob" || !id) return undefined;
    return this.git(["cat-file", "blob", id]);
  }

  private workFile(rel: string): Buffer | undefined {
    const abs = this.abs(rel);
    return lstatIfExists(abs)?.isFile() ? fs.readFileSync(abs) : undefined;
  }

  /** Refuses a restore that would have to remove or replace a directory, or write through a file in a parent's place. */
  private checkRestorable(rel: string, abs: string): void {
    if (lstatIfExists(abs)?.isDirectory()) throw new Error(`${rel} is a directory in the workspace, so it cannot be restored.`);
    for (let dir = path.dirname(abs); dir.startsWith(this.workspace + path.sep); dir = path.dirname(dir)) {
      const st = lstatIfExists(dir);
      if (st && !st.isDirectory()) throw new Error(`${rel} cannot be restored: ${path.relative(this.workspace, dir)} is not a directory.`);
    }
  }

  private async commitNow(
    message: string,
    opts: { paths?: string[]; force?: string[]; allowEmpty?: boolean },
  ): Promise<Commit | undefined> {
    const paths = opts.paths?.map((p) => this.relPath(p));
    const force = (opts.force ?? []).map((p) => this.relPath(p));
    await this.clearIndex(await this.headNow());
    await this.stage(paths, force);
    if (!opts.allowEmpty && (await this.stagedFiles()).length === 0) return undefined;
    await this.git(
      ["commit", "-q", "--no-verify", "--cleanup=verbatim", ...(opts.allowEmpty ? ["--allow-empty"] : []), "-F", "-"],
      message,
    );
    const version = await this.requireHead();
    const at = new Date(Number(text(await this.git(["log", "-1", "--format=%ct", version])).trim()) * 1000).toISOString();
    return { version, at, files: await this.changedIn(version) };
  }

  private async stagedFiles(): Promise<string[]> {
    return splitNul(await this.git(["diff", "--cached", "--name-only", "-z", "--no-renames"]));
  }

  /** Unstages what an earlier call left staged, so the commit holds only the paths it selects. */
  private async clearIndex(head: string | undefined): Promise<void> {
    if (!head) {
      await this.git(["read-tree", "--empty"]);
    } else if ((await this.stagedFiles()).length > 0) {
      await this.git(["read-tree", head]);
    }
  }

  /**
   * Stages the changes a commit covers. A tracked file that changed is staged unless it is over the size limit (a
   * deleted one is staged as deleted); a tracked path that is now a directory or link only leaves the index. An
   * untracked file is staged when the rules admit it, or when `force` names it.
   */
  private async stage(paths: string[] | undefined, force: string[]): Promise<void> {
    const inScope = (name: string) => paths === undefined || within(name, paths) || within(name, force);
    const changed = splitNul(await this.git(["ls-files", "-z", "-m"])).filter(inScope);
    const untracked = splitNul(await this.git(["ls-files", "-z", "-o"])).filter(inScope);
    const add: string[] = [];
    const drop: string[] = [];
    for (const name of changed) {
      const st = lstatIfExists(this.abs(name));
      if (!st) add.push(name);
      else if (st.isFile()) {
        if (st.size <= VERSION_MAX_BYTES) add.push(name);
      } else drop.push(name);
    }
    for (const name of untracked) {
      const st = lstatIfExists(this.abs(name));
      if (!st?.isFile()) continue;
      const admitted = within(name, force) ? st.size <= VERSION_MAX_BYTES : versionedByRule(name, this.abs(name), st.size);
      if (admitted) add.push(name);
    }
    if (drop.length > 0) await this.git(["rm", "-q", "--cached", "--ignore-unmatch", "--", ...drop]);
    if (add.length > 0) {
      await this.git(["add", "-f", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], add.map((name) => `${name}\0`).join(""));
    }
  }
}
