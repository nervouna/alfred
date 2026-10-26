import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Alfred's state lives under XDG state; the files it handles live in the workspace. */
export const STATE_DIR =
  process.env.ALFRED_STATE_DIR ??
  path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "alfred");

export const WORKSPACE_DIR = path.resolve(process.env.ALFRED_WORKSPACE ?? path.join(os.homedir(), "Alfred"));

export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Atomic write, owner-only permissions. */
export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
