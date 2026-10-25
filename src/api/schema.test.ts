import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import type { RunRecord } from "../runs.ts";
import { EventSchema, MessageSchema, RunSchema, parseCommand } from "./schema.ts";

const FIXTURES = new URL("../../fixtures/api/", import.meta.url);

function fixtureNames(dir: string): string[] {
  return fs
    .readdirSync(new URL(`${dir}/`, FIXTURES))
    .filter((name) => name.endsWith(".json"))
    .sort();
}

function readFixture(dir: string, name: string): string {
  return fs.readFileSync(new URL(`${dir}/${name}`, FIXTURES), "utf8");
}

test("every event fixture parses as an Event and re-serialises to the same JSON", () => {
  const names = fixtureNames("events");
  assert.ok(names.length >= 8, "at least eight event fixtures");
  for (const name of names) {
    const text = readFixture("events", name);
    const parsed = EventSchema.safeParse(JSON.parse(text));
    assert.ok(parsed.success, `${name} does not parse`);
    assert.equal(`${JSON.stringify(parsed.data, null, 2)}\n`, text, `${name} is not in canonical form`);
  }
});

test("every command fixture is accepted and every invalid command is rejected", () => {
  const valid = fixtureNames("commands");
  assert.ok(valid.length >= 2, "one command fixture per command type");
  for (const name of valid) {
    const result = parseCommand(JSON.parse(readFixture("commands", name)));
    assert.ok(result.ok, `${name}: ${result.ok ? "" : result.error}`);
  }
  const invalid = fixtureNames("invalid-commands");
  assert.ok(invalid.length >= 5, "at least five invalid commands");
  for (const name of invalid) {
    assert.equal(parseCommand(JSON.parse(readFixture("invalid-commands", name))).ok, false, name);
  }
});

test("an unknown command type is named in the error", () => {
  assert.deepEqual(parseCommand({ type: "task.delete", id: "k7m2qa" }), {
    ok: false,
    error: "unknown command task.delete",
  });
});

test("message text is at most 20000 characters, and a character is a code point", () => {
  const send = (text: string) => parseCommand({ type: "message.send", clientId: "c-1", text });
  assert.equal(send("a".repeat(20_000)).ok, true);
  assert.equal(send("a".repeat(20_001)).ok, false);
  assert.equal(send("😀".repeat(20_000)).ok, true, "20000 emoji are 20000 characters");
  assert.equal(send("😀".repeat(20_001)).ok, false);
});

test("a full run record parses to a Run without its other fields", () => {
  const record: RunRecord = {
    id: "h6w4tz",
    kind: "subagent",
    parentRunId: "k7m2qa",
    title: "核对供应商 A 的带宽",
    status: "failed",
    model: "claude-sonnet-5-5",
    sessionId: "s-42",
    role: "reviewer",
    agentId: "agent-1",
    costEstimated: true,
    startedAt: "2026-10-25T08:30:05.000Z",
    endedAt: "2026-10-25T08:31:12.418Z",
    costUsd: 0.0412,
    modelCostUsd: { "claude-sonnet-5-5": 0.0412 },
    toolCalls: 3,
    files: [{ path: "reports/vps.md", tool: "Edit" }],
    undelivered: [{ kind: "reply", at: "2026-10-25T08:31:12.000Z", error: "sendMessage failed: ret=-2" }],
    error: "WebFetch: 403 Forbidden",
  };
  assert.deepEqual(RunSchema.parse(record), {
    id: "h6w4tz",
    kind: "subagent",
    parentRunId: "k7m2qa",
    title: "核对供应商 A 的带宽",
    status: "failed",
    model: "claude-sonnet-5-5",
    startedAt: "2026-10-25T08:30:05.000Z",
    endedAt: "2026-10-25T08:31:12.418Z",
    costUsd: 0.0412,
    files: [{ path: "reports/vps.md", tool: "Edit" }],
    error: "WebFetch: 403 Forbidden",
  });
});

test("every future fixture has a numeric id, a string at and a string type", () => {
  const names = fixtureNames("future");
  assert.ok(names.length >= 2, "an unknown event type and an event with an extra field");
  for (const name of names) {
    const event = JSON.parse(readFixture("future", name)) as Record<string, unknown>;
    assert.equal(typeof event.id, "number", `${name}: id`);
    assert.equal(typeof event.at, "string", `${name}: at`);
    assert.equal(typeof event.type, "string", `${name}: type`);
  }
});

test("a known event with an extra field parses without it; an unknown event type does not parse", () => {
  const extra = EventSchema.safeParse(JSON.parse(readFixture("future", "event-extra-field.json")));
  assert.ok(extra.success, "the extra field is ignored");
  assert.equal(Object.hasOwn(extra.data.data, "editedAt"), false);
  assert.equal(EventSchema.safeParse(JSON.parse(readFixture("future", "event-unknown-type.json"))).success, false);
});

test("a message needs text or files, its paths stay in the workspace, and its timestamps end in Z", () => {
  const message = { id: "m1001", channel: "app", direction: "in", text: "", files: [], at: "2026-10-25T08:30:00.000Z" };
  assert.equal(MessageSchema.safeParse(message).success, false, "empty text and no files");
  assert.equal(MessageSchema.safeParse({ ...message, files: [{ path: "inbox/a.jpg" }] }).success, true);
  assert.equal(MessageSchema.safeParse({ ...message, text: "hi", at: "2026-10-25T16:30:00+08:00" }).success, false);
  for (const path of ["/etc/passwd", "../secret.md", "reports/../../x", ""]) {
    assert.equal(MessageSchema.safeParse({ ...message, text: "hi", files: [{ path }] }).success, false, path);
  }
  assert.equal(MessageSchema.safeParse({ ...message, text: "hi", files: [{ path: "reports/a..b.md" }] }).success, true);
});
