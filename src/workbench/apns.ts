// Apple Push Notification service over HTTP/2, token-based: the .p8 key signs a
// provider token (a JWT) that every request carries. Only node:http2 and node:crypto
// are used. Delivery is best effort: a request is sent once, and an answer other than
// 200 is returned to the caller, which decides what a dead device token means. The key,
// the provider token and the device tokens never reach the log.

import crypto from "node:crypto";
import type { KeyObject } from "node:crypto";
import fs from "node:fs";
import http2 from "node:http2";

import type { PushRegistration } from "../api/schema.ts";
import { describeError, log } from "../log.ts";

type Environment = PushRegistration["environment"];

/** APNs's gateways: the sandbox for development-signed apps, production otherwise. */
export const GATEWAYS: Readonly<Record<Environment, string>> = {
  development: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};

/** Apple takes a provider token that is 20 to 60 minutes old; this client mints one every 50. */
const TOKEN_REFRESH_MS = 50 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** The reasons APNs gives for refusing the provider token itself. */
const TOKEN_REFUSED = new Set(["ExpiredProviderToken", "InvalidProviderToken"]);

/** The environment variables push reads. */
export const PUSH_VARS = ["ALFRED_APNS_KEY_FILE", "ALFRED_APNS_KEY_ID", "ALFRED_APNS_TEAM_ID", "ALFRED_APNS_TOPIC"] as const;

export interface ApnsSettings {
  key: KeyObject;
  keyId: string;
  teamId: string;
  topic: string;
}

/**
 * The push settings from the environment: the variables that are not set, or the
 * settings. The key file is read and checked here. A failure names its variable and
 * never shows the key.
 */
export function apnsSettings(
  env: Record<string, string | undefined> = process.env,
): { ok: true; settings: ApnsSettings } | { ok: false; missing: string[] } {
  const value = (name: string) => env[name]?.trim() ?? "";
  const missing = PUSH_VARS.filter((name) => !value(name));
  if (missing.length) return { ok: false, missing: [...missing] };
  return {
    ok: true,
    settings: {
      key: readKey(value("ALFRED_APNS_KEY_FILE")),
      keyId: value("ALFRED_APNS_KEY_ID"),
      teamId: value("ALFRED_APNS_TEAM_ID"),
      topic: value("ALFRED_APNS_TOPIC"),
    },
  };
}

function readKey(file: string): KeyObject {
  let pem: string;
  try {
    pem = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`ALFRED_APNS_KEY_FILE cannot be read: ${describeError(err)}`);
  }
  let key: KeyObject;
  try {
    key = crypto.createPrivateKey(pem);
  } catch {
    throw new Error("ALFRED_APNS_KEY_FILE does not hold a private key in PEM form");
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("ALFRED_APNS_KEY_FILE holds a key that is not P-256");
  }
  return key;
}

export interface ApnsOptions extends ApnsSettings {
  /** The gateway for each environment; tests point these at a local cleartext server. */
  gateways?: Partial<Record<Environment, string>>;
  /** The clock, in epoch milliseconds. */
  now?: () => number;
  /** How long a request waits for APNs's answer. */
  timeoutMs?: number;
}

/** APNs's answer: its status, and its reason when it refused. Status 0 means there was no answer; the reason then says why. */
export interface ApnsResult {
  status: number;
  reason?: string;
}

/** A status and body from APNs, as an ApnsResult. The reason is read from the body of a refusal. */
function answer(status: number, text: string): ApnsResult {
  if (status === 200) return { status };
  let reason: unknown;
  try {
    reason = (JSON.parse(text) as { reason?: unknown }).reason;
  } catch {
    // No JSON body, so no reason.
  }
  return typeof reason === "string" ? { status, reason } : { status };
}

export class ApnsClient {
  private readonly key: KeyObject;
  private readonly keyId: string;
  private readonly teamId: string;
  private readonly topic: string;
  private readonly gateways: Record<Environment, string>;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly sessions = new Map<string, http2.ClientHttp2Session>();
  private token?: { jwt: string; mintedAt: number };

