import assert from "node:assert/strict";
import { test } from "node:test";

import { PairingSchema } from "../api/schema.ts";
import { buildPairing, pairingSettings } from "./pairing.ts";

const ENV = {
  ALFRED_WORKBENCH_URL: "https://alfred.example.com",
  CF_ACCESS_SERVICE_CLIENT_ID: "test.access",
  CF_ACCESS_SERVICE_CLIENT_SECRET: "s3cret-value",
};
const DEVICE = { id: "k7m2qa", token: "A".repeat(43) };

test("the pairing built from the settings and a device validates as a Pairing", () => {
  const pairing = buildPairing(pairingSettings(ENV), DEVICE);
  assert.deepEqual(PairingSchema.parse(pairing), pairing);
  assert.deepEqual(pairing, {
    version: 1,
    server: "https://alfred.example.com",
    access: { clientId: "test.access", clientSecret: "s3cret-value" },
    device: DEVICE,
  });
});

test("a trailing slash on the URL is dropped, as for the links in WeChat replies", () => {
  assert.equal(pairingSettings({ ...ENV, ALFRED_WORKBENCH_URL: " https://alfred.example.com/ " }).server, "https://alfred.example.com");
});

test("a URL that is not an https origin is refused", () => {
  const refused = [
    "http://alfred.example.com",
    "alfred.example.com",
    "ftp://alfred.example.com",
    "https://alfred.example.com/workbench",
    "https://alfred.example.com?x=1",
    "https://alfred.example.com#top",
  ];
  for (const url of refused) {
    assert.throws(() => pairingSettings({ ...ENV, ALFRED_WORKBENCH_URL: url }), /ALFRED_WORKBENCH_URL.*https/, url);
  }
});

test("a missing variable is named", () => {
  for (const name of Object.keys(ENV)) {
    for (const value of [undefined, "", "  "]) {
      assert.throws(
        () => pairingSettings({ ...ENV, [name]: value }),
        (err: Error) => err.message.includes(name) && /not set/.test(err.message),
        `${name}=${JSON.stringify(value)}`,
      );
    }
  }
  assert.throws(
    () => pairingSettings({ ALFRED_WORKBENCH_URL: ENV.ALFRED_WORKBENCH_URL }),
    (err: Error) => err.message.includes("CF_ACCESS_SERVICE_CLIENT_ID") && err.message.includes("CF_ACCESS_SERVICE_CLIENT_SECRET") && !err.message.includes("ALFRED_WORKBENCH_URL"),
    "every missing variable is named, and only those",
  );
});

test("a client id that is not a Cloudflare Access client id is refused, naming the variable and not the secret", () => {
  assert.throws(() => pairingSettings({ ...ENV, CF_ACCESS_SERVICE_CLIENT_ID: "nope" }), /CF_ACCESS_SERVICE_CLIENT_ID.*\.access/);
  assert.throws(
    () => pairingSettings({ ...ENV, CF_ACCESS_SERVICE_CLIENT_ID: "nope", CF_ACCESS_SERVICE_CLIENT_SECRET: "x".repeat(300) }),
    (err: Error) => !err.message.includes("x".repeat(20)),
  );
});

test("a device token of the wrong shape is refused", () => {
  assert.throws(() => buildPairing(pairingSettings(ENV), { id: "k7m2qa", token: "short" }));
  assert.throws(() => buildPairing(pairingSettings(ENV), { id: "K7M2QA", token: DEVICE.token }));
});
