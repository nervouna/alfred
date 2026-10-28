import assert from "node:assert/strict";
import crypto from "node:crypto";
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
  IdeaAcceptedSchema,
  IdeaGenerationAcceptedSchema,
  IdeaGenerationSchema,
  IdeaListSchema,
  IdeaResultSchema,
  IdeaSchema,
  LiveEventSchema,
  MAX_COMPACT_TOKENS,
  MAX_DAILY_BUDGET_USD,
  MAX_IDEA_NOTE_CHARS,
  MAX_IDEA_WHY_CHARS,
  MAX_MEMORY_SCAN_BUDGET_USD,
  MAX_MEMORY_SCAN_MINUTES,
  MAX_MESSAGE_FILES,
  MAX_NEW_IDEAS,
  MAX_RUN_BUDGET_USD,
  MAX_SESSION_IDLE_HOURS,
  MAX_TASK_BUDGET_USD,
  MIN_COMPACT_TOKENS,
  MemoryKindSchema,
  MemoryListSchema,
  MemoryResultSchema,
  MemorySchema,
  MessageSchema,
  PairingSchema,
  PushRegistrationSchema,
  RevisionAcceptedSchema,
  RulesSchema,
  RunDetailSchema,
  RunKindSchema,
  RunListSchema,
  RunSchema,
  SettingKeySchema,
  SettingsDetailSchema,
  SettingsResultSchema,
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
  "memory-list": MemoryListSchema,
  "memory-result": MemoryResultSchema,
  rules: RulesSchema,
  "run-detail": RunDetailSchema,
  "run-list": RunListSchema,
  "task-detail": TaskDetailSchema,
  "task-list": TaskListSchema,
  "task-result": TaskResultSchema,
  "upload-result": UploadResultSchema,
  "idea-result": IdeaResultSchema,
  "idea-accepted": IdeaAcceptedSchema,
  "idea-generation-accepted": IdeaGenerationAcceptedSchema,
  "idea-list": IdeaListSchema,
  "settings-result": SettingsResultSchema,
  "settings-detail": SettingsDetailSchema,
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

// --- Ideas --------------------------------------------------------------------

/** The data of an event fixture: the idea of an idea.updated one, the run of a run.updated one. */
const eventData = (name: string): Record<string, unknown> => (JSON.parse(readFixture("events", name)) as { data: Record<string, unknown> }).data;

test("an idea's schedule is present exactly when it is recurring, and a recurring idea's is never a once schedule", () => {
  const open = eventData("idea-updated-open-once.json");
  const recurring = eventData("idea-updated-open-recurring.json");
  assert.equal(IdeaSchema.safeParse(open).success, true, "a once idea has no schedule");
  assert.equal(IdeaSchema.safeParse(recurring).success, true, "a recurring idea has one");
  const { schedule: _schedule, ...noSchedule } = recurring;
  assert.equal(IdeaSchema.safeParse(noSchedule).success, false, "a recurring idea without a schedule");
  assert.equal(IdeaSchema.safeParse({ ...open, schedule: { kind: "daily", time: "09:00" } }).success, false, "a once idea with a schedule");
  assert.equal(IdeaSchema.safeParse({ ...recurring, schedule: { kind: "once", at: "2026-10-28T01:00:00.000Z" } }).success, false, "a once schedule");
});

test("an idea has a task exactly when accepted, and a rejection exactly when rejected", () => {
  const accepted = eventData("idea-updated-accepted.json");
  const rejected = eventData("idea-updated-rejected.json");
  const archived = eventData("idea-updated-archived.json");
  const open = eventData("idea-updated-open-once.json");
  const { taskId: _taskId, ...noTask } = accepted;
  assert.equal(IdeaSchema.safeParse(accepted).success, true);
  assert.equal(IdeaSchema.safeParse(noTask).success, false, "accepted without a task");
  assert.equal(IdeaSchema.safeParse({ ...rejected, taskId: "n2c7bq" }).success, false, "rejected with a task");
  assert.equal(IdeaSchema.safeParse({ ...archived, taskId: "n2c7bq" }).success, false, "archived with a task");
  assert.equal(IdeaSchema.safeParse({ ...open, taskId: "n2c7bq" }).success, false, "open with a task");
  const { rejection: _rejection, ...noRejection } = rejected;
  assert.equal(IdeaSchema.safeParse(rejected).success, true);
  assert.equal(IdeaSchema.safeParse(noRejection).success, false, "rejected without a rejection");
  assert.equal(IdeaSchema.safeParse({ ...archived, rejection: { reason: "not-now" } }).success, false, "archived with a rejection");
  assert.equal(IdeaSchema.safeParse({ ...accepted, rejection: { reason: "not-now" } }).success, false, "accepted with a rejection");
});

