import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

import { localDate } from "../files.ts";
import { batchFiles, buildMmxArgs, createImageGenerator, runMmx, slugify } from "./image.ts";
import type { MmxResult, MmxRunner } from "./image.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-image-")));
const root = path.join(tmp, "workspace");
const outside = path.join(tmp, "outside");
const bin = path.join(tmp, "mmx");
fs.mkdirSync(outside);
fs.writeFileSync(bin, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, "reports"), { recursive: true });
});

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
}

/** Stub that behaves like `mmx image generate`, recording every call; `gate` holds the writes back. */
function fakeMmx(result: Partial<MmxResult> = {}, gate?: Promise<void>) {
  const calls: string[][] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const run: MmxRunner = async (_bin, args, opts) => {
    calls.push(args);
    signals.push(opts.signal);
    await gate;
    const outcome = { exitCode: 0, stdout: "", stderr: "", ...result };
    if (outcome.exitCode !== 0 || outcome.killed) return outcome;
    const n = Number(flag(args, "--n"));
    const out = flag(args, "--out");
    const saved = out
      ? [out]
      : batchFiles(path.join(flag(args, "--out-dir") ?? ".", `${flag(args, "--out-prefix")}.jpg`), n);
    for (const f of saved) fs.writeFileSync(f, JPEG);
    return { ...outcome, stdout: JSON.stringify({ id: "t1", saved, success_count: n, failed_count: 0 }) };
  };
  return { run, calls, signals };
}

test("slugify keeps letters and digits of any script and falls back to image", () => {
  assert.equal(slugify("A Cat, in a Spacesuit!"), "a-cat-in-a-spacesuit");
  assert.equal(slugify("  上海外滩 夜景 / 2026 "), "上海外滩-夜景-2026");
  assert.equal(slugify("x".repeat(60)), "x".repeat(40));
  assert.equal(slugify("!!!"), "image");
});

test("buildMmxArgs uses --out for one image and --out-dir with a prefix for a batch", () => {
  const one = buildMmxArgs({ prompt: "a cat", aspectRatio: "16:9", n: 1, base: "/w/images/d/cat.jpg" });
  assert.deepEqual(one, [
    "image", "generate", "--prompt", "a cat", "--aspect-ratio", "16:9", "--n", "1", "--out", "/w/images/d/cat.jpg",
    "--response-format", "base64", "--non-interactive", "--quiet", "--output", "json",
  ]);
  const batch = buildMmxArgs({ prompt: "--not-a-flag", aspectRatio: "1:1", n: 3, base: "/w/images/d/cat.jpg" });
  assert.equal(flag(batch, "--prompt"), "--not-a-flag");
  assert.equal(flag(batch, "--out-dir"), "/w/images/d");
  assert.equal(flag(batch, "--out-prefix"), "cat");
  assert.equal(batch.includes("--out"), false);
  assert.deepEqual(batchFiles("/w/cat.jpg", 2), ["/w/cat_001.jpg", "/w/cat_002.jpg"]);
});

test("generate writes to images/<date>/<slug>.jpg by default and never overwrites", async () => {
  const { run, calls } = fakeMmx();
  const generate = createImageGenerator({ root, bin, run });
  const day = path.join("images", localDate());
  assert.deepEqual(await generate({ prompt: "Report cover", aspectRatio: "16:9" }), {
    files: [path.join(day, "report-cover.jpg")],
    failed: 0,
  });
  assert.deepEqual((await generate({ prompt: "Report cover", aspectRatio: "16:9" })).files, [path.join(day, "report-cover-2.jpg")]);
  assert.deepEqual((await generate({ prompt: "Report cover", aspectRatio: "1:1", n: 2 })).files, [
    path.join(day, "report-cover_001.jpg"),
    path.join(day, "report-cover_002.jpg"),
  ]);
  assert.equal(flag(calls[0] ?? [], "--out"), path.join(root, day, "report-cover.jpg"));
  assert.equal(fs.readFileSync(path.join(root, day, "report-cover.jpg")).equals(JPEG), true);
});

