import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, mock, test } from "node:test";

import type { ApnsClient as Client } from "./apns.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-apns-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { ApnsClient, GATEWAYS, apnsSettings } = await import("./apns.ts");

// A P-256 key made for the test, and a second device token. Nothing here reaches Apple.
const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const PRIVATE_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const KEY_ID = "ABC123DEFG";
const TEAM_ID = "TEAM456789";
const TOPIC = "com.example.alfred";
const TOKEN = crypto.randomBytes(32).toString("hex");
const OTHER_TOKEN = crypto.randomBytes(32).toString("hex");
const SETTINGS = { key: privateKey, keyId: KEY_ID, teamId: TEAM_ID, topic: TOPIC };
const APP = { token: TOKEN, environment: "development" } as const;

const decode = (part: string) => Buffer.from(part, "base64url").toString("utf8");
/** The claims of a bearer header's JWT. */
function claimsOf(authorization: string | string[] | undefined): { iss: string; iat: number } {
  const [, claims = ""] = String(authorization).split(" ")[1]?.split(".") ?? [];
  return JSON.parse(decode(claims));
}

// --- A local cleartext HTTP/2 server standing in for an APNs gateway -------

type Reply = { status: number; reason?: string } | "silent";

interface Sent {
  path: string;
  headers: http2.IncomingHttpHeaders;
  body: string;
  /** Which session the request came on, counted from 1. */
  session: number;
}

interface Gateway {
  origin: string;
  /** Every request that arrived in full, in order. */
  sent: Sent[];
  /** The sessions the gateway has accepted, in order. */
  sessions: http2.ServerHttp2Session[];
  close(): Promise<void>;
}