test("an idea's kind, state and rejection reason are each one of the listed values", () => {
  const rejected = eventData("idea-updated-rejected.json");
  const open = eventData("idea-updated-open-once.json");
  for (const reason of ["not-interested", "already-doing", "not-now", "too-expensive", "wrong-direction"]) {
    assert.equal(IdeaSchema.safeParse({ ...rejected, rejection: { reason } }).success, true, reason);
  }
  assert.equal(IdeaSchema.safeParse({ ...rejected, rejection: { reason: "bored" } }).success, false, "a reason outside the five");
  assert.equal(IdeaSchema.safeParse({ ...open, state: "snoozed" }).success, false, "a state outside the four");
  assert.equal(IdeaSchema.safeParse({ ...open, kind: "daily" }).success, false, "a kind outside the two");
});

test("an idea's estimate is a finite number from 0 to 20 USD", () => {
  const open = eventData("idea-updated-open-once.json");
  const estimate = (estimateUsd: number) => IdeaSchema.safeParse({ ...open, estimateUsd }).success;
  assert.equal(estimate(0), true, "0");
  assert.equal(estimate(MAX_TASK_BUDGET_USD), true, "20");
  for (const bad of [-0.01, MAX_TASK_BUDGET_USD + 0.01, Infinity, -Infinity, NaN]) {
    assert.equal(estimate(bad), false, String(bad));
  }
});

test("an idea's why is 1 to 300 characters, and a rejection's note 1 to 500, neither blank", () => {
  const open = eventData("idea-updated-open-once.json");
  const why = (text: string) => IdeaSchema.safeParse({ ...open, why: text }).success;
  assert.equal(why("x".repeat(MAX_IDEA_WHY_CHARS)), true, "300 characters");
  assert.equal(why("x".repeat(MAX_IDEA_WHY_CHARS + 1)), false, "301 characters");
  assert.equal(why("😀".repeat(MAX_IDEA_WHY_CHARS)), true, "a character is a code point");
  assert.equal(why(""), false, "empty");
  assert.equal(why("  "), false, "blank");

  const rejected = eventData("idea-updated-rejected.json");
  const note = (text: string) => IdeaSchema.safeParse({ ...rejected, rejection: { reason: "not-now", note: text } }).success;
  assert.equal(note("x".repeat(MAX_IDEA_NOTE_CHARS)), true, "500 characters");
  assert.equal(note("x".repeat(MAX_IDEA_NOTE_CHARS + 1)), false, "501 characters");
  assert.equal(note("  "), false, "blank");
  assert.equal(IdeaSchema.safeParse({ ...rejected, rejection: { reason: "not-now" } }).success, true, "no note");
});

/** The last generation of a response fixture. */
const lastGeneration = (name: string): Record<string, unknown> => (JSON.parse(readFixture("responses", name)) as { lastGeneration: Record<string, unknown> }).lastGeneration;

test("an idea list may name the last generation that ended: the run, when, how it ended, what started it and how many ideas it added", () => {
  const nothingNew = lastGeneration("idea-list-nothing-new.json");
  const list = IdeaListSchema.parse(JSON.parse(readFixture("responses", "idea-list-nothing-new.json")));
  assert.deepEqual(list.lastGeneration, nothingNew);
  assert.deepEqual(Object.keys(nothingNew), ["runId", "endedAt", "status", "trigger", "added", "note"]);
  assert.equal(IdeaListSchema.parse(JSON.parse(readFixture("responses", "idea-list.json"))).lastGeneration, undefined, "it is optional");
  assert.equal(IdeaListSchema.safeParse({ ideas: [], lastGeneration: { ...nothingNew, runId: "k7m2q" } }).success, false, "a malformed run id");
  assert.equal(IdeaListSchema.safeParse({ ideas: [], lastGeneration: { ...nothingNew, endedAt: "yesterday" } }).success, false, "a timestamp that is not one");
  const { runId: _runId, ...withoutRun } = nothingNew;
  assert.equal(IdeaListSchema.safeParse({ ideas: [], lastGeneration: withoutRun }).success, false, "no run");
});

