// WeChat iLink bot HTTP client.
// Wire format ported from Tencent/openclaw-weixin (MIT), src/api/api.ts. See NOTICE.

import crypto from "node:crypto";

import { log, redact } from "../log.ts";
import type {
  BaseInfo,
  GetConfigResp,
  GetUpdatesResp,
  GetUploadUrlReq,
  GetUploadUrlResp,
  SendMessageReq,
  SendMessageResp,
  SimpleResp,
} from "./types.ts";

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

/**
 * Revision of the reference client (@tencent-weixin/openclaw-weixin) whose wire
 * protocol this module mirrors. Sent as `channel_version` and `iLink-App-ClientVersion`.
 */
const PROTOCOL_VERSION = "2.4.9";
const APP_ID = "bot";
/** Our own identity, declared through the field the protocol reserves for it. */
const BOT_AGENT = "Alfred/0.1.0";

export const STALE_TOKEN_ERRCODE = -14;

const LONG_POLL_TIMEOUT_MS = 35_000;
/** Extra client-side wait on top of the server's long-poll hold. */
const LONG_POLL_GRACE_MS = 5_000;
const API_TIMEOUT_MS = 15_000;
const LIGHT_TIMEOUT_MS = 10_000;

export class IlinkApiError extends Error {
  readonly ret: number | undefined;
  readonly errcode: number | undefined;

  constructor(label: string, resp: { ret?: number; errcode?: number; errmsg?: string }) {
    super(`${label} failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""}`);
    this.name = "IlinkApiError";
    this.ret = resp.ret;
    this.errcode = resp.errcode;
  }
}

/** 0x00MMNNPP encoded as a decimal string, e.g. "2.4.9" -> "132105". */
function encodeClientVersion(version: string): string {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((p) => parseInt(p, 10) || 0);
  return String(((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff));
}

/** X-WECHAT-UIN: random uint32 -> decimal string -> base64. */
function randomWechatUin(): string {
  return Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), "utf-8").toString("base64");
}

export function baseInfo(): BaseInfo {
  return { channel_version: PROTOCOL_VERSION, bot_agent: BOT_AGENT };
}

function commonHeaders(): Record<string, string> {
  return {
    "iLink-App-Id": APP_ID,
    "iLink-App-ClientVersion": encodeClientVersion(PROTOCOL_VERSION),
  };
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === "TimeoutError";
}

function withTimeout(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

/** POST JSON. `token` adds bot auth; callers decide whether the body carries base_info. */
export async function postJson(params: {
  baseUrl: string;
  endpoint: string;
  body: unknown;
  token?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  label: string;
}): Promise<string> {
  const url = new URL(params.endpoint, params.baseUrl.endsWith("/") ? params.baseUrl : `${params.baseUrl}/`);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    ...commonHeaders(),
  };
  if (params.token) headers.Authorization = `Bearer ${params.token}`;
  const body = JSON.stringify(params.body);
  log.debug(`${params.label} POST ${url.pathname} body=${redact(body)}`);

  const res = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal: withTimeout(params.timeoutMs, params.signal),
  });
  const text = await res.text();
  log.debug(`${params.label} status=${res.status} body=${redact(text)}`);
  if (!res.ok) throw new Error(`${params.label} HTTP ${res.status}: ${redact(text, 300)}`);
  return text;
}

/** GET with app headers only (used by QR status polling). */
export async function getText(params: {
  baseUrl: string;
  endpoint: string;
  timeoutMs: number;
  label: string;
}): Promise<string> {
  const url = new URL(params.endpoint, params.baseUrl.endsWith("/") ? params.baseUrl : `${params.baseUrl}/`);
  const res = await fetch(url, {
    method: "GET",
    headers: commonHeaders(),
    signal: AbortSignal.timeout(params.timeoutMs),
  });
  const text = await res.text();
  log.debug(`${params.label} status=${res.status} body=${redact(text)}`);
  if (!res.ok) throw new Error(`${params.label} HTTP ${res.status}: ${redact(text, 300)}`);
  return text;
}

const LOSSLESS_ID_FIELDS = new Set(["message_id", "msg_id", "svr_id"]);

/**
 * JSON.parse that keeps uint64 message identifiers as strings. Only rewrites
 * numeric values of the listed object keys, never text inside JSON strings.
 */
