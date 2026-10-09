// Image generation through MiniMax's mmx CLI (model image-01) on the user's Token Plan.
//
// mmx is toolchain: it uses the user's own key from ~/.config/mmx/config.json
// and does not go through the LLM gateway. MiniMax bills every request, even
// when the client times out, so nothing here retries and the per-task cap
// counts requested images before the call.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { localDate } from "../files.ts";
import { log } from "../log.ts";
import { resolveInside } from "./guard.ts";

/** Ratios image-01 accepts. */
export const ASPECT_RATIOS = ["1:1", "16:9", "4:3", "3:2", "2:3", "3:4", "9:16", "21:9"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export const MAX_IMAGES_PER_CALL = 4;
export const MAX_IMAGES_PER_TASK = 8;
const TIMEOUT_MS = 10 * 60_000;
const OUTPUT_EXTS = new Set([".jpg", ".jpeg"]);
const ERROR_TEXT_LIMIT = 2000;

/** The mmx wrapper from the user's Claude Code skill, which pins the CLI version and runs it through npx. */
export const MMX_BIN =
  process.env.ALFRED_MMX_BIN ??
  path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "skills", "mmx", "bin", "mmx");

export interface MmxResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Set when the runner killed the process. */
  killed?: "timeout" | "aborted";
}

/** Runs the mmx binary; rejects only when the process cannot start. */
export type MmxRunner = (bin: string, args: string[], opts: { timeoutMs: number; signal?: AbortSignal }) => Promise<MmxResult>;

/** Process groups of mmx calls still running, killed if Alfred exits first. */
const running = new Set<number>();
process.on("exit", () => {
  for (const pid of running) killGroup(pid);
});

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

/**
 * Runs mmx in its own process group, so a timeout or /stop kills the whole
 * tree: the wrapper execs npx, which starts the CLI as a grandchild.
 */
export const runMmx: MmxRunner = (bin, args, { timeoutMs, signal }) => {
  // The wrapper calls npx, which sits beside node; keep it reachable even with a minimal PATH.
  const env = { ...process.env, PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter) };
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return resolve({ exitCode: null, stdout: "", stderr: "", killed: "aborted" });
    const child = spawn(bin, args, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed: MmxResult["killed"];
    let settled = false;
    const stop = (why: "timeout" | "aborted") => {
      killed ??= why;
      if (child.pid) killGroup(child.pid);
    };
    const onAbort = () => stop("aborted");
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    const settle = () => {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (child.pid) running.delete(child.pid);
    };
    child.stdout.setEncoding("utf-8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf-8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (err) => {
      if (settled) return;
      settle();
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settle();
      resolve({ exitCode: code, stdout, stderr, killed });
    });
    if (child.pid) running.add(child.pid);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

export interface ImageRequest {
  prompt: string;
  aspectRatio: AspectRatio;
  n?: number;
  /** JPEG path relative to the workspace; with n > 1 it is the stem of <stem>_001.jpg and so on. */
  output?: string;
}

/** File-name stem from a prompt: letters and digits of any script, at most 40 characters. */
export function slugify(prompt: string): string {
  const dashed = prompt.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-");
  const slug = Array.from(dashed.replace(/^-+/, "")).slice(0, 40).join("").replace(/-+$/, "");
  return slug || "image";
}

/** Files mmx writes for `base`: the exact path for one image, <stem>_NNN.jpg beside it for a batch. */
export function batchFiles(base: string, n: number): string[] {
  if (n === 1) return [base];
  const dir = path.dirname(base);
  const stem = path.basename(base, path.extname(base));
  return Array.from({ length: n }, (_, i) => path.join(dir, `${stem}_${String(i + 1).padStart(3, "0")}.jpg`));
}

export function buildMmxArgs(req: { prompt: string; aspectRatio: AspectRatio; n: number; base: string }): string[] {
  const target =
    req.n === 1
      ? ["--out", req.base]
      : ["--out-dir", path.dirname(req.base), "--out-prefix", path.basename(req.base, path.extname(req.base))];
  return [
    "image", "generate",
    "--prompt", req.prompt,
    "--aspect-ratio", req.aspectRatio,
    "--n", String(req.n),
    ...target,
    // Images come back in the API response, so a failed CDN download cannot waste a billed generation.
    "--response-format", "base64",
    "--non-interactive", "--quiet", "--output", "json",
  ];
}

function clip(text: string): string {
  const t = text.trim();
  return t.length <= ERROR_TEXT_LIMIT ? t : `${t.slice(0, ERROR_TEXT_LIMIT)}…`;
}

/** Files that a running call will write. mmx overwrites its destination, so overlapping calls must not share one. */
const reserved = new Set<string>();

