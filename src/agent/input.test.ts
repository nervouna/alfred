import assert from "node:assert/strict";
import { test } from "node:test";

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { TaskInput } from "./input.ts";

function text(m: SDKUserMessage): unknown {
  return m.message.content;
}

/** Resolves with the next message, or undefined if the iteration ends; null if nothing arrives within a tick. */
async function nextOrNull(it: AsyncIterator<SDKUserMessage>): Promise<SDKUserMessage | undefined | null> {
  const tick = new Promise<null>((resolve) => setImmediate(() => resolve(null)));
  return Promise.race([it.next().then((r) => (r.done ? undefined : r.value)), tick]);
}

test("delivers the prompt, then follow-ups as they are pushed", async () => {
  const input = new TaskInput("task");
  const it = input[Symbol.asyncIterator]();
  const first = await it.next();
  assert.equal(text(first.value as SDKUserMessage), "task");
  assert.ok((first.value as SDKUserMessage).uuid);

  const waiting = it.next();
  assert.equal(input.push("only look at Y"), true);
  const second = await waiting;
  assert.equal(text(second.value as SDKUserMessage), "only look at Y");
  assert.equal(input.pending, 2);
  assert.equal(input.followUps, 1);
});

test("closes once every message is answered, and ends the iteration", async () => {
  const input = new TaskInput("task");
  const it = input[Symbol.asyncIterator]();
  const first = (await it.next()).value as SDKUserMessage;
  const waiting = it.next();
  assert.equal(input.settle([first.uuid as string]), true);
  assert.equal(input.closed, true);
  assert.equal((await waiting).done, true);
  assert.equal(input.push("late"), false);
});

test("a follow-up pushed before the result keeps the input open until its own result", async () => {
  const input = new TaskInput("task");
  const it = input[Symbol.asyncIterator]();
  const first = (await it.next()).value as SDKUserMessage;
  input.push("steer");
  const second = (await it.next()).value as SDKUserMessage;

  assert.equal(input.settle([first.uuid as string]), false);
  assert.equal(input.pending, 1);
  assert.equal(input.push("another"), true);
  assert.equal(input.settle([second.uuid as string]), false);
  const third = (await it.next()).value as SDKUserMessage;
  assert.equal(input.settle([third.uuid as string]), true);
});

test("a result can answer several messages folded into one turn", async () => {
  const input = new TaskInput("task");
  const it = input[Symbol.asyncIterator]();
  const first = (await it.next()).value as SDKUserMessage;
  input.push("steer");
  const second = (await it.next()).value as SDKUserMessage;
  assert.equal(input.settle([first.uuid as string, second.uuid as string]), true);
  assert.equal(input.pending, 0);
});

test("a result without uuids answers the oldest delivered message", async () => {
  const input = new TaskInput("task");
  const it = input[Symbol.asyncIterator]();
  await it.next();
  input.push("steer"); // pushed, not yet delivered
  assert.equal(input.settle([]), false);
  assert.equal(input.followUps, 1);
  assert.equal(input.settle([]), false, "an undelivered message is never settled by a uuid-less result");
  await it.next();
  assert.equal(input.settle([]), true);
});

test("unknown uuids leave pending messages alone", async () => {
  const input = new TaskInput("task");
  await input[Symbol.asyncIterator]().next();
  assert.equal(input.settle(["not-ours"]), false);
  assert.equal(input.pending, 1);
});

test("close refuses pushes, ends a waiting iteration and keeps unanswered messages counted", async () => {
  const input = new TaskInput("task");
  const it = input[Symbol.asyncIterator]();
  await it.next();
  input.push("steer");
  await it.next();
  const waiting = it.next();
  input.close();
  assert.equal((await waiting).done, true);
  assert.equal(input.push("late"), false);
  assert.equal(input.pending, 2);
  assert.equal(input.followUps, 1);
  assert.equal(await nextOrNull(input[Symbol.asyncIterator]()), undefined);
});

test("rewind ends the current iteration and redelivers unanswered messages to the next", async () => {
  const input = new TaskInput("task");
  const old = input[Symbol.asyncIterator]();
  await old.next();
  input.push("steer");
  await old.next();
  const waiting = old.next();
  input.rewind();
  assert.equal((await waiting).done, true);

  const it = input[Symbol.asyncIterator]();
  const a = (await it.next()).value as SDKUserMessage;
  const b = (await it.next()).value as SDKUserMessage;
  assert.deepEqual([text(a), text(b)], ["task", "steer"]);
  assert.equal(await nextOrNull(it), null, "waits for more input");
  assert.equal(input.settle([a.uuid as string, b.uuid as string]), true);
});
