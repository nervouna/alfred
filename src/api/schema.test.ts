import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import type { ZodType } from "zod";

import type { RunRecord } from "../runs.ts";
import {
  AnnotationSchema,
  DocumentDetailSchema,
  DocumentListSchema,
  DocumentResultSchema,
  DocumentVersionSchema,
  ErrorResponseSchema,
  EventSchema,
  FileRefSchema,
  LiveEventSchema,
  MAX_MESSAGE_FILES,
  MessageSchema,
  PairingSchema,
  PushRegistrationSchema,
  RevisionAcceptedSchema,
  RunDetailSchema,
  RunListSchema,
  RunSchema,
  TaskDetailSchema,
  TaskListSchema,
  TaskResultSchema,
  TaskSchema,
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
  "document-detail": DocumentDetailSchema,
  "document-list": DocumentListSchema,
  "document-result": DocumentResultSchema,
  "revision-accepted": RevisionAcceptedSchema,
  "run-detail": RunDetailSchema,
  "run-list": RunListSchema,
  "task-detail": TaskDetailSchema,
  "task-list": TaskListSchema,
  "task-result": TaskResultSchema,
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

test("a pairing's server is an https origin, or an http origin on 127.0.0.1 or localhost with any port", () => {
  const pairing = JSON.parse(readFixture("pairing", "pairing.json")) as Record<string, unknown>;
  const accepted = [
    "https://alfred.example.com",
    "https://alfred.example.com:8443",
    "http://127.0.0.1:18900",
    "http://127.0.0.1",
    "http://localhost:8787",
    "http://localhost",
  ];
  const refused = [
    "http://192.168.1.2:8787",
    "http://alfred.example.com",
    "http://127.0.0.2:8787",
    "http://0.0.0.0:8787",
    "http://localhost.example.com:8787",
    "http://[::1]:8787",
    "https://alfred.example.com/",
    "http://127.0.0.1:18900/workbench",
    "http://user@127.0.0.1:18900",
    "ws://127.0.0.1:18900",
  ];
  for (const server of accepted) assert.equal(PairingSchema.safeParse({ ...pairing, server }).success, true, server);
  for (const server of refused) assert.equal(PairingSchema.safeParse({ ...pairing, server }).success, false, server);
});

const QUESTION = {
  question: "报告用哪种格式？",
  header: "报告格式",
  options: [
    { label: "短表格", description: "一张对比表" },
    { label: "长文章", description: "完整分析" },
  ],
  multiSelect: false,
};
const asked = (data: Record<string, unknown>) => ({ id: 1, at: "2026-10-25T08:36:00.000Z", type: "question.asked", data });
const answered = (data: Record<string, unknown>) => ({ id: 2, at: "2026-10-25T08:36:42.000Z", type: "question.answered", data });

test("question.asked has an id of 1 to 64 safe characters and one to four questions of two to four options", () => {
  const ok = (data: Record<string, unknown>) => EventSchema.safeParse(asked(data)).success;
  const base = { id: "q-1", runId: "k7m2qa", questions: [QUESTION] };
  assert.equal(ok(base), true);
  assert.equal(ok({ ...base, id: "a".repeat(64) }), true, "64 characters");
  for (const id of ["", "a".repeat(65), "has space", "问题", "q.1"]) assert.equal(ok({ ...base, id }), false, `id ${id}`);
  assert.equal(ok({ ...base, runId: "K7M2QA" }), false, "a malformed run id");

  assert.equal(ok({ ...base, questions: [] }), false, "no questions");
  assert.equal(ok({ ...base, questions: Array.from({ length: 4 }, () => QUESTION) }), true, "four questions");
  assert.equal(ok({ ...base, questions: Array.from({ length: 5 }, () => QUESTION) }), false, "five questions");

  const option = (n: number) => ({ label: `选项 ${n}`, description: `说明 ${n}` });
  const withOptions = (n: number) => ({ ...base, questions: [{ ...QUESTION, options: Array.from({ length: n }, (_, i) => option(i)) }] });
  assert.equal(ok(withOptions(1)), false, "one option");
  assert.equal(ok(withOptions(2)), true);
  assert.equal(ok(withOptions(4)), true);
  assert.equal(ok(withOptions(5)), false, "five options");

  for (const key of ["question", "header", "options", "multiSelect"]) {
    const { [key]: _gone, ...rest } = QUESTION as Record<string, unknown>;
    assert.equal(ok({ ...base, questions: [rest] }), false, `a question without ${key}`);
  }
  assert.equal(ok({ ...base, questions: [{ ...QUESTION, options: [{ label: "", description: "x" }, option(1)] }] }), false, "an empty label");
});

test("question.asked keeps what it knows and drops what it does not, a preview among it", () => {
  const withPreview = { ...QUESTION, options: QUESTION.options.map((o) => ({ ...o, preview: "<b>x</b>" })), extra: 1 };
  const parsed = EventSchema.parse(asked({ id: "q-1", runId: "k7m2qa", questions: [withPreview], note: "x" }));
  assert.deepEqual(parsed.data, { id: "q-1", runId: "k7m2qa", questions: [QUESTION] });
});

test("question.answered carries answers by question text, and a cancelled one carries none", () => {
  const ok = (data: Record<string, unknown>) => EventSchema.safeParse(answered(data)).success;
  const base = { id: "q-1", runId: "k7m2qa", answers: { "报告用哪种格式？": "短表格" } };
  assert.equal(ok(base), true);
  assert.equal(ok({ ...base, cancelled: false }), true);
  assert.equal(ok({ ...base, answers: {}, cancelled: true }), true);
  assert.equal(ok({ ...base, cancelled: true }), false, "a cancelled question has no answers");
  assert.equal(ok({ ...base, answers: { "报告用哪种格式？": 1 } }), false, "an answer is text");
  assert.equal(ok({ ...base, answers: { "报告用哪种格式？": "" } }), false, "an answer is not empty");
  assert.equal(ok({ ...base, id: "has space" }), false);
  assert.equal(ok({ id: "q-1", runId: "k7m2qa" }), false, "no answers key");
});

test("question.answer names a question and gives each answer 1 to 2000 characters, a character being a code point", () => {
  const answer = (over: Record<string, unknown>) => parseCommand({ type: "question.answer", questionId: "q-1", answers: { 问题: "短表格" }, ...over });
  assert.equal(answer({}).ok, true);
  assert.equal(answer({ answers: { 问题: "a".repeat(2000) } }).ok, true, "2000 characters");
  assert.equal(answer({ answers: { 问题: "a".repeat(2001) } }).ok, false, "2001 characters");
  assert.equal(answer({ answers: { 问题: "😀".repeat(2000) } }).ok, true, "2000 emoji are 2000 characters");
  assert.equal(answer({ answers: { 问题: "😀".repeat(2001) } }).ok, false);
  assert.equal(answer({ answers: { 问题: "" } }).ok, false, "an empty answer");
  assert.equal(answer({ answers: {} }).ok, false, "no answers");
  assert.equal(answer({ answers: { 一: "a", 二: "b", 三: "c", 四: "d" } }).ok, true, "one answer per question");
  assert.equal(answer({ answers: { 问题: 1 } }).ok, false, "an answer is text");
  assert.equal(answer({ answers: ["短表格"] }).ok, false, "answers is a map");
  assert.equal(answer({ questionId: "a".repeat(65) }).ok, false);
  assert.equal(answer({ questionId: "has space" }).ok, false);
  assert.equal(answer({ cancelled: true }).ok, false, "an unknown key");
  assert.deepEqual(answer({ questionId: "q 1" }), { ok: false, error: "questionId: must be 1-64 letters, digits, _ or -" });
});

const taskCreate = (schedule: unknown) => parseCommand({ type: "task.create", title: "每日 VPS 价格", brief: "查定价页。", schedule });

test("a task's time of day is HH:MM from 00:00 to 23:59, in daily and weekly schedules alike", () => {
  const daily = (time: string) => taskCreate({ kind: "daily", time }).ok;
  assert.equal(daily("00:00"), true);
  assert.equal(daily("23:59"), true);
  for (const time of ["24:00", "9:00", "12:60", "12:5", "12:00:00", "1200", "12-00"]) {
    assert.equal(daily(time), false, time);
  }
  const weekly = (time: string) => taskCreate({ kind: "weekly", days: [1], time }).ok;
  assert.equal(weekly("23:59"), true);
  assert.equal(weekly("24:00"), false, "weekly uses the same time");
});

test("a weekly task's weekdays are 1 to 7 (Monday is 1) in strictly ascending order, and an interval is 1 to 168 hours", () => {
  const weekly = (days: unknown) => taskCreate({ kind: "weekly", days, time: "08:30" }).ok;
  assert.equal(weekly([1]), true);
  assert.equal(weekly([1, 3, 7]), true);
  for (const days of [[], [0], [8], [3, 1], [1, 1], [1.5]]) assert.equal(weekly(days), false, JSON.stringify(days));
  const interval = (hours: unknown) => taskCreate({ kind: "interval", hours }).ok;
  assert.equal(interval(1), true);
  assert.equal(interval(168), true);
  for (const hours of [0, 169, 1.5]) assert.equal(interval(hours), false, String(hours));
});

test("a task.update needs a change besides its taskId", () => {
  assert.equal(parseCommand({ type: "task.update", taskId: "p3r8vx" }).ok, false, "no change");
  assert.equal(parseCommand({ type: "task.update", taskId: "p3r8vx", status: "paused" }).ok, true);
  assert.equal(parseCommand({ type: "task.update", taskId: "p3r8vx", schedule: { kind: "interval", hours: 6 } }).ok, true);
});

test("a task command's schedule rejects unknown keys, and a task ignores them", () => {
  assert.equal(taskCreate({ kind: "daily", time: "09:00", day: 1 }).ok, false, "a command");
  const task = JSON.parse(readFixture("responses", "task-result.json")).task as Record<string, unknown>;
  const withExtra = { ...task, schedule: { ...(task.schedule as object), day: 1 } };
  const parsed = TaskSchema.safeParse(withExtra);
  assert.equal(parsed.success, true, "a task");
  assert.deepEqual(parsed.data?.schedule, { kind: "daily", time: "09:00" });
});

// --- Documents ----------------------------------------------------------------

const VERSION = "248e89ba3aad47311d9cf0d57bf83b038a724f1f";
const WHOLE_COMMENT = { target: { kind: "document" }, comment: "开头加一段结论。" };
const revise = (over: Record<string, unknown>) => parseCommand({ type: "document.revise", documentId: "r4f7ma", version: VERSION, annotations: [WHOLE_COMMENT], ...over });
const documentFixture = (dir: string, name: string): Record<string, unknown> => JSON.parse(readFixture(dir, name));

test("a document version is 40 lowercase hex characters, and a document id is six characters of the run id alphabet", () => {
  assert.equal(revise({ version: "a".repeat(40) }).ok, true, "40 characters");
  for (const bad of ["a".repeat(39), "a".repeat(41), VERSION.toUpperCase(), "g".repeat(40), ""]) {
    assert.deepEqual(revise({ version: bad }), { ok: false, error: "version: must be a 40-character commit id" }, bad);
  }
  assert.deepEqual(revise({ documentId: "r4f7m0" }), { ok: false, error: "documentId: must be a six-character document id" });
});

test("a file a delivery registered names its document and version together, or neither", () => {
  const path = { path: "reports/vps.md" };
  assert.equal(FileRefSchema.safeParse(path).success, true, "neither");
  assert.equal(FileRefSchema.safeParse({ ...path, documentId: "r4f7ma", version: VERSION }).success, true, "both");
  assert.equal(FileRefSchema.safeParse({ ...path, documentId: "r4f7ma" }).success, false, "a document without a version");
  assert.equal(FileRefSchema.safeParse({ ...path, version: VERSION }).success, false, "a version without a document");
});

test("an undone version names the revision it undoes and has no run; any other version has no undoes", () => {
  const at = "2026-10-26T06:20:05.330Z";
  const ok = (value: Record<string, unknown>) => DocumentVersionSchema.safeParse({ version: VERSION, at, ...value }).success;
  assert.equal(ok({ reason: "revised", runId: "x4n7mj" }), true);
  assert.equal(ok({ reason: "undone", undoes: "x4n7mj" }), true);
  assert.equal(ok({ reason: "undone" }), false, "an undone version without undoes");
  assert.equal(ok({ reason: "undone", undoes: "x4n7mj", runId: "m2v8pd" }), false, "an undone version with a run");
  assert.equal(ok({ reason: "delivered", runId: "k7m2qa", undoes: "x4n7mj" }), false, "a delivered version with undoes");
  assert.equal(ok({ reason: "reverted", runId: "k7m2qa" }), false, "a reason outside the four");
});

test("a resolved annotation has a reply, a returned one has a reason, and a submitted one has neither", () => {
  const annotation = documentFixture("events", "annotation-updated-resolved.json").data as Record<string, unknown>;
  const { reply: _reply, ...noReply } = annotation;
  assert.equal(AnnotationSchema.safeParse(annotation).success, true);
  assert.equal(AnnotationSchema.safeParse(noReply).success, false, "resolved without a reply");
  assert.equal(AnnotationSchema.safeParse({ ...annotation, reply: "x".repeat(4001) }).success, false, "a reply over 4000 characters");
  assert.equal(AnnotationSchema.safeParse({ ...annotation, reply: "x".repeat(4000) }).success, true, "4000 characters");

  const submitted = documentFixture("events", "annotation-updated-submitted.json").data as Record<string, unknown>;
  assert.equal(AnnotationSchema.safeParse(submitted).success, true);
  assert.equal(AnnotationSchema.safeParse({ ...submitted, reply: "已处理。" }).success, false, "submitted with a reply");
  assert.equal(AnnotationSchema.safeParse({ ...submitted, returnReason: "failed" }).success, false, "submitted with a return reason");

  const unanswered = documentFixture("events", "annotation-updated-returned-unanswered.json").data as Record<string, unknown>;
  const { returnReason: _reason, ...noReason } = unanswered;
  assert.equal(AnnotationSchema.safeParse(unanswered).success, true);
  assert.equal(AnnotationSchema.safeParse(noReason).success, false, "returned without a reason");
});

test("a passage's quote is 1 to 2000 characters and not blank, and its prefix and suffix are at most 200", () => {
  const passage = (over: Record<string, unknown>) => revise({ annotations: [{ target: { kind: "passage", quote: "价格", prefix: "", suffix: "", ...over }, comment: "核对" }] }).ok;
  assert.equal(passage({ quote: "x".repeat(2000) }), true, "2000 characters");
  assert.equal(passage({ quote: "x".repeat(2001) }), false);
  assert.equal(passage({ quote: "   " }), false, "blank");
  assert.equal(passage({ prefix: "x".repeat(200), suffix: "x".repeat(200) }), true, "200 characters each side");
  assert.equal(passage({ prefix: "x".repeat(201) }), false);
  assert.equal(passage({ suffix: "x".repeat(201) }), false);
  assert.equal(passage({ quote: "😀".repeat(2000) }), true, "a character is a code point");
});

test("a comment is 1 to 2000 characters and not blank, and a revision carries 1 to 50 annotations", () => {
  const comment = (text: string) => revise({ annotations: [{ target: { kind: "document" }, comment: text }] }).ok;
  assert.equal(comment("x".repeat(2000)), true);
  assert.equal(comment("x".repeat(2001)), false);
  assert.equal(comment("  "), false);
  const batch = (n: number) => revise({ annotations: Array.from({ length: n }, () => WHOLE_COMMENT) }).ok;
  assert.equal(batch(1), true);
  assert.equal(batch(50), true);
  assert.equal(batch(51), false);
  assert.equal(batch(0), false);
});

test("a document title is 1 to 200 characters and not blank, and a document's kind is one of six", () => {
  const document = documentFixture("responses", "document-result.json").document as Record<string, unknown>;
  const ok = (value: Record<string, unknown>) => DocumentResultSchema.safeParse({ document: { ...document, ...value } }).success;
  assert.equal(ok({ title: "x".repeat(200) }), true);
  assert.equal(ok({ title: "x".repeat(201) }), false);
  assert.equal(ok({ title: "" }), false);
  assert.equal(ok({ title: "  " }), false, "blank");
  for (const kind of ["markdown", "text", "html", "pdf", "image", "other"]) assert.equal(ok({ kind }), true, kind);
  assert.equal(ok({ kind: "spreadsheet" }), false);
});

test("a document command's targets reject unknown keys, and a target of another kind does not parse", () => {
  const passage = { kind: "passage", quote: "价格", prefix: "", suffix: "" };
  assert.equal(revise({ annotations: [{ target: { ...passage, page: 1 }, comment: "x" }] }).ok, false, "an extra key");
  assert.equal(revise({ annotations: [{ target: { kind: "page", page: 1 }, comment: "x" }] }).ok, false, "a page target");
  assert.equal(revise({ annotations: [{ target: passage, comment: "x" }] }).ok, true);
  assert.equal(parseCommand({ type: "document.undo", documentId: "r4f7ma", runId: "x4n7mj" }).ok, true);
  assert.equal(parseCommand({ type: "document.undo", documentId: "r4f7ma" }).ok, false, "no run");
});

test("a revision run names its document, and a document's versions have their reasons", () => {
  const run = documentFixture("events", "run-updated-revision.json").data as Record<string, unknown>;
  assert.equal(RunSchema.safeParse(run).success, true);
  assert.equal(RunSchema.parse(run).documentId, "r4f7ma");
  assert.equal(RunSchema.safeParse({ ...run, documentId: "R4F7MA" }).success, false, "a malformed document id");
});