export function parseIlinkJson<T>(raw: string): T {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    if (raw[i] !== '"') {
      out += raw[i++];
      continue;
    }
    const start = i++;
    let escaped = false;
    while (i < raw.length) {
      const ch = raw[i++];
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') break;
    }
    const strToken = raw.slice(start, i);
    out += strToken;

    let cursor = i;
    while (/\s/.test(raw[cursor] ?? "")) cursor++;
    if (raw[cursor] !== ":") continue;
    let key: unknown;
    try {
      key = JSON.parse(strToken);
    } catch {
      continue;
    }
    if (typeof key !== "string" || !LOSSLESS_ID_FIELDS.has(key)) continue;

    out += raw.slice(i, cursor + 1);
    cursor++;
    while (/\s/.test(raw[cursor] ?? "")) out += raw[cursor++];
    const numStart = cursor;
    if (raw[cursor] === "-") cursor++;
    while (/\d/.test(raw[cursor] ?? "")) cursor++;
    const isNumber = cursor > numStart && !(cursor === numStart + 1 && raw[numStart] === "-");
    if (isNumber) {
      out += `"${raw.slice(numStart, cursor)}"`;
      i = cursor;
    } else {
      i = numStart;
    }
  }
  return JSON.parse(out) as T;
}

/** Authenticated bot API bound to one bot token. */
export class IlinkClient {
  readonly baseUrl: string;
  readonly token: string;

  constructor(opts: { baseUrl: string; token: string }) {
    this.baseUrl = opts.baseUrl;
    this.token = opts.token;
  }

  private post(endpoint: string, body: object, label: string, timeoutMs: number, signal?: AbortSignal) {
    return postJson({
      baseUrl: this.baseUrl,
      endpoint,
      body: { ...body, base_info: baseInfo() },
      token: this.token,
      timeoutMs,
      signal,
      label,
    });
  }

  /**
   * Long-poll for new messages. A client-side timeout is normal and yields an
   * empty batch with the cursor unchanged; an external abort is rethrown.
   */
  async getUpdates(cursor: string, holdMs = LONG_POLL_TIMEOUT_MS, signal?: AbortSignal): Promise<GetUpdatesResp> {
    try {
      const raw = await this.post(
        "ilink/bot/getupdates",
        { get_updates_buf: cursor },
        "getUpdates",
        holdMs + LONG_POLL_GRACE_MS,
        signal,
      );
      return parseIlinkJson<GetUpdatesResp>(raw);
    } catch (err) {
      if (isTimeout(err) && !signal?.aborted) return { ret: 0, msgs: [], get_updates_buf: cursor };
      throw err;
    }
  }

  async sendMessage(req: SendMessageReq): Promise<SendMessageResp> {
    const raw = await this.post("ilink/bot/sendmessage", req, "sendMessage", API_TIMEOUT_MS);
    const resp = parseIlinkJson<SendMessageResp>(raw);
    if (resp.ret !== undefined && resp.ret !== 0) throw new IlinkApiError("sendMessage", resp);
    return resp;
  }

  async getUploadUrl(req: GetUploadUrlReq): Promise<GetUploadUrlResp> {
    const raw = await this.post("ilink/bot/getuploadurl", req, "getUploadUrl", API_TIMEOUT_MS);
    return JSON.parse(raw) as GetUploadUrlResp;
  }

  async getConfig(userId: string, contextToken?: string): Promise<GetConfigResp> {
    const raw = await this.post(
      "ilink/bot/getconfig",
      { ilink_user_id: userId, context_token: contextToken },
      "getConfig",
      LIGHT_TIMEOUT_MS,
    );
    return JSON.parse(raw) as GetConfigResp;
  }

  async sendTyping(userId: string, typingTicket: string, status: number): Promise<void> {
    await this.post(
      "ilink/bot/sendtyping",
      { ilink_user_id: userId, typing_ticket: typingTicket, status },
      "sendTyping",
      LIGHT_TIMEOUT_MS,
    );
  }

  async notifyStart(): Promise<SimpleResp> {
    return JSON.parse(await this.post("ilink/bot/msg/notifystart", {}, "notifyStart", LIGHT_TIMEOUT_MS));
  }

  async notifyStop(): Promise<SimpleResp> {
    return JSON.parse(await this.post("ilink/bot/msg/notifystop", {}, "notifyStop", LIGHT_TIMEOUT_MS));
  }
}