test("generate honors an explicit output inside the workspace", async () => {
  const { run } = fakeMmx();
  const generate = createImageGenerator({ root, bin, run });
  assert.deepEqual((await generate({ prompt: "x", aspectRatio: "1:1", output: "reports/cover.jpg" })).files, ["reports/cover.jpg"]);
  await assert.rejects(generate({ prompt: "x", aspectRatio: "1:1", output: "reports/cover.jpg" }), /already exists/);
  await assert.rejects(generate({ prompt: "x", aspectRatio: "1:1", output: "reports/cover.png" }), /must end in \.jpg/);
});

test("generate rejects outputs outside the workspace without calling mmx", async () => {
  fs.symlinkSync(outside, path.join(root, "escape"));
  fs.symlinkSync(outside, path.join(root, "images"));
  const { run, calls } = fakeMmx();
  const generate = createImageGenerator({ root, bin, run });
  for (const output of ["../outside/x.jpg", path.join(outside, "x.jpg"), "/tmp/x.jpg", "escape/x.jpg"]) {
    await assert.rejects(generate({ prompt: "x", aspectRatio: "1:1", output }), /outside the workspace/, output);
  }
  // A symlinked images/ directory must not redirect the default path either.
  await assert.rejects(generate({ prompt: "x", aspectRatio: "1:1" }), /outside the workspace/);
  assert.equal(calls.length, 0);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("generate caps images per call and per task, counting failed calls", async () => {
  const { run, calls } = fakeMmx();
  const generate = createImageGenerator({ root, bin, run, maxPerTask: 5 });
  await assert.rejects(generate({ prompt: "x", aspectRatio: "1:1", n: 5 }), /n must be 1 to 4/);
  await generate({ prompt: "x", aspectRatio: "1:1", n: 4 });
  await assert.rejects(generate({ prompt: "x", aspectRatio: "1:1", n: 2 }), /cap reached.*4 of 5/);
  await generate({ prompt: "x", aspectRatio: "1:1" });
  await assert.rejects(generate({ prompt: "x", aspectRatio: "1:1" }), /cap reached.*5 of 5/);
  assert.equal(calls.length, 2);

  const failing = createImageGenerator({ root, bin, run: fakeMmx({ exitCode: 1, stderr: "boom" }).run, maxPerTask: 1 });
  await assert.rejects(failing({ prompt: "x", aspectRatio: "1:1" }), /boom/);
  await assert.rejects(failing({ prompt: "x", aspectRatio: "1:1" }), /cap reached/);
});

test("generate reports a missing mmx binary instead of crashing", async () => {
  const { run, calls } = fakeMmx();
  const generate = createImageGenerator({ root, bin: path.join(tmp, "missing", "mmx"), run });
  await assert.rejects(generate({ prompt: "x", aspectRatio: "1:1" }), /not set up.*ALFRED_MMX_BIN/);
  assert.equal(calls.length, 0);
});

test("generate passes mmx errors through verbatim and warns against retrying a timeout", async () => {
  const quota = '{\n  "error": {\n    "code": 4,\n    "message": "Quota or balance exhausted."\n  }\n}';
  const generate = createImageGenerator({ root, bin, run: fakeMmx({ exitCode: 4, stderr: quota }).run });
  await assert.rejects(generate({ prompt: "x", aspectRatio: "1:1" }), (err: Error) => {
    assert.equal(err.message, `mmx failed (exit 4): ${quota}`);
    return true;
  });
  const slow = createImageGenerator({ root, bin, run: fakeMmx({ exitCode: null, killed: "timeout" }).run });
  await assert.rejects(slow({ prompt: "x", aspectRatio: "1:1" }), /timed out.*do not retry/);
  const silent = createImageGenerator({ root, bin, run: async () => ({ exitCode: 0, stdout: "{}", stderr: "", killed: undefined }) });
  await assert.rejects(silent({ prompt: "x", aspectRatio: "1:1" }), /without writing an image/);
});

test("generate reserves output paths while a call runs", async () => {
  let release!: () => void;
  const { run, calls } = fakeMmx({}, new Promise<void>((resolve) => {
    release = () => resolve();
  }));
  const generate = createImageGenerator({ root, bin, run });
  const day = path.join("images", localDate());
  const first = generate({ prompt: "x", aspectRatio: "1:1", output: "reports/a.jpg" });
  const firstDefault = generate({ prompt: "x", aspectRatio: "1:1" });
  await assert.rejects(generate({ prompt: "y", aspectRatio: "1:1", output: "reports/a.jpg" }), /being generated/);
  const secondDefault = generate({ prompt: "x", aspectRatio: "1:1" });
  release();
  assert.deepEqual((await first).files, ["reports/a.jpg"]);
  assert.deepEqual((await firstDefault).files, [path.join(day, "x.jpg")]);
  assert.deepEqual((await secondDefault).files, [path.join(day, "x-2.jpg")]);
  assert.equal(calls.length, 3);
  // Reservations end with the call; the file itself now blocks reuse.
  await assert.rejects(generate({ prompt: "y", aspectRatio: "1:1", output: "reports/a.jpg" }), /already exists/);
});

test("generate passes the task signal to mmx and refuses to start once the task is stopped", async () => {
  const controller = new AbortController();
  const { run, calls, signals } = fakeMmx({ exitCode: null, killed: "aborted" });
  const generate = createImageGenerator({ root, bin, run, signal: controller.signal });
  await assert.rejects(generate({ prompt: "x", aspectRatio: "1:1" }), /stopped; mmx was terminated/);
  assert.equal(signals[0], controller.signal);
  controller.abort();
  await assert.rejects(generate({ prompt: "x", aspectRatio: "1:1" }), /task was stopped/);
  assert.equal(calls.length, 1);
});

/**
 * Shell script standing in for the mmx wrapper: starts a grandchild, records its pid, waits.
 * The grandchild does not hold the output pipes, so killing only the script would leave it running.
 */
function hangingBin(name: string): { file: string; pidFile: string } {
  const file = path.join(tmp, name);
  const pidFile = path.join(tmp, `${name}.pid`);
  fs.writeFileSync(file, `#!/bin/sh\nsleep 30 >/dev/null 2>&1 &\necho $! > "${pidFile}"\nwait\n`, { mode: 0o755 });
  return { file, pidFile };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("runMmx kills the whole process tree on abort and on timeout", async () => {
  const stopped = hangingBin("stopped");
  const controller = new AbortController();
  const pending = runMmx(stopped.file, [], { timeoutMs: 60_000, signal: controller.signal });
  await until(() => fs.existsSync(stopped.pidFile) && fs.readFileSync(stopped.pidFile, "utf-8").trim() !== "");
  const grandchild = Number(fs.readFileSync(stopped.pidFile, "utf-8"));
  controller.abort();
  assert.equal((await pending).killed, "aborted");
  await until(() => !alive(grandchild));

  const slow = hangingBin("slow");
  const result = await runMmx(slow.file, [], { timeoutMs: 300 });
  assert.equal(result.killed, "timeout");
  await until(() => !alive(Number(fs.readFileSync(slow.pidFile, "utf-8"))));
});

test("runMmx returns exit codes and output, and rejects when the binary cannot start", async () => {
  const failing = path.join(tmp, "failing");
  fs.writeFileSync(failing, "#!/bin/sh\necho out\necho err >&2\nexit 4\n", { mode: 0o755 });
  assert.deepEqual(await runMmx(failing, [], { timeoutMs: 10_000 }), { exitCode: 4, stdout: "out\n", stderr: "err\n", killed: undefined });
  await assert.rejects(runMmx(path.join(tmp, "missing-bin"), [], { timeoutMs: 10_000 }), { code: "ENOENT" });
});
