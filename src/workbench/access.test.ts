import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";

import { AccessVerifier } from "./access.ts";

const config = { teamDomain: "team.cloudflareaccess.com", aud: "aud-tag", ownerEmail: "Owner@example.com" };
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kty: "RSA", kid: "k1", alg: "RS256", use: "sig" };
const NOW = Date.parse("2026-10-25T00:00:00Z");

function sign(payload: Record<string, unknown>, opts: { kid?: string; alg?: string; key?: crypto.KeyObject } = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: opts.alg ?? "RS256", kid: opts.kid ?? "k1", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${body}`), opts.key ?? privateKey).toString("base64url");
  return `${header}.${body}.${sig}`;
}

function claims(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    aud: ["aud-tag"],
    iss: "https://team.cloudflareaccess.com",
    email: "owner@example.com",
    exp: NOW / 1000 + 600,
    iat: NOW / 1000 - 10,
    ...patch,
  };
}

function verifier(fetches: string[] = [], serviceClientId?: string): AccessVerifier {
  return new AccessVerifier(serviceClientId === undefined ? config : { ...config, serviceClientId }, {
    now: () => NOW,
    fetcher: async (url) => {
      fetches.push(url);
      return { keys: [jwk] };
    },
  });
}

test("a token Access signed for the owner and this application passes", async () => {
  const fetches: string[] = [];
  const v = verifier(fetches);
  assert.deepEqual(await v.verify(sign(claims())), { email: "owner@example.com" });
  assert.deepEqual(await v.verify(sign(claims({ aud: "aud-tag" }))), { email: "owner@example.com" }, "aud as a string");
  assert.deepEqual(fetches, ["https://team.cloudflareaccess.com/cdn-cgi/access/certs"], "keys are fetched once and cached");
});

test("tokens with the wrong audience, issuer, email or lifetime are refused", async () => {
  const v = verifier();
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ aud: ["other-app"] }, /audience/],
    [{ iss: "https://evil.cloudflareaccess.com" }, /issuer/],
    [{ email: "someone@example.com" }, /owner/],
    [{ email: undefined }, /owner/],
    [{ exp: NOW / 1000 - 3600 }, /expired/],
    [{ exp: undefined }, /expired/],
    [{ nbf: NOW / 1000 + 3600 }, /not yet valid/],
  ];
  for (const [patch, reason] of cases) {
    const verdict = await v.verify(sign(claims(patch)));
    assert.ok("error" in verdict, JSON.stringify(patch));
    assert.match(verdict.error, reason, JSON.stringify(patch));
  }
});

test("missing, malformed, unsigned and forged tokens are refused", async () => {
  const v = verifier();
  assert.deepEqual(await v.verify(undefined), { error: "no Access token" });
  assert.deepEqual(await v.verify("abc"), { error: "malformed token" });
  assert.deepEqual(await v.verify("a.b.c"), { error: "malformed token" });
  const none = `${Buffer.from(JSON.stringify({ alg: "none", kid: "k1" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims())).toString("base64url")}.`;
  const unsigned = await v.verify(none);
  assert.ok("error" in unsigned);
  assert.match(unsigned.error, /alg/);
  assert.deepEqual(await v.verify(sign(claims(), { key: other.privateKey })), { error: "bad signature" });
  const [h, , s] = sign(claims()).split(".");
  const tampered = `${h}.${Buffer.from(JSON.stringify(claims({ email: "owner@example.com", exp: NOW / 1000 + 99999 }))).toString("base64url")}.${s}`;
  assert.deepEqual(await v.verify(tampered), { error: "bad signature" });
});

test("an unknown key id refetches the keys at most once a minute", async () => {
  const fetches: string[] = [];
  const v = verifier(fetches);
  assert.deepEqual(await v.verify(sign(claims(), { kid: "k2" })), { error: "unknown signing key" });
  assert.deepEqual(await v.verify(sign(claims(), { kid: "k2" })), { error: "unknown signing key" });
  assert.equal(fetches.length, 1);
});

// What Access signs for a request that passed a Service Auth policy: the token's client id as
// common_name, and no email.
function serviceClaims(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return claims({ email: undefined, common_name: "abc123.access", type: "app", sub: "", ...patch });
}

test("a service-token JWT passes with the configured client id", async () => {
  const v = verifier([], "abc123.access");
  assert.deepEqual(await v.verify(sign(serviceClaims())), { serviceClientId: "abc123.access" });
  assert.deepEqual(await v.verify(sign(claims())), { email: "owner@example.com" }, "the owner still passes as the owner");
});

test("a service-token JWT fails with another client id or none configured", async () => {
  const token = sign(serviceClaims());
  for (const v of [verifier([], "other.access"), verifier(), verifier([], "")]) {
    const verdict = await v.verify(token);
    assert.ok("error" in verdict);
    assert.match(verdict.error, /service token/);
  }
});

test("a service-token JWT is checked like any other: signature, audience, issuer and lifetime", async () => {
  const v = verifier([], "abc123.access");
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ aud: ["other-app"] }, /audience/],
    [{ iss: "https://evil.cloudflareaccess.com" }, /issuer/],
    [{ exp: NOW / 1000 - 3600 }, /expired/],
  ];
  for (const [patch, reason] of cases) {
    const verdict = await v.verify(sign(serviceClaims(patch)));
    assert.ok("error" in verdict, JSON.stringify(patch));
    assert.match(verdict.error, reason, JSON.stringify(patch));
  }
  assert.deepEqual(await v.verify(sign(serviceClaims(), { key: other.privateKey })), { error: "bad signature" });
  assert.deepEqual(await v.verify(sign(serviceClaims({ common_name: undefined }))), { error: "not the owner" });
});

test("a token with another person's email is not a service token, whatever its common_name", async () => {
  const v = verifier([], "abc123.access");
  const verdict = await v.verify(sign(claims({ email: "someone@example.com", common_name: "abc123.access" })));
  assert.deepEqual(verdict, { error: "not the owner" });
});