/** `reply` answers the nth request (counted from 1) on the gateway; "silent" never answers. */
async function gateway(reply: (n: number, path: string) => Reply = () => ({ status: 200 })): Promise<Gateway> {
  const sessions: http2.ServerHttp2Session[] = [];
  const sent: Sent[] = [];
  const server = http2.createServer();
  server.on("session", (session) => {
    sessions.push(session);
    session.on("error", () => {});
  });
  server.on("stream", (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on("error", () => {});
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      const requestPath = String(headers[":path"]);
      sent.push({
        path: requestPath,
        headers,
        body: Buffer.concat(chunks).toString("utf8"),
        session: sessions.indexOf(stream.session as http2.ServerHttp2Session) + 1,
      });
      const answer = reply(sent.length, requestPath);
      if (answer === "silent") return;
      stream.respond({ ":status": answer.status, "content-type": "application/json" });
      stream.end(answer.reason ? JSON.stringify({ reason: answer.reason }) : undefined);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    sent,
    sessions,
    close: () =>
      new Promise<void>((resolve) => {
        for (const session of sessions) session.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A client whose two gateways are both the given local servers, with an injected clock. */
function clientFor(dev: Gateway, prod: Gateway, now: () => number, timeoutMs?: number): Client {
  return new ApnsClient({ ...SETTINGS, gateways: { development: dev.origin, production: prod.origin }, now, timeoutMs });
}

// --- Tests -------------------------------------------------------------------

test("the provider token is ES256 over the key id and team id, its signature is raw r||s, and it verifies", async () => {
  const at = Date.UTC(2026, 9, 26, 12, 0, 0);
  const dev = await gateway();
  const prod = await gateway();
  const apns = clientFor(dev, prod, () => at);
  try {
    assert.equal((await apns.send(APP, { aps: {} })).status, 200);
    const authorization = String(dev.sent[0]?.headers.authorization);
    const [scheme, jwt = ""] = authorization.split(" ");
    assert.equal(scheme, "bearer", "lowercase bearer scheme");
    const [head = "", claims = "", signature = ""] = jwt.split(".");
    assert.deepEqual(JSON.parse(decode(head)), { alg: "ES256", kid: KEY_ID });
    assert.deepEqual(JSON.parse(decode(claims)), { iss: TEAM_ID, iat: Math.floor(at / 1000) });
    const raw = Buffer.from(signature, "base64url");
    assert.equal(raw.length, 64, "r and s as 32 bytes each, not DER");
    assert.ok(crypto.verify("sha256", Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, raw));
  } finally {
    apns.close();
    await dev.close();
    await prod.close();
  }
});

test("one provider token serves for 50 minutes, and the next send after that mints a new one", async () => {
  const dev = await gateway();
  const prod = await gateway();
  let now = Date.UTC(2026, 9, 26, 12, 0, 0);
  const apns = clientFor(dev, prod, () => now);
  try {
    await apns.send(APP, {});
    now += 49 * 60_000;
    await apns.send(APP, {});
    now += 60_000; // 50 minutes after the first
    await apns.send(APP, {});
    const [first, second, third] = dev.sent.map((s) => s.headers.authorization);
    assert.equal(first, second, "reused inside 50 minutes");
    assert.notEqual(second, third, "replaced at 50 minutes");
    assert.equal(claimsOf(third).iat, Math.floor(now / 1000), "its iat is the new time");
  } finally {
    apns.close();
    await dev.close();
    await prod.close();
  }
});

test("each environment goes to its own gateway, with the path, headers and payload APNs expects", async () => {
  const dev = await gateway();
  const prod = await gateway();
  const apns = clientFor(dev, prod, () => Date.now());
  const payload = { aps: { alert: { title: "Alfred", body: "好" }, sound: "default", "thread-id": "chat" }, eventId: 7 };
  try {
    await apns.send({ token: TOKEN, environment: "development" }, payload);
    await apns.send({ token: OTHER_TOKEN, environment: "production" }, payload);
    assert.equal(dev.sent.length, 1, "development went to the development gateway only");
    assert.equal(prod.sent.length, 1, "production went to the production gateway only");
    const expect = [
      [dev.sent[0], TOKEN],
      [prod.sent[0], OTHER_TOKEN],
    ] as const;
    for (const [sent, token] of expect) {
      assert.equal(sent?.headers[":method"], "POST");
      assert.equal(sent?.path, `/3/device/${token}`);
      assert.equal(sent?.headers["apns-topic"], TOPIC);
      assert.equal(sent?.headers["apns-push-type"], "alert");
      assert.equal(sent?.headers["apns-priority"], "10");
      assert.deepEqual(JSON.parse(sent?.body ?? ""), payload);
    }
  } finally {
    apns.close();
    await dev.close();
    await prod.close();
  }
});

test("the default gateways are APNs's sandbox for development and its production gateway otherwise", () => {
  assert.deepEqual(GATEWAYS, { development: "https://api.sandbox.push.apple.com", production: "https://api.push.apple.com" });
});

test("a 410 or a BadDeviceToken comes back as APNs's answer, and no other refusal is retried", async () => {
  const replies: Reply[] = [
    { status: 410, reason: "Unregistered" },
    { status: 400, reason: "BadDeviceToken" },
    { status: 429, reason: "TooManyRequests" },
    { status: 500, reason: "InternalServerError" },
  ];
  const dev = await gateway((n) => replies[n - 1] ?? { status: 200 });
  const prod = await gateway();
  const apns = clientFor(dev, prod, () => Date.now());
  try {
    assert.deepEqual(await apns.send(APP, {}), { status: 410, reason: "Unregistered" });
    assert.deepEqual(await apns.send(APP, {}), { status: 400, reason: "BadDeviceToken" });
    assert.deepEqual(await apns.send(APP, {}), { status: 429, reason: "TooManyRequests" });
    assert.deepEqual(await apns.send(APP, {}), { status: 500, reason: "InternalServerError" });
    assert.equal(dev.sent.length, 4, "one request each: delivery is best effort");
  } finally {
    apns.close();
    await dev.close();
    await prod.close();
  }
});

test("an expired provider token is refreshed and the send retried once", async () => {
  const dev = await gateway((n) => (n === 1 ? { status: 403, reason: "ExpiredProviderToken" } : { status: 200 }));
  const prod = await gateway();
  const apns = clientFor(dev, prod, () => Date.now());
  try {
    assert.equal((await apns.send(APP, {})).status, 200);
    assert.equal(dev.sent.length, 2);
    assert.notEqual(dev.sent[0]?.headers.authorization, dev.sent[1]?.headers.authorization, "a new token for the retry");
  } finally {
    apns.close();
    await dev.close();
    await prod.close();
  }
});

test("an invalid provider token is refreshed too, but a refusal of the retry is not retried again", async () => {
  const dev = await gateway(() => ({ status: 403, reason: "InvalidProviderToken" }));
  const prod = await gateway();
  const apns = clientFor(dev, prod, () => Date.now());
  try {
    assert.deepEqual(await apns.send(APP, {}), { status: 403, reason: "InvalidProviderToken" });
    assert.equal(dev.sent.length, 2, "the send and one retry");
    assert.notEqual(dev.sent[0]?.headers.authorization, dev.sent[1]?.headers.authorization);
  } finally {
    apns.close();
    await dev.close();
    await prod.close();
  }
});

test("two sends refused together refresh the provider token once between them", async () => {
  const dev = await gateway((n) => (n <= 2 ? { status: 403, reason: "ExpiredProviderToken" } : { status: 200 }));
  const prod = await gateway();
  const apns = clientFor(dev, prod, () => Date.now());
  try {
    const results = await Promise.all([apns.send(APP, {}), apns.send(APP, {})]);
    assert.deepEqual(results.map((r) => r.status), [200, 200]);
    assert.equal(new Set(dev.sent.map((s) => s.headers.authorization)).size, 2, "one original token and one refresh");
  } finally {
    apns.close();
    await dev.close();
    await prod.close();
  }
});

test("after a GOAWAY the next send opens a new session", async () => {
  const dev = await gateway();
  const prod = await gateway();
  const apns = clientFor(dev, prod, () => Date.now());
  try {
    await apns.send(APP, {});
    assert.equal(dev.sessions.length, 1);
    const first = dev.sessions[0];
    assert.ok(first);
    first.goaway();
    // Client and gateway share this event loop on loopback, so the client has read the GOAWAY after one timer tick.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await apns.send(APP, {})).status, 200);
    assert.equal(dev.sessions.length, 2, "a second session");
    assert.equal(dev.sent[1]?.session, 2);
  } finally {
    apns.close();
    await dev.close();
    await prod.close();
  }
});

test("a send that gets no answer in time is abandoned, and the session serves the next send", async () => {
  const dev = await gateway((n) => (n === 1 ? "silent" : { status: 200 }));
  const prod = await gateway();
  const apns = clientFor(dev, prod, () => Date.now(), 50);
  try {
    assert.deepEqual(await apns.send(APP, {}), { status: 0, reason: "timed out" });
    assert.equal((await apns.send(APP, {})).status, 200);
    assert.equal(dev.sessions.length, 1, "the same session");
  } finally {
    apns.close();
    await dev.close();
    await prod.close();
  }
});

test("neither the device token nor the provider token nor the key reaches the log", async () => {
  const dev = await gateway((n) => (n === 1 ? { status: 403, reason: "ExpiredProviderToken" } : { status: 200 }));
  const prod = await gateway();
  // A gateway nobody listens on: the connection itself fails, which is logged.
  const dead = new ApnsClient({ ...SETTINGS, gateways: { development: "http://127.0.0.1:1", production: prod.origin }, now: () => Date.now() });
  const lines: string[] = [];
  const out = mock.method(console, "log", (...args: unknown[]) => void lines.push(args.map(String).join(" ")));
  const err = mock.method(console, "error", (...args: unknown[]) => void lines.push(args.map(String).join(" ")));
  const apns = clientFor(dev, prod, () => Date.now());
  try {
    await apns.send(APP, {});
    assert.equal((await dead.send(APP, {})).status, 0, "no answer from a dead gateway");
  } finally {
    out.mock.restore();
    err.mock.restore();
    apns.close();
    dead.close();
    await dev.close();
    await prod.close();
  }
  assert.ok(lines.some((line) => /APNs connection/.test(line)), "the failed connection was logged");
  const jwt = String(dev.sent[0]?.headers.authorization).split(" ")[1] ?? "";
  for (const line of lines) {
    assert.ok(!line.includes(TOKEN), "device token");
    assert.ok(!line.includes(jwt), "provider token");
    assert.ok(!line.includes(PRIVATE_PEM.split("\n")[1] ?? "-"), "key");
  }
});

test("apnsSettings names the variables that are not set", () => {
  const keyFile = path.join(tmp, "AuthKey.p8");
  fs.writeFileSync(keyFile, PRIVATE_PEM, { mode: 0o600 });
  const names = ["ALFRED_APNS_KEY_FILE", "ALFRED_APNS_KEY_ID", "ALFRED_APNS_TEAM_ID", "ALFRED_APNS_TOPIC"];
  assert.deepEqual(apnsSettings({}), { ok: false, missing: names });
  assert.deepEqual(apnsSettings({ ALFRED_APNS_KEY_FILE: keyFile, ALFRED_APNS_TOPIC: TOPIC, ALFRED_APNS_KEY_ID: " " }), {
    ok: false,
    missing: ["ALFRED_APNS_KEY_ID", "ALFRED_APNS_TEAM_ID"],
  });
});

test("apnsSettings reads a P-256 key file, and a bad one fails without showing its contents", () => {
  const keyFile = path.join(tmp, "settings", "AuthKey.p8");
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, PRIVATE_PEM, { mode: 0o600 });
  const env = (file: string) => ({ ALFRED_APNS_KEY_FILE: file, ALFRED_APNS_KEY_ID: KEY_ID, ALFRED_APNS_TEAM_ID: TEAM_ID, ALFRED_APNS_TOPIC: TOPIC });

  const ok = apnsSettings(env(keyFile));
  assert.ok(ok.ok);
  assert.equal(ok.settings?.keyId, KEY_ID);
  assert.equal(ok.settings?.teamId, TEAM_ID);
  assert.equal(ok.settings?.topic, TOPIC);
  assert.equal(ok.settings?.key.asymmetricKeyType, "ec");

  assert.throws(() => apnsSettings(env(path.join(tmp, "missing.p8"))), /ALFRED_APNS_KEY_FILE/);

  const garbage = path.join(tmp, "garbage.p8");
  fs.writeFileSync(garbage, "-----BEGIN PRIVATE KEY-----\nnot a key at all\n-----END PRIVATE KEY-----\n");
  assert.throws(() => apnsSettings(env(garbage)), (err: Error) => /ALFRED_APNS_KEY_FILE/.test(err.message) && !err.message.includes("not a key at all"));

  for (const curve of ["P-384", "P-521"] as const) {
    const other = crypto.generateKeyPairSync("ec", { namedCurve: curve }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const file = path.join(tmp, `${curve}.p8`);
    fs.writeFileSync(file, other);
    assert.throws(() => apnsSettings(env(file)), /P-256/, curve);
  }
  const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const rsaFile = path.join(tmp, "rsa.p8");
  fs.writeFileSync(rsaFile, rsa);
  assert.throws(() => apnsSettings(env(rsaFile)), /P-256/, "RSA");
});
