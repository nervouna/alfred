import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Credentials and cursor live under XDG state; files the bot handles live in the workspace. */
export const STATE_DIR =
  process.env.ALFRED_STATE_DIR ??
  path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "alfred");

export const WORKSPACE_DIR = path.resolve(process.env.ALFRED_WORKSPACE ?? path.join(os.homedir(), "Alfred"));

const ACCOUNT_FILE = path.join(STATE_DIR, "account.json");
const SYNC_FILE = path.join(STATE_DIR, "sync.json");
const CONTEXT_TOKENS_FILE = path.join(STATE_DIR, "context-tokens.json");

export interface Account {
  botToken: string;
  botId: string;
  baseUrl: string;
  /** The WeChat user who scanned the login QR code; the only user the bot serves. */
  ownerUserId: string;
  loggedInAt: string;
}

export interface ContextTokenEntry {
  token: string;
  /** When the token was last refreshed by an inbound message (epoch ms). */
  updatedAt: number;
}

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

export function loadAccount(): Account | undefined {
  return readJson<Account>(ACCOUNT_FILE);
}

export function requireAccount(): Account {
  const account = loadAccount();
  if (!account) throw new Error("Not logged in. Run `npm run login` first.");
  return account;
}

export function saveAccount(account: Account): void {
  const previous = loadAccount();
  if (previous && previous.botId !== account.botId) {
    // Cursor and context tokens belong to the old bot.
    fs.rmSync(SYNC_FILE, { force: true });
    fs.rmSync(CONTEXT_TOKENS_FILE, { force: true });
  }
  writeJson(ACCOUNT_FILE, account);
}

export function loadCursor(): string {
  return readJson<{ get_updates_buf?: string }>(SYNC_FILE)?.get_updates_buf ?? "";
}

export function saveCursor(cursor: string): void {
  writeJson(SYNC_FILE, { get_updates_buf: cursor });
}

/** Latest context token per user, persisted so replies and pushes survive restarts. */
export class ContextTokenStore {
  private entries: Record<string, ContextTokenEntry> = readJson(CONTEXT_TOKENS_FILE) ?? {};

  get(userId: string): ContextTokenEntry | undefined {
    return this.entries[userId];
  }

  set(userId: string, token: string): void {
    this.entries[userId] = { token, updatedAt: Date.now() };
    writeJson(CONTEXT_TOKENS_FILE, this.entries);
  }
}
