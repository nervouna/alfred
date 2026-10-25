import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// store.ts reads this at import time, so set it before loading the module under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-devices-")));
process.env.ALFRED_STATE_DIR = path.join(tmp, "state");
delete process.env.ALFRED_WORKBENCH_STATE;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { DeviceStore, deviceStateDir } = await import("./devices.ts");

let n = 0;
function freshDir(): string {
  return path.join(tmp, `app-${n++}`);
}

test("a created device authenticates with its token", () => {
  const store = new DeviceStore(freshDir());
  const { id, token } = store.createDevice("iPhone");
  assert.match(id, /^[2-9a-hjkmnp-z]{6}$/);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/, "32 random bytes as base64url");
  const device = store.authenticate(token);
  assert.equal(device?.id, id);
  assert.equal(device?.name, "iPhone");
  assert.equal(store.authenticate(token)?.id, id, "again");
});

test("every device gets its own id and token", () => {
  const store = new DeviceStore(freshDir());
  const made = Array.from({ length: 30 }, () => store.createDevice("d"));
  assert.equal(new Set(made.map((d) => d.id)).size, 30);
  assert.equal(new Set(made.map((d) => d.token)).size, 30);
  for (const d of made) assert.equal(store.authenticate(d.token)?.id, d.id);
  assert.equal(store.list().length, 30);
});

test("a wrong, empty or truncated token fails", () => {
  const store = new DeviceStore(freshDir());
  const { token } = store.createDevice("iPhone");
  for (const wrong of ["", "x", `${token}x`, token.slice(1), token.toUpperCase(), "A".repeat(43)]) {
    assert.equal(store.authenticate(wrong), undefined, wrong);
  }
});

test("without a devices file nothing authenticates", () => {
  const store = new DeviceStore(freshDir());
  assert.equal(store.authenticate("A".repeat(43)), undefined);
  assert.deepEqual(store.list(), []);
});

test("a revoked device fails, the others keep working", () => {
  const store = new DeviceStore(freshDir());
  const a = store.createDevice("iPhone");
  const b = store.createDevice("iPad");
  store.revokeDevice(a.id);
  assert.equal(store.authenticate(a.token), undefined);
  assert.equal(store.authenticate(b.token)?.id, b.id);
  const revoked = store.list().find((d) => d.id === a.id);
  assert.ok(revoked?.revokedAt && !Number.isNaN(Date.parse(revoked.revokedAt)));
  const again = store.revokeDevice(a.id);
  assert.equal(again.revokedAt, revoked.revokedAt, "revoking twice keeps the first time");
});

test("an unknown id cannot be revoked", () => {
  const store = new DeviceStore(freshDir());
  const { id } = store.createDevice("iPhone");
  assert.throws(() => store.revokeDevice("zzzzz9"), /no device/);
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0]?.id, id);
  assert.equal(store.list()[0]?.revokedAt, undefined);
});

test("a revoke made through a second store instance is seen without a restart", () => {
  const dir = freshDir();
  const server = new DeviceStore(dir);
  const { id, token } = server.createDevice("iPhone");
  assert.equal(server.authenticate(token)?.id, id, "the file is loaded and cached");
  assert.equal(server.authenticate(token)?.id, id, "from the cache");

  new DeviceStore(dir).revokeDevice(id); // what `devices revoke` does in another process
  assert.equal(server.authenticate(token), undefined, "the next request is refused");

  // A device paired meanwhile is seen too.
  const other = new DeviceStore(dir).createDevice("iPad");
  assert.equal(server.authenticate(other.token)?.name, "iPad");
});