test("a generation's status is done or failed, its trigger requested or daily", () => {
  const done = lastGeneration("idea-list-nothing-new.json");
  const failed = lastGeneration("idea-list-failed.json");
  assert.equal(IdeaGenerationSchema.safeParse(done).success, true);
  assert.equal(done.trigger, "requested");
  assert.equal(IdeaGenerationSchema.safeParse(failed).success, true);
  assert.equal(failed.status, "failed");
  assert.equal(failed.trigger, "daily");
  for (const status of ["done", "failed"]) assert.equal(IdeaGenerationSchema.safeParse({ ...done, status }).success, true, status);
  for (const trigger of ["requested", "daily"]) assert.equal(IdeaGenerationSchema.safeParse({ ...done, trigger }).success, true, trigger);
  assert.equal(IdeaGenerationSchema.safeParse({ ...done, status: "lost" }).success, false, "a status outside the two");
  assert.equal(IdeaGenerationSchema.safeParse({ ...done, status: "running" }).success, false, "a run that has not ended");
  assert.equal(IdeaGenerationSchema.safeParse({ ...done, trigger: "weekly" }).success, false, "a trigger outside the two");
  assert.equal(IdeaGenerationSchema.safeParse({ ...done, trigger: undefined }).success, false, "no trigger");
});

test("a generation adds an integer number of ideas from 0 to 3", () => {
  const done = lastGeneration("idea-list-nothing-new.json");
  const added = (count: unknown) => IdeaGenerationSchema.safeParse({ ...done, added: count }).success;
  assert.equal(MAX_NEW_IDEAS, 3);
  for (const count of [0, 1, 2, 3]) assert.equal(added(count), true, String(count));
  assert.equal(added(4), false, "4");
  assert.equal(added(-1), false, "-1");
  assert.equal(added(1.5), false, "1.5");
  assert.equal(added("1"), false, "a string");
  assert.equal(added(undefined), false, "none");
});

test("a generation's note is optional, 1 to 300 characters and not blank", () => {
  const done = lastGeneration("idea-list-nothing-new.json");
  const note = (text: unknown) => IdeaGenerationSchema.safeParse({ ...done, note: text }).success;
  assert.equal(note("x".repeat(MAX_IDEA_WHY_CHARS)), true, "300 characters");
  assert.equal(note("x".repeat(MAX_IDEA_WHY_CHARS + 1)), false, "301 characters");
  assert.equal(note("😀".repeat(MAX_IDEA_WHY_CHARS)), true, "a character is a code point");
  assert.equal(note(""), false, "empty");
  assert.equal(note("  \n"), false, "blank");
  assert.equal(note(7), false, "not a string");
  const { note: _note, ...withoutNote } = done;
  assert.equal(IdeaGenerationSchema.safeParse(withoutNote).success, true, "no note");
  assert.equal("note" in lastGeneration("idea-list-failed.json"), false, "the failed fixture has none");
});

