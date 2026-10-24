// Cloudflare Access check for requests that come through the tunnel. Access
// signs a JWT for every request it lets through and passes it in the
// Cf-Access-Jwt-Assertion header; we check it ourselves, so a request that
// reaches the listener some other way gets nothing.

import crypto from "node:crypto";

import { describeError, log } from "../log.ts";

export interface AccessConfig {
  /** e.g. myteam.cloudflareaccess.com */
  teamDomain: string;
  /** The Access application's AUD tag. */
  aud: string;
  /** The only identity allowed in. */
  ownerEmail: string;
}

interface Jwk {
  kid?: string;
  kty: string;
  [key: string]: unknown;
}

export type KeyFetcher = (url: string) => Promise<{ keys: Jwk[] }>;

const KEY_REFETCH_MS = 60_000;
const CLOCK_SKEW_S = 60;

async function fetchKeys(url: string): Promise<{ keys: Jwk[] }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return (await res.json()) as { keys: Jwk[] };
}

function base64urlJson(part: string): Record<string, unknown> {
  const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not a JSON object");
  return value as Record<string, unknown>;
}

export class AccessVerifier {
  private readonly config: AccessConfig;
  private readonly fetcher: KeyFetcher;
  private readonly now: () => number;
  private keys = new Map<string, crypto.KeyObject>();
  private lastFetch = 0;
  private fetching?: Promise<void>;

  constructor(config: AccessConfig, opts: { fetcher?: KeyFetcher; now?: () => number } = {}) {
    this.config = config;
    this.fetcher = opts.fetcher ?? fetchKeys;
    this.now = opts.now ?? Date.now;
  }

  get issuer(): string {
    return `https://${this.config.teamDomain}`;
  }

  /** The verified email, or why the token is refused. */
  async verify(token: string | undefined): Promise<{ email: string } | { error: string }> {
    if (!token) return { error: "no Access token" };
    const parts = token.split(".");
    if (parts.length !== 3) return { error: "malformed token" };
    const [headerPart = "", payloadPart = "", sigPart = ""] = parts;
    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    try {
      header = base64urlJson(headerPart);
      payload = base64urlJson(payloadPart);
    } catch {
      return { error: "malformed token" };
    }
    if (header.alg !== "RS256") return { error: `unexpected alg ${String(header.alg)}` };
    const kid = typeof header.kid === "string" ? header.kid : "";
    const key = await this.key(kid);
    if (!key) return { error: "unknown signing key" };
    const signed = crypto.verify("RSA-SHA256", Buffer.from(`${headerPart}.${payloadPart}`), key, Buffer.from(sigPart, "base64url"));
    if (!signed) return { error: "bad signature" };

    const nowS = this.now() / 1000;
    if (typeof payload.exp !== "number" || payload.exp < nowS - CLOCK_SKEW_S) return { error: "expired" };
    if (typeof payload.nbf === "number" && payload.nbf > nowS + CLOCK_SKEW_S) return { error: "not yet valid" };
    if (payload.iss !== this.issuer) return { error: "wrong issuer" };
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(this.config.aud)) return { error: "wrong audience" };
    const email = typeof payload.email === "string" ? payload.email : "";
    if (email.toLowerCase() !== this.config.ownerEmail.toLowerCase()) return { error: "not the owner" };
    return { email };
  }

  private async key(kid: string): Promise<crypto.KeyObject | undefined> {
    const known = this.keys.get(kid);
    if (known) return known;
    // Access rotates keys; an unknown kid triggers a refetch, at most once a minute.
    if (this.now() - this.lastFetch < KEY_REFETCH_MS) return undefined;
    await (this.fetching ??= this.refresh().finally(() => (this.fetching = undefined)));
    return this.keys.get(kid);
  }

  private async refresh(): Promise<void> {
    this.lastFetch = this.now();
    try {
      const { keys } = await this.fetcher(`${this.issuer}/cdn-cgi/access/certs`);
      const next = new Map<string, crypto.KeyObject>();
      for (const jwk of keys) {
        if (jwk.kty !== "RSA" || !jwk.kid) continue;
        next.set(jwk.kid, crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: "jwk" }));
      }
      this.keys = next;
    } catch (err) {
      log.warn(`fetching Access signing keys failed: ${describeError(err)}`);
    }
  }
}
