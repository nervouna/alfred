// The app's paired devices. Pairing (the CLI's `pair`) creates a device and hands
// its token to the app once; only the token's SHA-256 is stored. Every /api/
// request carries the token as a bearer, and revoking a device (the CLI's
// `devices revoke`, run in another process) locks it out at once: the store
// re-reads the file whenever it changes, so the workbench needs no restart.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { describeError, log } from "../log.ts";
import { newRunId } from "../runs.ts";
import { STATE_DIR, writeJson } from "../store.ts";

const MAX_NAME_CHARS = 64;

const DeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Hex SHA-256 of the device token. */
  tokenSha256: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.string(),
  revokedAt: z.string().optional(),
});
const DevicesFileSchema = z.object({ devices: z.array(DeviceSchema) });

export type Device = z.infer<typeof DeviceSchema>;

/** `ALFRED_WORKBENCH_STATE`, else `app/` under the state dir. */
export function deviceStateDir(env: Record<string, string | undefined> = process.env): string {
  return env.ALFRED_WORKBENCH_STATE?.trim() || path.join(STATE_DIR, "app");
}

function sha256(token: string): Buffer {
  return crypto.createHash("sha256").update(token).digest();
}

export class DeviceStore {
  readonly file: string;
  private readonly dir: string;
  /** What was read, and the file's identity at that moment: a failed read is remembered too. */
  private cache?: { signature: string; devices?: Device[]; error?: string };
  private reported?: string;

  constructor(dir: string = deviceStateDir()) {
    this.dir = dir;
    this.file = path.join(dir, "devices.json");
  }

  /** Every device, revoked ones included. Throws when the file is unreadable. */
  list(): Device[] {
    return this.load().map((d) => ({ ...d }));
  }

  /** Pairs a new device; the token is returned here and never stored. */
  createDevice(name: string): { id: string; token: string } {
    const clean = name.trim();
    if (!clean || [...clean].length > MAX_NAME_CHARS || /\p{Cc}/u.test(clean)) {
      throw new Error(`a device name is 1-${MAX_NAME_CHARS} characters without control characters`);
    }
    const devices = this.list();
    const id = newRunId((candidate) => devices.some((d) => d.id === candidate));
    const token = crypto.randomBytes(32).toString("base64url");
    devices.push({ id, name: clean, tokenSha256: sha256(token).toString("hex"), createdAt: new Date().toISOString() });
    this.save(devices);
    return { id, token };
  }

  /** Locks a device out. Revoking one that is already revoked keeps its first revokedAt. */
  revokeDevice(id: string): Device {
    const devices = this.list();
    const device = devices.find((d) => d.id === id);
    if (!device) throw new Error(`no device ${id}`);
    if (!device.revokedAt) {
      device.revokedAt = new Date().toISOString();
      this.save(devices);
    }
    return device;
  }

  /** The unrevoked device holding this token, if any. An unreadable file refuses everyone. */
  authenticate(token: string): Device | undefined {
    let devices: Device[];
    try {
      devices = this.load();
    } catch (err) {
      const reason = describeError(err);
      if (this.reported !== reason) log.error(`${this.file} is unreadable, so no device can pair or authenticate: ${reason}`);
      this.reported = reason;
      return undefined;
    }
    this.reported = undefined;
    const digest = sha256(token);
    let found: Device | undefined;
    // Every unrevoked device is compared, so the time taken does not say which one matched.
    for (const device of devices) {
      if (device.revokedAt) continue;
      if (crypto.timingSafeEqual(digest, Buffer.from(device.tokenSha256, "hex"))) found = device;
    }
    return found;
  }

  /** The file's identity. It is a new file after every save (written aside, then renamed over), so its inode, size and times all move. */
  private signature(): string {
    try {
      const stat = fs.statSync(this.file);
      return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw err;
    }
  }

  /** The cached devices, re-read when the file's mtime (or anything else about it) has changed. */
  private load(): Device[] {
    // Stat before reading: a file replaced in between is read now and again next time, never missed.
    const signature = this.signature();
    let entry = this.cache;
    if (entry?.signature !== signature) {
      try {
        const devices = signature === "missing" ? [] : DevicesFileSchema.parse(JSON.parse(fs.readFileSync(this.file, "utf8"))).devices;
        entry = { signature, devices };
      } catch (err) {
        entry = { signature, error: describeError(err) };
      }
      this.cache = entry;
    }
    if (!entry.devices) throw new Error(entry.error ?? "unreadable");
    return entry.devices;
  }

  private save(devices: Device[]): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dir, 0o700);
    writeJson(this.file, { devices });
    this.cache = undefined;
  }
}