test("idea.accept takes the task's fields and an optional schedule, idea.reject a reason and an optional note, idea.generate nothing", () => {
  const accept = (over: Record<string, unknown>) =>
    parseCommand({ type: "idea.accept", ideaId: "h3v8ct", title: "对比三家 VPS 的带宽配额", brief: "查带宽。", model: "sonnet", budgetUsd: 1, ...over });
  assert.equal(accept({}).ok, true, "a one-time task");
  assert.equal(accept({ schedule: { kind: "daily", time: "09:00" } }).ok, true, "a recurring task");
  assert.equal(accept({ schedule: { kind: "daily", time: "09:00", day: 1 } }).ok, false, "a schedule with an extra key");
  assert.equal(accept({ ideaId: "h3v8c" }).ok, false, "a malformed idea id");
  assert.equal(accept({ title: "x".repeat(81) }).ok, false, "a title of 81 characters");
  assert.equal(accept({ brief: " " }).ok, false, "a blank brief");
  assert.equal(accept({ budgetUsd: 25 }).ok, false, "a budget over 20");
  assert.equal(accept({ model: "gpt" }).ok, false, "a model Alfred does not run");

  const reject = (over: Record<string, unknown>) => parseCommand({ type: "idea.reject", ideaId: "m7x2zd", reason: "not-interested", ...over });
  assert.equal(reject({}).ok, true, "no note");
  assert.equal(reject({ note: "我自己会翻。" }).ok, true, "a note");
  assert.equal(reject({ note: "" }).ok, false, "an empty note");
  assert.equal(reject({ note: "x".repeat(MAX_IDEA_NOTE_CHARS + 1) }).ok, false, "a note over 500 characters");
  assert.equal(reject({ reason: "bored" }).ok, false, "a reason outside the five");

  assert.equal(parseCommand({ type: "idea.generate" }).ok, true);
  assert.equal(parseCommand({ type: "idea.generate", ideaId: "h3v8ct" }).ok, false, "an extra key");
});

test("a generation of ideas is a run of its own kind", () => {
  const run = eventData("run-updated-ideas.json");
  assert.equal(RunKindSchema.safeParse("ideas").success, true);
  assert.equal(RunSchema.parse(run).kind, "ideas");
});

test("the rules fixtures tell one story: the owner reads a version, edits the text and saves against that version", () => {
  const read = JSON.parse(readFixture("responses", "rules.json")) as { text: string; version: string; maxBytes: number };
  assert.equal(read.version, crypto.createHash("sha256").update(read.text).digest("hex"), "the version is the sha256 of the text");
  assert.equal(read.maxBytes, 8192);
  const save = JSON.parse(readFixture("commands", "rules-save.json")) as { text: string; version: string };
  assert.equal(save.version, read.version, "the save names the version that was read");
  assert.notEqual(save.text, read.text);
});

test("rules.save takes any text, empty included, and any version string; only its shape is checked here", () => {
  const save = (extra: Record<string, unknown>) => parseCommand({ type: "rules.save", text: "# rules\n", version: "x", ...extra });
  assert.equal(save({}).ok, true);
  assert.equal(save({ text: "" }).ok, true, "an empty text");
  assert.equal(save({ text: "a\0b" }).ok, true, "the size and NUL checks are Alfred's, after the schema");
  assert.equal(save({ text: "规".repeat(9000) }).ok, true, "the size check counts bytes, after the schema");
  assert.equal(save({ text: 5 }).ok, false);
  assert.equal(save({ version: 5 }).ok, false);
  assert.equal(save({ version: undefined }).ok, false);
});