  constructor(opts: ApnsOptions) {
    this.key = opts.key;
    this.keyId = opts.keyId;
    this.teamId = opts.teamId;
    this.topic = opts.topic;
    this.gateways = { ...GATEWAYS, ...opts.gateways };
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /**
   * Sends one alert to a device. A provider token that APNs refuses as expired or
   * invalid is replaced and the send retried once; any other answer is returned as it came.
   */
  async send(to: PushRegistration, payload: object): Promise<ApnsResult> {
    const body = JSON.stringify(payload);
    const used = this.providerToken();
    const first = await this.post(to, body, used);
    if (first.status !== 403 || !TOKEN_REFUSED.has(first.reason ?? "")) return first;
    return this.post(to, body, this.providerToken(used));
  }

  /** Closes the sessions. A request still in flight completes first. */
  close(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  /**
   * The provider token to send with: the one minted last while it is under 50 minutes
   * old. `refused` is a token APNs just refused; it is replaced unless another request
   * has already replaced it.
   */
  private providerToken(refused?: string): string {
    const now = this.now();
    const cached = this.token;
    if (cached && now - cached.mintedAt < TOKEN_REFRESH_MS && cached.jwt !== refused) return cached.jwt;
    const jwt = this.mint(now);
    this.token = { jwt, mintedAt: now };
    return jwt;
  }

  /** An ES256 JWT: the key id in the header; the team id and the issue time, in seconds, in the claims; the signature as raw r||s. */
  private mint(now: number): string {
    const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: this.keyId })).toString("base64url");
    const claims = Buffer.from(JSON.stringify({ iss: this.teamId, iat: Math.floor(now / 1000) })).toString("base64url");
    const input = `${header}.${claims}`;
    const signature = crypto.sign("sha256", Buffer.from(input), { key: this.key, dsaEncoding: "ieee-p1363" });
    return `${input}.${signature.toString("base64url")}`;
  }

  /** One request to the device's gateway. It resolves once: with APNs's answer, or status 0 when there is none. */
  private post(to: PushRegistration, body: string, jwt: string): Promise<ApnsResult> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result: ApnsResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      let stream: http2.ClientHttp2Stream;
      try {
        stream = this.session(this.gateways[to.environment]).request({
          ":method": "POST",
          ":path": `/3/device/${to.token}`,
          authorization: `bearer ${jwt}`,
          "apns-topic": this.topic,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "content-type": "application/json",
        });
      } catch (err) {
        return settle({ status: 0, reason: describeError(err) });
      }
      let status = 0;
      let text = "";
      stream.setEncoding("utf8");
      stream.on("response", (headers) => {
        status = Number(headers[":status"]);
      });
      stream.on("data", (chunk: string) => {
        text += chunk;
      });
      stream.on("end", () => settle(answer(status, text)));
      stream.on("close", () => settle(status ? answer(status, text) : { status: 0, reason: "the stream closed without an answer" }));
      stream.on("error", (err) => settle({ status: 0, reason: describeError(err) }));
      stream.setTimeout(this.timeoutMs, () => {
        settle({ status: 0, reason: "timed out" });
        stream.close(http2.constants.NGHTTP2_CANCEL);
      });
      stream.end(body);
    });
  }

  /** The HTTP/2 session to a gateway: opened on first use and kept. An error or a GOAWAY ends it, and the next request opens another. */
  private session(gateway: string): http2.ClientHttp2Session {
    const open = this.sessions.get(gateway);
    if (open && !open.closed && !open.destroyed) return open;
    const session = http2.connect(gateway);
    const forget = () => {
      if (this.sessions.get(gateway) === session) this.sessions.delete(gateway);
    };
    session.on("error", (err) => {
      log.warn(`APNs connection to ${gateway} failed: ${describeError(err)}`);
      forget();
    });
    session.on("goaway", () => {
      forget();
      session.close();
    });
    session.on("close", forget);
    this.sessions.set(gateway, session);
    return session;
  }
}