/**
 * Image generator for one agent task. Every output path is confined to `root`,
 * existing files are never overwritten, and at most `maxPerTask` images are
 * requested over the generator's lifetime. Aborting `signal` kills a running call.
 */
export function createImageGenerator(opts: { root: string; bin?: string; run?: MmxRunner; maxPerTask?: number; signal?: AbortSignal }) {
  const { root, bin = MMX_BIN, run = runMmx, maxPerTask = MAX_IMAGES_PER_TASK, signal } = opts;
  let used = 0;

  /** `base` is the path handed to mmx, `files` what mmx will write; undefined if any of them is taken. */
  function target(rel: string, n: number): { base: string; files: string[] } | undefined {
    const base = resolveInside(root, rel);
    if (!base) throw new Error(`${rel} is outside the workspace.`);
    const files = batchFiles(base, n);
    if (files.some((f) => !resolveInside(root, f))) throw new Error(`${rel} is outside the workspace.`);
    return files.some((f) => fs.existsSync(f) || reserved.has(f)) ? undefined : { base, files };
  }

  function plan(req: ImageRequest, n: number): { base: string; files: string[] } {
    if (req.output !== undefined) {
      if (!OUTPUT_EXTS.has(path.extname(req.output).toLowerCase())) throw new Error("The output must end in .jpg; mmx writes JPEG.");
      const planned = target(req.output, n);
      if (!planned) {
        const what = n > 1 ? `${req.output} (or one of its numbered files)` : req.output;
        throw new Error(`${what} already exists or is being generated; pick another output path.`);
      }
      return planned;
    }
    const slug = slugify(req.prompt);
    for (let i = 1; ; i++) {
      const planned = target(path.join("images", localDate(), `${i === 1 ? slug : `${slug}-${i}`}.jpg`), n);
      if (planned) return planned;
    }
  }

  return async function generate(req: ImageRequest): Promise<{ files: string[]; failed: number }> {
    const n = req.n ?? 1;
    if (!Number.isInteger(n) || n < 1 || n > MAX_IMAGES_PER_CALL) throw new Error(`n must be 1 to ${MAX_IMAGES_PER_CALL}.`);
    try {
      fs.accessSync(bin, fs.constants.X_OK);
    } catch {
      throw new Error(`Image generation is not set up on this machine: no mmx executable at ${bin} (set ALFRED_MMX_BIN).`);
    }
    if (used + n > maxPerTask) {
      throw new Error(`Image cap reached: this task has requested ${used} of ${maxPerTask} images, so ${n} more are not allowed.`);
    }
    if (signal?.aborted) throw new Error("The task was stopped.");
    // Everything from the cap check to the reservation is synchronous, so overlapping calls cannot interleave.
    const { base, files } = plan(req, n);
    for (const f of files) reserved.add(f);
    used += n;
    try {
      fs.mkdirSync(path.dirname(base), { recursive: true });
      const rootReal = fs.realpathSync(root);
      const rel = (f: string) => path.relative(rootReal, f);
      const summary = `generate_image n=${n} ratio=${req.aspectRatio} out=${rel(files[0] ?? base)} (${used}/${maxPerTask} this task)`;
      const started = Date.now();
      let result: MmxResult;
      try {
        result = await run(bin, buildMmxArgs({ prompt: req.prompt, aspectRatio: req.aspectRatio, n, base }), { timeoutMs: TIMEOUT_MS, signal });
      } catch (err) {
        log.warn(`${summary}: mmx did not start`);
        throw new Error(`mmx could not start (${bin})`, { cause: err });
      }
      const secs = Math.round((Date.now() - started) / 1000);
      if (result.killed === "aborted") {
        log.info(`${summary}: stopped by the user after ${secs}s`);
        throw new Error("The task was stopped; mmx was terminated.");
      }
      if (result.killed === "timeout") {
        log.warn(`${summary}: timed out after ${secs}s`);
        throw new Error(`mmx timed out after ${secs}s. The request may still be billed; do not retry without asking the user.`);
      }
      if (result.exitCode !== 0) {
        const detail = clip(result.stderr) || clip(result.stdout) || "no output";
        log.warn(`${summary}: exit ${result.exitCode} ${detail.replace(/\s+/g, " ")}`);
        throw new Error(`mmx failed (exit ${result.exitCode}): ${detail}`);
      }

      // The planned files did not exist before the call, so whatever exists now is mmx's output.
      const written = files.filter((f) => fs.existsSync(f) && fs.statSync(f).isFile());
      const failed = n - written.length;
      log.info(`${summary}: ${written.length} written, ${failed} failed in ${secs}s`);
      if (!written.length) throw new Error(`mmx exited without writing an image: ${clip(result.stdout) || "no output"}`);
      return { files: written.map(rel), failed };
    } finally {
      for (const f of files) reserved.delete(f);
    }
  };
}
