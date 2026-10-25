import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import type { ZodType } from "zod";

import type { RunRecord } from "../runs.ts";
import {
  ErrorResponseSchema,
  EventSchema,
  LiveEventSchema,
  MAX_MESSAGE_FILES,
  MessageSchema,
  PairingSchema,
  PushRegistrationSchema,
  RunDetailSchema,
  RunListSchema,
  RunSchema,
  UploadResultSchema,
  parseCommand,
} from "./schema.ts";

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

// The schema a fixture named `<schema>-<case>.json` is checked against: the longest schema name it starts with.
const SCHEMAS_BY_NAME: Record<string, ZodType> = {
  error: ErrorResponseSchema,
  pairing: PairingSchema,
  "push-registration": PushRegistrationSchema,
  "run-detail": RunDetailSchema,
  "run-list": RunListSchema,
  "upload-result": UploadResultSchema,
};

function schemaNamed(name: string): ZodType {
  const base = name.replace(/\.json$/, "");
  const key = Object.keys(SCHEMAS_BY_NAME)
    .filter((candidate) => base === candidate || base.startsWith(`${candidate}-`))
    .sort((a, b) => b.length - a.length)[0];
  const schema = key === undefined ? undefined : SCHEMAS_BY_NAME[key];
  if (schema === undefined) throw new Error(`${name} names no schema`);
  return schema;
}

type ParseResult = { ok: true; value: unknown } | { ok: false; error: string };
type Parser = (name: string, json: unknown) => ParseResult;

function parseWith(schema: ZodType): Parser {
  return (_name, json) => {
    const result = schema.safeParse(json);
    if (result.success) return { ok: true, value: result.data };
    return { ok: false, error: JSON.stringify(result.error.issues) };
  };
}

// How each directory of valid fixtures is parsed. The parsed value must re-serialise to the file's exact text.
const VALID_FIXTURES: Record<string, Parser> = {
  commands: (_name, json) => {
    const result = parseCommand(json);
    return result.ok ? { ok: true, value: result.command } : { ok: false, error: result.error };
  },
  live: parseWith(LiveEventSchema),
  pairing: parseWith(PairingSchema),
  requests: parseWith(PushRegistrationSchema),
  responses: (name, json) => parseWith(schemaNamed(name))(name, json),
};

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

test("every command, live, response, request and pairing fixture parses and re-serialises to the same JSON", () => {
  assert.ok(fixtureNames("commands").length >= 2, "one command fixture per command type");
  for (const [dir, parse] of Object.entries(VALID_FIXTURES)) {
    const names = fixtureNames(dir);
    assert.ok(names.length > 0, `${dir} has fixtures`);
    for (const name of names) {
      const text = readFixture(dir, name);
      const result = parse(name, JSON.parse(text));
      if (!result.ok) throw new Error(`${dir}/${name} does not parse: ${result.error}`);
      assert.equal(`${JSON.stringify(result.value, null, 2)}\n`, text, `${dir}/${name} is not in canonical form`);
    }
  }
});

test("every invalid command is rejected", () => {
  const invalid = fixtureNames("invalid-commands");
  assert.ok(invalid.length >= 10, "at least ten invalid commands");
  for (const name of invalid) {
    assert.equal(parseCommand(JSON.parse(readFixture("invalid-commands", name))).ok, false, name);
  }
});

test("every file in invalid/ is rejected by the schema its name starts with", () => {
  const invalid = fixtureNames("invalid");
  assert.ok(invalid.length >= 6, "the pairing, push, upload and version cases");
  for (const name of invalid) {
    assert.equal(schemaNamed(name).safeParse(JSON.parse(readFixture("invalid", name))).success, false, name);
  }
});

test("a message.send takes one to ten files, and a live message delta has an opaque stream id and text", () => {
  const file = (n: number) => ({ path: `inbox/2026-10-25/IMG_${n}.jpg` });
  const send = (files: unknown[]) => parseCommand({ type: "message.send", clientId: "c-1", text: "hi", files });
  assert.equal(send(Array.from({ length: MAX_MESSAGE_FILES }, (_, i) => file(i))).ok, true, "ten files");
  assert.equal(send([]).ok, false, "no files");
  assert.equal(send([{ path: "reports/vps.md" }]).ok, false, "a file outside inbox/");

  const delta = {
    at: "2026-10-25T08:32:01.120Z",
    type: "message.delta",
    data: { runId: "k7m2qa", streamId: "k7m2qa.2", text: "我先查一下。" },
  };
  assert.equal(LiveEventSchema.safeParse(delta).success, true);
  const longest = { ...delta, data: { ...delta.data, streamId: "a".repeat(64) } };
  assert.equal(LiveEventSchema.safeParse(longest).success, true, "64 characters");
  for (const streamId of ["", "a".repeat(65), "has space", "流"]) {
    assert.equal(LiveEventSchema.safeParse({ ...delta, data: { ...delta.data, streamId } }).success, false, streamId);
  }
  assert.equal(LiveEventSchema.safeParse({ ...delta, data: { ...delta.data, text: "" } }).success, false, "empty text");
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

test("every future fixture has a string at and type, and a numeric id unless its name starts with live-", () => {
  const names = fixtureNames("future");
  assert.ok(names.length >= 3, "an unknown event type, an event with an extra field and a live event");
  for (const name of names) {
    const event = JSON.parse(readFixture("future", name)) as Record<string, unknown>;
    assert.equal(typeof event.at, "string", `${name}: at`);
    assert.equal(typeof event.type, "string", `${name}: type`);
    if (name.startsWith("live-")) {
      assert.equal(Object.hasOwn(event, "id"), false, `${name}: a live event has no id`);
    } else {
      assert.equal(typeof event.id, "number", `${name}: id`);
    }
  }
});

test("a known event with an extra field parses without it; an unknown event type does not parse", () => {
  const extra = EventSchema.safeParse(JSON.parse(readFixture("future", "event-extra-field.json")));
  assert.ok(extra.success, "the extra field is ignored");
  assert.equal(Object.hasOwn(extra.data.data, "editedAt"), false);
  assert.equal(EventSchema.safeParse(JSON.parse(readFixture("future", "event-unknown-type.json"))).success, false);
  const live = JSON.parse(readFixture("future", "live-event-unknown-type.json"));
  assert.equal(LiveEventSchema.safeParse(live).success, false, "an unknown live type");
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
