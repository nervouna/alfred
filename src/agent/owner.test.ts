// The owner's state is kept under one fixed key. A state file written before the app was the only channel
// holds it under another key; the first start moves it, so sessions, settings and history carry over.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { Outbound } from "../channels.ts";

// store.ts and config.ts read these at import time, so set them before loading the modules under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-owner-")));
const stateDir = path.join(tmp, "state");
const stateFile = path.join(stateDir, "agent-state.json");
Object.assign(process.env, {
  ALFRED_WORKSPACE: path.join(tmp, "workspace"),
  ALFRED_STATE_DIR: stateDir,
  ALFRED_ANTHROPIC_API_KEY: "sk-test",
  ALFRED_MEMORY_SCAN_MINUTES: "0",
  ALFRED_WORKBENCH: "",
  ALFRED_WORKBENCH_URL: "",
});

const { createAgentHandler } = await import("./handler.ts");
const { OWNER } = await import("./state.ts");
const { EventLog } = await import("../events.ts");
const { localDate } = await import("../files.ts");

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups) await cleanup();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The id a record was kept under before the app was the only channel: some chat user id. */
const OLD_KEY = "o9cq80legacy-user@im.example";

const OLD_RECORD = {
  sessionId: "5f2c9a1e-0000-4000-8000-000000000001",
  sessionStartedAt: "2026-10-24T08:00:00.000Z",
  model: "opus",
  sessionCostUsd: 1.5,
  totalCostUsd: 12.25,
  lastRunAt: "2026-10-25T09:00:00.000Z",
  previousSession: { sessionId: "3b7d44aa-0000-4000-8000-000000000002", sessionCostUsd: 0.5 },
  undeliveredRuns: [{ id: "k7m2qa", title: "旧的报告" }],
  lostRuns: [{ id: "p3x9za", title: "没做完的调研" }],
  spendDay: localDate(),
  spendDayUsd: 3.5,
};

function writeState(entries: object): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(entries));
}

const readState = () => JSON.parse(fs.readFileSync(stateFile, "utf8")) as Record<string, Record<string, unknown>>;

let logs = 0;

/** A handler on the default state file, with an app channel that records what it says. */
function start() {
  const texts: string[] = [];
  const out: Outbound = {
    channel: "app",
    async text(text) {
      texts.push(text);
    },
    async file() {
      return "file";
    },
  };
  const handler = createAgentHandler({ out, events: new EventLog(path.join(tmp, `events-${logs++}`, "events.jsonl")) });
  cleanups.push(() => handler.shutdown());
  return { handler, texts };
}

test("a state file written under the old key carries over to the owner key at the first start", async () => {
  writeState({ [OLD_KEY]: OLD_RECORD });
  const { handler, texts } = start();

  const state = readState();
  assert.deepEqual(Object.keys(state), [OWNER], "the record moved, it was not copied");
  const { undeliveredRuns: _undelivered, ...kept } = OLD_RECORD;
  assert.deepEqual(state[OWNER], kept, "every setting is as it was; the state of the retired undelivered note is dropped");

  // What the owner sees: the model, the session and the spend are the old ones, and the lost runs are named once.
  await handler.submit({ text: "/status", files: [] });
  assert.match(texts[0] ?? "", /^Alfred 重启时中断了 1 个运行：「没做完的调研」（p3x9za）/);
  assert.doesNotMatch(texts.join("\n"), /旧的报告/, "no note about undelivered results");
  const status = texts[1] ?? "";
  assert.match(status, /^模型：opus/);
  assert.match(status, /会话：5f2c9a1e，.*本会话花费 \$1\.50/);
  assert.match(status, /上一个会话：3b7d44aa/);
  assert.match(status, /累计花费：\$12\.25，今天 \$3\.50/);
  assert.equal(readState()[OWNER]?.lostRuns, undefined, "the note was said once");
});

test("once moved, the owner key is read as it is; a second start moves nothing and says nothing", async () => {
  const before = readState();
  const { handler, texts } = start();
  assert.deepEqual(readState(), before);

  await handler.submit({ text: "/model", files: [] });
  assert.match(texts[0] ?? "", /^当前模型：opus/);
  assert.equal(texts.length, 1, "no note");
});

test("with no state file, the owner starts with the defaults", async () => {
  fs.rmSync(stateFile, { force: true });
  const { handler, texts } = start();
  await handler.submit({ text: "/status", files: [] });
  assert.match(texts[0] ?? "", /^模型：sonnet/);
  assert.match(texts[0] ?? "", /会话：新会话/);
});

test("a record under the owner key is never replaced by one under another key", async () => {
  writeState({ [OWNER]: { ...OLD_RECORD, model: "haiku" }, [OLD_KEY]: OLD_RECORD });
  const { handler, texts } = start();

  await handler.submit({ text: "/model", files: [] });
  assert.match(texts.at(-1) ?? "", /^当前模型：haiku/);
  assert.deepEqual(Object.keys(readState()).sort(), [OLD_KEY, OWNER].sort(), "the other record is left alone");
});

test("with several old records, the one used last is the owner's", async () => {
  writeState({
    "a-user@im.example": { ...OLD_RECORD, model: "haiku", lastRunAt: "2026-09-01T00:00:00.000Z", lostRuns: undefined },
    "b-user@im.example": { ...OLD_RECORD, model: "opus", lastRunAt: "2026-10-25T09:00:00.000Z", lostRuns: undefined },
    "c-user@im.example": { ...OLD_RECORD, model: "haiku", lastRunAt: "2026-10-01T00:00:00.000Z", lostRuns: undefined },
  });
  const { handler, texts } = start();

  await handler.submit({ text: "/model", files: [] });
  assert.match(texts[0] ?? "", /^当前模型：opus/);
  assert.deepEqual(Object.keys(readState()).sort(), ["a-user@im.example", "c-user@im.example", OWNER].sort(), "only the chosen record moved");
});
