import assert from "node:assert/strict";
import { test } from "node:test";

import { drain } from "./bot.ts";

const pendingTimers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

test("drain returns once the queues settle and leaves no timer behind", async () => {
  const before = pendingTimers();
  const started = Date.now();
  await drain([Promise.resolve(), Promise.reject(new Error("handler failed"))], 60_000);
  assert.ok(Date.now() - started < 1_000);
  assert.equal(pendingTimers(), before);
});

test("drain stops waiting for a queue that never settles", async () => {
  const started = Date.now();
  await drain([new Promise(() => {})], 50);
  assert.ok(Date.now() - started >= 40);
});