test("Rules has a lowercase hex sha256 version and a positive size cap", () => {
  const rules = { text: "", version: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", maxBytes: 8192 };
  assert.equal(RulesSchema.safeParse(rules).success, true);
  for (const bad of [
    { ...rules, version: rules.version.toUpperCase() },
    { ...rules, version: rules.version.slice(1) },
    { ...rules, maxBytes: 0 },
    { ...rules, maxBytes: 1.5 },
    { ...rules, text: undefined },
  ]) {
    assert.equal(RulesSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

// --- Memory -------------------------------------------------------------------

const memoryCreate = (over: Record<string, unknown>) =>
  parseCommand({ type: "memory.create", name: "Metric units", description: "Use kilometres.", kind: "preference", body: "Convert miles.", ...over });
const memoryUpdate = (over: Record<string, unknown>) =>
  parseCommand({ type: "memory.update", file: "metric-units.md", version: "x", name: "Metric units", description: "", kind: "user", body: "", ...over });

test("the memory fixtures tell one story: a list, an update of its first memory against its version, and the result", async () => {
  const { formatMemory } = await import("../agent/memory.ts");
  type Memory = { file: string; name: string; description: string; kind: string; updated: string; body: string; version: string };
  const list = JSON.parse(readFixture("responses", "memory-list.json")) as { memories: Memory[]; promptCount: number };
  const sha256 = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
  for (const m of list.memories) {
    const bytes = formatMemory({ name: m.name, description: m.description, type: m.kind, updated: m.updated, body: m.body });
    assert.equal(m.version, sha256(bytes), `${m.file}: the version is the sha256 of the file formatMemory writes`);
  }
  assert.ok(list.promptCount < list.memories.length, "the cap cuts the list");
  assert.deepEqual(
    list.memories.map((m) => m.updated),
    [...list.memories.map((m) => m.updated)].sort().reverse(),
    "most recently updated first, a memory with no date last",
  );
  assert.ok(list.memories.some((m) => !/^[a-z0-9-]+\.md$/.test(m.file) || m.file.startsWith("memory-")), "a memory with a Chinese name has a generated file name");
  assert.ok(list.memories.some((m) => !["user", "preference", "project", "correction"].includes(m.kind)), "a memory of an older kind");

  const update = JSON.parse(readFixture("commands", "memory-update.json")) as Memory & { type: string };
  const edited = list.memories.find((m) => m.file === update.file);
  assert.equal(update.version, edited?.version, "the update names the version that was read");
  const result = JSON.parse(readFixture("responses", "memory-result.json")) as { memory: Memory };
  assert.equal(result.memory.file, update.file);
  assert.notEqual(result.memory.version, update.version);
  assert.deepEqual([result.memory.name, result.memory.description, result.memory.kind, result.memory.body], [update.name, update.description, update.kind, update.body]);

  const del = JSON.parse(readFixture("commands", "memory-delete.json")) as { file: string; version: string };
  assert.equal(del.version, list.memories.find((m) => m.file === del.file)?.version);
});

test("memory.create takes a kind of MEMORY_TYPES, a name of 1 to 80 characters and a description of 0 to 200, each one trimmed line", async () => {
  const { MEMORY_TYPES } = await import("../agent/memory.ts");
  assert.deepEqual(MemoryKindSchema.options, [...MEMORY_TYPES]);
  for (const kind of MEMORY_TYPES) assert.equal(memoryCreate({ kind }).ok, true, kind);
  assert.equal(memoryCreate({ kind: "habit" }).ok, false);
  assert.equal(memoryCreate({ kind: "" }).ok, false);

  assert.equal(memoryCreate({ name: "名".repeat(80) }).ok, true, "80 characters, counted as characters and not bytes");
  assert.equal(memoryCreate({ name: "名".repeat(81) }).ok, false);
  assert.equal(memoryCreate({ name: "😀".repeat(80) }).ok, true, "an emoji is one character");
  assert.equal(memoryCreate({ name: "" }).ok, false, "a name is not empty");
  assert.equal(memoryCreate({ description: "" }).ok, true, "a description may be");
  assert.equal(memoryCreate({ description: "d".repeat(200) }).ok, true);
  assert.equal(memoryCreate({ description: "d".repeat(201) }).ok, false);

  for (const text of [" padded", "padded ", "\tx", "two\nlines", "carriage\rreturn", "tab\there", "nul\0", "bell\u0007", "del\u007f", "next\u0085line", `sep${String.fromCharCode(0x2028)}arator`, `par${String.fromCharCode(0x2029)}agraph`]) {
    assert.equal(memoryCreate({ name: text }).ok, false, `name ${JSON.stringify(text)}`);
    assert.equal(memoryCreate({ description: text }).ok, false, `description ${JSON.stringify(text)}`);
  }
  assert.equal(memoryCreate({ name: "inner  spaces and 标点，。" }).ok, true);
});

test("a memory's body is at most 8192 bytes of UTF-8, may be empty and has no NUL", () => {
  assert.equal(memoryCreate({ body: "a".repeat(8192) }).ok, true);
  assert.equal(memoryCreate({ body: "a".repeat(8193) }).ok, false);
  assert.equal(memoryCreate({ body: "规".repeat(2730) }).ok, true, "8190 bytes");
  assert.equal(memoryCreate({ body: "规".repeat(2731) }).ok, false, "8193 bytes");
  assert.equal(memoryCreate({ body: "" }).ok, true);
  assert.equal(memoryCreate({ body: "line\n\nline\n" }).ok, true, "a body has lines");
  assert.equal(memoryCreate({ body: "a\0b" }).ok, false);
  assert.equal(memoryUpdate({ body: "a".repeat(8193) }).ok, false);
});

test("memory.update and memory.delete name a file of MEMORY_FILE_RE and a version, and take no other key", async () => {
  const { MEMORY_FILE_RE } = await import("../agent/memory.ts");
  for (const file of ["a.md", "metric-units.md", "memory-20261025-4k2p.md", `${"a".repeat(80)}.md`, `${"a".repeat(81)}.md`, "-a.md", "A.md", "a b.md", "a.txt", "a.md.md", "a/b.md", "../a.md", "MEMORY.md", "名.md", ""]) {
    const expected = MEMORY_FILE_RE.test(file);
    assert.equal(memoryUpdate({ file }).ok, expected, `update ${file}`);
    assert.equal(parseCommand({ type: "memory.delete", file, version: "x" }).ok, expected, `delete ${file}`);
  }
  assert.equal(memoryUpdate({ version: undefined }).ok, false, "an update needs the version");
  assert.equal(parseCommand({ type: "memory.delete", file: "a.md" }).ok, false, "so does a delete");
  assert.equal(memoryUpdate({ version: "not-a-hash" }).ok, true, "its shape is not checked: another version is a conflict, which Alfred answers");
  assert.equal(memoryUpdate({ updated: "2026-10-29" }).ok, false);
  assert.equal(parseCommand({ type: "memory.delete", file: "a.md", version: "x", force: true }).ok, false);
  assert.equal(memoryCreate({ file: "a.md" }).ok, false, "a new memory's file is Alfred's to name");
});

test("a Memory has a lowercase hex sha256 version, a date or nothing for updated, and a kind that is any string", () => {
  const memory = {
    file: "a.md",
    name: "",
    description: "",
    kind: "",
    updated: "",
    body: "",
    version: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  };
  assert.equal(MemorySchema.safeParse(memory).success, true, "what an old file with no fields reads as");
  assert.equal(MemorySchema.safeParse({ ...memory, kind: "feedback", updated: "2026-10-29" }).success, true);
  for (const bad of [
    { ...memory, version: memory.version.toUpperCase() },
    { ...memory, version: memory.version.slice(1) },
    { ...memory, version: undefined },
    { ...memory, updated: "2026-10-9" },
    { ...memory, updated: "yesterday" },
    { ...memory, file: "" },
  ]) {
    assert.equal(MemorySchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
  assert.equal(MemoryListSchema.safeParse({ memories: [], promptCount: 0 }).success, true);
  assert.equal(MemoryListSchema.safeParse({ memories: [memory], promptCount: 1 }).success, true);
  assert.equal(MemoryListSchema.safeParse({ memories: [memory], promptCount: 2 }).success, false, "more in the prompt than there are");
  assert.equal(MemoryListSchema.safeParse({ memories: [memory], promptCount: -1 }).success, false);
  assert.equal(MemoryResultSchema.safeParse({ memory }).success, true);
});

// --- Settings -----------------------------------------------------------------

const settingsUpdate = (over: Record<string, unknown>) => parseCommand({ type: "settings.update", ...over });
const settingsResult = (): Record<string, unknown> => JSON.parse(readFixture("responses", "settings-result.json"));

test("the settings range constants are the ranges of the settings table", () => {
  assert.equal(MAX_DAILY_BUDGET_USD, 100);
  assert.equal(MAX_RUN_BUDGET_USD, 20);
  assert.equal(MAX_RUN_BUDGET_USD, MAX_TASK_BUDGET_USD, "a chat run may spend what a task's run may");
  assert.equal(MAX_SESSION_IDLE_HOURS, 168);
  assert.equal(MIN_COMPACT_TOKENS, 20_000);
  assert.equal(MAX_COMPACT_TOKENS, 1_000_000);
  assert.equal(MAX_MEMORY_SCAN_MINUTES, 1440);
  assert.equal(MAX_MEMORY_SCAN_BUDGET_USD, 1);
});

test("the setting keys are the table's eight, and a Settings object has each of them and overridden", () => {
  const keys = ["model", "dailyBudgetUsd", "runBudgetUsd", "sessionIdleHours", "compactTokens", "memoryScanMinutes", "memoryScanBudgetUsd", "ideasAt"];
  assert.deepEqual(SettingKeySchema.options, keys);
  assert.deepEqual(Object.keys(settingsResult().settings as object).filter((key) => key !== "overridden").sort(), [...keys].sort());
});

test("settings.update sets each setting within its range, bounds included, and refuses a value beyond it", () => {
  const ok = (over: Record<string, unknown>) => settingsUpdate(over).ok;
  assert.equal(ok({ dailyBudgetUsd: 1 }), true, "the daily budget's lower bound");
  assert.equal(ok({ dailyBudgetUsd: 100 }), true, "the daily budget's upper bound");
  assert.equal(ok({ dailyBudgetUsd: 0.99 }), false, "below 1");
  assert.equal(ok({ dailyBudgetUsd: 101 }), false, "above 100");
  assert.equal(ok({ runBudgetUsd: 1 }), true);
  assert.equal(ok({ runBudgetUsd: 20 }), true);
  assert.equal(ok({ runBudgetUsd: 20.5 }), false);
  assert.equal(ok({ sessionIdleHours: 0 }), true, "0 turns rotation off");
  assert.equal(ok({ sessionIdleHours: 168 }), true);
  assert.equal(ok({ sessionIdleHours: -1 }), false);
  assert.equal(ok({ compactTokens: 0 }), true, "0 keeps Claude Code's window");
  assert.equal(ok({ compactTokens: 20_000 }), true);
  assert.equal(ok({ compactTokens: 1_000_000 }), true);
  for (const tokens of [1, 19_999, 1_000_001, 20_000.5]) assert.equal(ok({ compactTokens: tokens }), false, String(tokens));
  assert.equal(ok({ memoryScanMinutes: 0 }), true, "0 turns scans off");
  assert.equal(ok({ memoryScanMinutes: 1440 }), true);
  assert.equal(ok({ memoryScanMinutes: 1441 }), false);
  assert.equal(ok({ memoryScanBudgetUsd: 0 }), false, "above 0");
  assert.equal(ok({ memoryScanBudgetUsd: 0.01 }), true);
  assert.equal(ok({ memoryScanBudgetUsd: 1 }), true);
  assert.equal(ok({ memoryScanBudgetUsd: 1.01 }), false);
  for (const model of ["sonnet", "opus", "haiku"]) assert.equal(ok({ model }), true, model);
  assert.equal(ok({ model: "gpt" }), false);
});

test("ideasAt is an HH:MM time or null in a command, and a response takes the same shapes", () => {
  assert.equal(settingsUpdate({ ideasAt: "00:00" }).ok, true);
  assert.equal(settingsUpdate({ ideasAt: "23:59" }).ok, true);
  assert.equal(settingsUpdate({ ideasAt: null }).ok, true, "null turns the generation off");
  for (const ideasAt of ["24:00", "8:00", "", "08:00:00"]) assert.equal(settingsUpdate({ ideasAt }).ok, false, JSON.stringify(ideasAt));

  const result = settingsResult();
  const withIdeasAt = (ideasAt: unknown) => SettingsResultSchema.safeParse({ settings: { ...(result.settings as object), ideasAt } }).success;
  assert.equal(withIdeasAt(null), true);
  assert.equal(withIdeasAt("08:00"), true);
  assert.equal(withIdeasAt("24:00"), false);
});

test("a settings.update changes at least one setting or resets one, and resets each key once", () => {
  assert.deepEqual(parseCommand({ type: "settings.update" }), { ok: false, error: "must change at least one setting or reset one" });
  assert.equal(settingsUpdate({ reset: ["ideasAt"] }).ok, true, "a reset alone is a change");
  assert.deepEqual(settingsUpdate({ reset: [] }), { ok: false, error: "reset: must not be empty" });
  assert.deepEqual(settingsUpdate({ reset: ["dailyBudgetUsd", "dailyBudgetUsd"] }), { ok: false, error: "reset: must not repeat a key" });
  assert.equal(settingsUpdate({ reset: ["temperature"] }).ok, false, "a key outside the eight");
  assert.deepEqual(settingsUpdate({ dailyBudgetUsd: 30, reset: ["dailyBudgetUsd"] }), {
    ok: false,
    error: "reset: must not name a setting that is also set",
  });
  assert.deepEqual(settingsUpdate({ dailyBudgetUsd: 101 }), { ok: false, error: "dailyBudgetUsd: must be at most 100" });
  assert.deepEqual(settingsUpdate({ compactTokens: 19_999 }), { ok: false, error: "compactTokens: must be 0, or from 20000 to 1000000" });
  assert.equal(settingsUpdate({ dailyBudgetUsd: 30, colour: "red" }).ok, false, "an unknown key");
});

test("every invalid settings.update command is rejected", () => {
  const invalid = fixtureNames("invalid-commands").filter((name) => name.startsWith("settings-"));
  assert.equal(invalid.length, 17, "one file per rule of the settings command");
  for (const name of invalid) {
    assert.equal(parseCommand(JSON.parse(readFixture("invalid-commands", name))).ok, false, name);
  }
});

test("a settings response has all eight keys and overridden, which names each override once, in the table's order", () => {
  const result = settingsResult();
  const withOverridden = (overridden: unknown) => SettingsResultSchema.safeParse({ settings: { ...(result.settings as object), overridden } }).success;
  assert.equal(withOverridden(["model", "dailyBudgetUsd", "ideasAt"]), true);
  assert.equal(withOverridden([]), true, "nothing overridden");
  assert.equal(withOverridden(["dailyBudgetUsd", "model"]), false, "out of the table's order");
  assert.equal(withOverridden(["model", "model"]), false, "a repeated key");

  const { ideasAt: _ideasAt, ...noIdeasAt } = result.settings as Record<string, unknown>;
  assert.equal(SettingsResultSchema.safeParse({ settings: noIdeasAt }).success, false, "ideasAt is present even when off");
});

test("a settings response checks types and the HH:MM shape only, so a value beyond a command's range is accepted", () => {
  const beyond = JSON.parse(readFixture("responses", "settings-result-beyond-ranges.json"));
  assert.equal(SettingsResultSchema.parse(beyond).settings.dailyBudgetUsd, 150);
  assert.equal(settingsUpdate({ dailyBudgetUsd: 150 }).ok, false, "the command still refuses it");

  const settings = { ...(settingsResult().settings as object) };
  const beyondRanges = { ...settings, runBudgetUsd: 0, sessionIdleHours: -1, compactTokens: 5, memoryScanMinutes: 5000, memoryScanBudgetUsd: 3 };
  assert.equal(SettingsResultSchema.safeParse({ settings: beyondRanges }).success, true);
  assert.equal(SettingsResultSchema.safeParse({ settings: { ...settings, compactTokens: 2.5 } }).success, false, "compactTokens is an integer");
});

test("the settings detail's spend today is 0 or more", () => {
  const detail = JSON.parse(readFixture("responses", "settings-detail.json"));
  assert.equal(SettingsDetailSchema.safeParse(detail).success, true);
  assert.equal(SettingsDetailSchema.safeParse({ ...detail, spentTodayUsd: 0 }).success, true, "zero");
  assert.equal(SettingsDetailSchema.safeParse({ ...detail, spentTodayUsd: -0.01 }).success, false);
});

test("the settings.updated event carries the whole settings", () => {
  const event = JSON.parse(readFixture("events", "settings-updated.json"));
  const parsed = EventSchema.safeParse(event);
  assert.equal(parsed.success, true);
  assert.deepEqual(eventData("settings-updated.json").overridden, ["model", "dailyBudgetUsd"]);
  assert.equal(EventSchema.safeParse({ ...event, data: { ...event.data, ideasAt: undefined } }).success, false, "every key is there");
});