test("the file is 0600 in a 0700 directory and holds no token", () => {
  const dir = freshDir();
  const store = new DeviceStore(dir);
  const { id, token } = store.createDevice("iPhone");
  store.revokeDevice(store.createDevice("iPad").id);
  const file = path.join(dir, "devices.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(!text.includes(token), "the token is not stored");
  const stored = JSON.parse(text) as { devices: Record<string, unknown>[] };
  const device = stored.devices.find((d) => d.id === id);
  assert.deepEqual(Object.keys(device ?? {}).sort(), ["createdAt", "id", "name", "tokenSha256"]);
  assert.match(String(device?.tokenSha256), /^[0-9a-f]{64}$/);
  assert.deepEqual(fs.readdirSync(dir), ["devices.json"], "no temp file is left behind");
});

test("an existing directory is tightened to 0700", () => {
  const dir = freshDir();
  fs.mkdirSync(dir, { mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  new DeviceStore(dir).createDevice("iPhone");
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test("an unreadable devices file refuses everyone and is never overwritten", () => {
  const dir = freshDir();
  const store = new DeviceStore(dir);
  const { token } = store.createDevice("iPhone");
  const file = path.join(dir, "devices.json");
  fs.writeFileSync(file, "{ not json", { mode: 0o600 });
  assert.equal(store.authenticate(token), undefined);
  assert.throws(() => store.createDevice("iPad"));
  assert.throws(() => store.revokeDevice("k7m2qa"));
  assert.equal(fs.readFileSync(file, "utf8"), "{ not json");
});

test("names are 1-64 characters without control characters", () => {
  const store = new DeviceStore(freshDir());
  for (const bad of ["", "   ", "x".repeat(65), "a\nb", "\u001b[31mred"]) assert.throws(() => store.createDevice(bad), /name/, JSON.stringify(bad));
  assert.equal(store.list().length, 0);
  store.createDevice("  Damao's iPhone  ");
  assert.equal(store.list()[0]?.name, "Damao's iPhone");
});

test("the directory is ALFRED_WORKBENCH_STATE, else app/ under the state dir", () => {
  assert.equal(deviceStateDir({}), path.join(tmp, "state", "app"));
  assert.equal(deviceStateDir({ ALFRED_WORKBENCH_STATE: "/data/workbench-app" }), "/data/workbench-app");
  assert.equal(deviceStateDir({ ALFRED_WORKBENCH_STATE: "  " }), path.join(tmp, "state", "app"));
});

test("a device's APNs registration is stored on its record and replaces an earlier one", () => {
  const dir = freshDir();
  const store = new DeviceStore(dir);
  const phone = store.createDevice("iPhone");
  const first = { token: "a".repeat(64), environment: "development" } as const;
  const second = { token: "b".repeat(64), environment: "production" } as const;
  assert.equal(store.setPush(phone.id, first), true);
  assert.equal(store.setPush(phone.id, second), true);
  assert.deepEqual(store.list().find((d) => d.id === phone.id)?.push, second);
  assert.equal(store.authenticate(phone.token)?.id, phone.id, "the token still works");
  const stored = JSON.parse(fs.readFileSync(path.join(dir, "devices.json"), "utf8")) as { devices: Record<string, unknown>[] };
  assert.deepEqual(stored.devices[0]?.push, second);
});

test("a registration is refused for an unknown or revoked device", () => {
  const store = new DeviceStore(freshDir());
  const phone = store.createDevice("iPhone");
  const gone = store.createDevice("iPad");
  store.revokeDevice(gone.id);
  const registration = { token: "c".repeat(64), environment: "development" } as const;
  assert.equal(store.setPush("zzzzz9", registration), false);
  assert.equal(store.setPush(gone.id, registration), false);
  assert.equal(store.list().find((d) => d.id === gone.id)?.push, undefined);
  assert.equal(store.setPush(phone.id, registration), true);
});

test("forgetPush drops a registration only while it still holds the token it was given", () => {
  const store = new DeviceStore(freshDir());
  const phone = store.createDevice("iPhone");
  store.setPush(phone.id, { token: "d".repeat(64), environment: "development" });
  store.setPush(phone.id, { token: "e".repeat(64), environment: "development" }); // a newer one
  store.forgetPush(phone.id, "d".repeat(64));
  assert.equal(store.list().find((d) => d.id === phone.id)?.push?.token, "e".repeat(64), "the newer one is kept");
  store.forgetPush(phone.id, "e".repeat(64));
  assert.equal(store.list().find((d) => d.id === phone.id)?.push, undefined);
  assert.equal(store.authenticate(phone.token)?.id, phone.id, "the device itself is kept");
});
