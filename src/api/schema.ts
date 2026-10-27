// The client API contract: the events Alfred emits, the commands it accepts and
// the objects they carry. The iOS client decodes the same shapes, and the JSON
// fixtures under fixtures/api/ (see its README.md) are what both sides test against.
//
// Events and the objects they carry ignore keys they do not know, so a newer
// Alfred can add fields. Commands are strict: Alfred rejects unknown command types and keys.

import { z } from "zod";

import type { ModelKey } from "../agent/config.ts";
import type { RunKind, RunStatus, RunStep } from "../runs.ts";

/** The command API's request body limit, in bytes. */
export const MAX_COMMAND_BYTES = 65_536;
/** The most files one message.send attaches. */
export const MAX_MESSAGE_FILES = 10;
/** The upload limit for one file, in bytes (50 MiB). */
export const MAX_UPLOAD_BYTES = 52_428_800;
/** The most characters a task's title holds. */
export const MAX_TASK_TITLE_CHARS = 80;
/** The most a task's run may spend, in USD. */
export const MAX_TASK_BUDGET_USD = 20;
/** The longest interval between a task's runs, in hours: one week. */
export const MAX_INTERVAL_HOURS = 168;
/** The most skips a task keeps. */
export const MAX_TASK_SKIPS = 10;
/** A new task's per-run budget, in USD, when its command gives none. */
export const DEFAULT_TASK_BUDGET_USD = 2;
/** A new task's model, when its command gives none. */
export const DEFAULT_TASK_MODEL = "sonnet";
/** The most characters a document's title holds. */
export const MAX_DOCUMENT_TITLE_CHARS = 200;
/** The most characters an annotation's comment holds. */
export const MAX_ANNOTATION_COMMENT_CHARS = 2000;
/** The most characters an annotation's quoted passage holds. */
export const MAX_ANNOTATION_QUOTE_CHARS = 2000;
/** The most characters of text on each side of a quoted passage that anchor it. */
export const MAX_ANNOTATION_CONTEXT_CHARS = 200;
/** The most annotations one revision run takes. */
export const MAX_ANNOTATIONS_PER_REVISION = 50;
/** The most characters an idea's why holds. */
export const MAX_IDEA_WHY_CHARS = 300;
/** The most characters an idea's rejection note holds. */
export const MAX_IDEA_NOTE_CHARS = 500;
const MAX_ANNOTATION_REPLY_CHARS = 4000;
const MAX_TEXT_CHARS = 20_000;
const MAX_ANSWER_CHARS = 2000;

const IsoTimestampSchema = z.iso.datetime();
// The shape newRunId in src/runs.ts draws from: no 0, o, 1, l or i.
const RunIdSchema = z.string().regex(/^[2-9a-hjkmnp-z]{6}$/, "must be a six-character run id");
// A task id has the run id's alphabet and length.
const TaskIdSchema = z.string().regex(/^[2-9a-hjkmnp-z]{6}$/, "must be a six-character task id");
const ClientIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "must be 1-64 letters, digits, _ or -");
const QuestionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "must be 1-64 letters, digits, _ or -");
// A document id and an annotation id have the run id's alphabet and length.
const DocumentIdSchema = z.string().regex(/^[2-9a-hjkmnp-z]{6}$/, "must be a six-character document id");
const AnnotationIdSchema = z.string().regex(/^[2-9a-hjkmnp-z]{6}$/, "must be a six-character annotation id");
// A version is the full id of a commit in the workspace's history.
const VersionSchema = z.string().regex(/^[0-9a-f]{40}$/, "must be a 40-character commit id");

// "app" is the only channel Alfred uses now. The other is a retired one: its messages stay in the event log, so clients still read it.
export const ChannelSchema = z.enum(["app", "wechat"]);

export const FileKindSchema = z.enum(["image", "voice", "video", "file"]);

// A path relative to the workspace.
const WorkspacePathSchema = z
  .string()
  .min(1, "must not be empty")
  .refine((path) => !path.startsWith("/"), "must not start with /")
  .refine((path) => !path.split("/").includes(".."), "must not contain a .. segment");

// A file a delivery registered names its document and the version it delivered: both or neither.
export const FileRefSchema = z
  .object({
    path: WorkspacePathSchema,
    kind: FileKindSchema.optional(),
    documentId: DocumentIdSchema.optional(),
    version: VersionSchema.optional(),
  })
  .refine((file) => (file.documentId === undefined) === (file.version === undefined), {
    path: ["documentId"],
    message: "must be set together with version, or not at all",
  });

// A file in the inbox, where inbound media and app uploads are saved.
const InboxPathSchema = WorkspacePathSchema.refine((path) => path.startsWith("inbox/"), "must start with inbox/");

export const MessageSchema = z
  .object({
    id: z.string().min(1).max(64),
    channel: ChannelSchema,
    direction: z.enum(["in", "out"]),
    text: z.string(),
    files: z.array(FileRefSchema),
    at: IsoTimestampSchema,
    runId: RunIdSchema.optional(),
    taskId: TaskIdSchema.optional(),
    clientId: ClientIdSchema.optional(),
    error: z.string().optional(),
  })
  .refine((message) => message.text !== "" || message.files.length > 0, "text or files must not both be empty");

export const RunKindSchema = z.enum(["task", "scan", "subagent", "revision", "ideas"]);
export const RunStatusSchema = z.enum(["queued", "running", "done", "stopped", "failed", "lost"]);

// Compile-time check that the enums above are exactly RunKind and RunStatus in src/runs.ts.
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type RunKindMatches = Expect<Equals<z.infer<typeof RunKindSchema>, RunKind>>;
type RunStatusMatches = Expect<Equals<z.infer<typeof RunStatusSchema>, RunStatus>>;

/** The model a task's runs use: the keys of MODELS in src/agent/config.ts. */
export const ModelSchema = z.enum(["sonnet", "opus", "haiku"]);
type ModelMatches = Expect<Equals<z.infer<typeof ModelSchema>, ModelKey>>;

/** The client's view of a run record: the fields of RunRecord it shows, nothing else. */
export const RunSchema = z.object({
  id: RunIdSchema,
  kind: RunKindSchema,
  taskId: TaskIdSchema.optional(),
  documentId: DocumentIdSchema.optional(),
  parentRunId: RunIdSchema.optional(),
  title: z.string(),
  status: RunStatusSchema,
  model: z.string().optional(),
  startedAt: IsoTimestampSchema,
  endedAt: IsoTimestampSchema.optional(),
  costUsd: z.number(),
  files: z.array(z.object({ path: z.string(), tool: z.string() })),
  error: z.string().optional(),
});

/** One step of a run's timeline: a tool the run used, and what it was used on. */
export const StepSchema = z.object({
  at: IsoTimestampSchema,
  tool: z.string(),
  detail: z.string(),
  agent: z.string().optional(),
});

// Compile-time check that StepSchema is exactly RunStep in src/runs.ts.
type StepMatches = Expect<Equals<z.infer<typeof StepSchema>, RunStep>>;

/** One choice of a question. The agent's preview of an option is not part of the contract. */
export const QuestionOptionSchema = z.object({
  label: z.string().min(1, "must not be empty"),
  description: z.string(),
});

/** One question Alfred asks the owner mid-run: two to four options, one or several of which may be picked. */
export const QuestionSchema = z.object({
  question: z.string().min(1, "must not be empty"),
  header: z.string().min(1, "must not be empty"),
  options: z.array(QuestionOptionSchema).min(2, "must have at least 2 options").max(4, "must have at most 4 options"),
  multiSelect: z.boolean(),
});

/** The data of question.asked: a run waits on these questions until they are answered or cancelled. */
export const QuestionAskedSchema = z.object({
  id: QuestionIdSchema,
  runId: RunIdSchema,
  questions: z.array(QuestionSchema).min(1, "must have at least 1 question").max(4, "must have at most 4 questions"),
});

/**
 * The data of question.answered. `answers` maps a question's text to its answer: an option's label, the labels
 * of several options joined with ", " for a multi-select question, or free text. A cancelled question has none.
 */
export const QuestionAnsweredSchema = z
  .object({
    id: QuestionIdSchema,
    runId: RunIdSchema,
    answers: z.record(z.string(), z.string().min(1, "must not be empty")),
    cancelled: z.boolean().optional(),
  })
  .refine((data) => !data.cancelled || Object.keys(data.answers).length === 0, {
    path: ["answers"],
    message: "must be empty when the question was cancelled",
  });

const TaskTitleSchema = z
  .string()
  .refine((title) => title.trim() !== "", "must not be blank")
  .refine((title) => [...title].length <= MAX_TASK_TITLE_CHARS, `must be at most ${MAX_TASK_TITLE_CHARS} characters`);

// A task's brief is what each run is asked to do: the same limit as a message's text.
const TaskBriefSchema = z
  .string()
  .refine((brief) => brief.trim() !== "", "must not be blank")
  .refine((brief) => [...brief].length <= MAX_TEXT_CHARS, `must be at most ${MAX_TEXT_CHARS} characters`);

const TaskBudgetSchema = z
  .number()
  .gt(0, "must be greater than 0")
  .max(MAX_TASK_BUDGET_USD, `must be at most ${MAX_TASK_BUDGET_USD}`);

// A time of day is 24-hour HH:MM, from 00:00 to 23:59.
const TimeOfDaySchema = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, "must be a 24-hour time as HH:MM");
// ISO 8601 weekdays: 1 is Monday, 7 is Sunday.
const WeekdaySchema = z.int().min(1, "must be 1 to 7, Monday being 1").max(7, "must be 1 to 7, Monday being 1");
const WeekdaysSchema = z
  .array(WeekdaySchema)
  .min(1, "must have at least 1 weekday")
  .max(7, "must have at most 7 weekdays")
  .refine((days) => days.every((day, index) => index === 0 || day > (days[index - 1] ?? 0)), "must be in strictly ascending order");
const IntervalHoursSchema = z
  .int()
  .min(1, "must be at least 1 hour")
  .max(MAX_INTERVAL_HOURS, `must be at most ${MAX_INTERVAL_HOURS} hours`);

// The shapes of a schedule. A command's schedule is strict; a task in an event or response ignores unknown keys.
const ONCE_SHAPE = { kind: z.literal("once"), at: IsoTimestampSchema };
const DAILY_SHAPE = { kind: z.literal("daily"), time: TimeOfDaySchema };
const WEEKLY_SHAPE = { kind: z.literal("weekly"), days: WeekdaysSchema, time: TimeOfDaySchema };
const INTERVAL_SHAPE = { kind: z.literal("interval"), hours: IntervalHoursSchema };

/** When a task runs: once at a time, daily or weekly at a time, or every N hours. */
export const ScheduleSchema = z.discriminatedUnion("kind", [
  z.object(ONCE_SHAPE),
  z.object(DAILY_SHAPE),
  z.object(WEEKLY_SHAPE),
  z.object(INTERVAL_SHAPE),
]);
const ScheduleCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject(ONCE_SHAPE),
  z.strictObject(DAILY_SHAPE),
  z.strictObject(WEEKLY_SHAPE),
  z.strictObject(INTERVAL_SHAPE),
]);

const TaskStatusSchema = z.enum(["active", "paused", "done"]);
const TaskOriginSchema = z.enum(["manual", "chat", "idea"]);

/** A run a task missed or skipped: when it was due, and why it did not run. */
export const TaskSkipSchema = z.object({
  at: IsoTimestampSchema,
  reason: z.enum(["missed", "daily-cap"]),
});

/** A task: a brief the agent runs on a schedule. `nextRunAt` is absent unless the task is active. */
export const TaskSchema = z
  .object({
    id: TaskIdSchema,
    title: TaskTitleSchema,
    brief: TaskBriefSchema,
    origin: TaskOriginSchema,
    schedule: ScheduleSchema,
    status: TaskStatusSchema,
    model: ModelSchema,
    budgetUsd: TaskBudgetSchema,
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
    nextRunAt: IsoTimestampSchema.optional(),
    lastRunId: RunIdSchema.optional(),
    lastRunAt: IsoTimestampSchema.optional(),
    skips: z.array(TaskSkipSchema).max(MAX_TASK_SKIPS, `must have at most ${MAX_TASK_SKIPS} skips`),
  })
  .refine((task) => task.nextRunAt === undefined || task.status === "active", {
    path: ["nextRunAt"],
    message: "must be absent unless the task is active",
  });

const DocumentTitleSchema = z
  .string()
  .refine((title) => title.trim() !== "", "must not be blank")
  .refine((title) => [...title].length <= MAX_DOCUMENT_TITLE_CHARS, `must be at most ${MAX_DOCUMENT_TITLE_CHARS} characters`);

/** What a document is, by its file. Which kinds take passage annotations is Alfred's check, not the schema's. */
export const DocumentKindSchema = z.enum(["markdown", "text", "html", "pdf", "image", "other"]);

/**
 * One version of a document: a commit of the workspace. An undone version names the revision it undid and has no run;
 * every other version may name the run that made it.
 */
export const DocumentVersionSchema = z
  .object({
    version: VersionSchema,
    at: IsoTimestampSchema,
    reason: z.enum(["delivered", "revised", "undone", "changed"]),
    runId: RunIdSchema.optional(),
    undoes: RunIdSchema.optional(),
  })
  .refine((version) => (version.reason === "undone") === (version.undoes !== undefined), {
    path: ["undoes"],
    message: "must be set exactly when the reason is undone",
  })
  .refine((version) => version.reason !== "undone" || version.runId === undefined, {
    path: ["runId"],
    message: "must be absent on an undone version",
  });

/** A file Alfred delivered, known by its workspace path. `version` is the document's current version. */
export const DocumentSchema = z.object({
  id: DocumentIdSchema,
  path: WorkspacePathSchema,
  title: DocumentTitleSchema,
  kind: DocumentKindSchema,
  taskId: TaskIdSchema.optional(),
  version: VersionSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});

const AnnotationQuoteSchema = z
  .string()
  .refine((quote) => quote.trim() !== "", "must not be blank")
  .refine((quote) => [...quote].length <= MAX_ANNOTATION_QUOTE_CHARS, `must be at most ${MAX_ANNOTATION_QUOTE_CHARS} characters`);

const AnnotationContextSchema = z
  .string()
  .refine((text) => [...text].length <= MAX_ANNOTATION_CONTEXT_CHARS, `must be at most ${MAX_ANNOTATION_CONTEXT_CHARS} characters`);

const AnnotationCommentSchema = z
  .string()
  .refine((comment) => comment.trim() !== "", "must not be blank")
  .refine((comment) => [...comment].length <= MAX_ANNOTATION_COMMENT_CHARS, `must be at most ${MAX_ANNOTATION_COMMENT_CHARS} characters`);

const AnnotationReplySchema = z
  .string()
  .min(1, "must not be empty")
  .refine((reply) => [...reply].length <= MAX_ANNOTATION_REPLY_CHARS, `must be at most ${MAX_ANNOTATION_REPLY_CHARS} characters`);

// The shapes of an annotation's target. A passage is anchored by its quote and the text on each side of it (W3C
// TextQuoteSelector's exact, prefix and suffix). A command's target is strict; a target in an event ignores unknown keys.
const PASSAGE_TARGET_SHAPE = {
  kind: z.literal("passage"),
  quote: AnnotationQuoteSchema,
  prefix: AnnotationContextSchema,
  suffix: AnnotationContextSchema,
};
const DOCUMENT_TARGET_SHAPE = { kind: z.literal("document") };

/** What an annotation is on: a passage of the text, or the whole document. */
export const AnnotationTargetSchema = z.discriminatedUnion("kind", [z.object(PASSAGE_TARGET_SHAPE), z.object(DOCUMENT_TARGET_SHAPE)]);
const AnnotationTargetCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject(PASSAGE_TARGET_SHAPE),
  z.strictObject(DOCUMENT_TARGET_SHAPE),
]);

/**
 * An annotation: the owner's comment on a passage or on the whole document, and how its revision run stands with it.
 * A resolved one has the reply that answered it; a returned one has the reason it went back to the owner.
 */
export const AnnotationSchema = z
  .object({
    id: AnnotationIdSchema,
    documentId: DocumentIdSchema,
    version: VersionSchema,
    target: AnnotationTargetSchema,
    comment: AnnotationCommentSchema,
    state: z.enum(["submitted", "resolved", "returned"]),
    runId: RunIdSchema,
    reply: AnnotationReplySchema.optional(),
    returnReason: z.enum(["unanswered", "undone", "stopped", "failed"]).optional(),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .refine((annotation) => annotation.state !== "resolved" || annotation.reply !== undefined, {
    path: ["reply"],
    message: "must be set when the annotation is resolved",
  })
  .refine((annotation) => annotation.state !== "submitted" || annotation.reply === undefined, {
    path: ["reply"],
    message: "must be absent until the annotation is answered",
  })
  .refine((annotation) => (annotation.state === "returned") === (annotation.returnReason !== undefined), {
    path: ["returnReason"],
    message: "must be set exactly when the annotation is returned",
  });

/** One annotation in a document.revise command: its target and the owner's comment. */
const AnnotationDraftSchema = z.strictObject({
  target: AnnotationTargetCommandSchema,
  comment: AnnotationCommentSchema,
});

// An idea id has the run id's alphabet and length.
const IdeaIdSchema = z.string().regex(/^[2-9a-hjkmnp-z]{6}$/, "must be a six-character idea id");

const IdeaWhySchema = z
  .string()
  .refine((why) => why.trim() !== "", "must not be blank")
  .refine((why) => [...why].length <= MAX_IDEA_WHY_CHARS, `must be at most ${MAX_IDEA_WHY_CHARS} characters`);

const IdeaNoteSchema = z
  .string()
  .refine((note) => note.trim() !== "", "must not be blank")
  .refine((note) => [...note].length <= MAX_IDEA_NOTE_CHARS, `must be at most ${MAX_IDEA_NOTE_CHARS} characters`);

/** Why the owner rejected an idea. */
export const RejectionReasonSchema = z.enum(["not-interested", "already-doing", "not-now", "too-expensive", "wrong-direction"]);

/** What an idea proposes: a task to run once, or a recurring one. */
export const IdeaKindSchema = z.enum(["once", "recurring"]);

/** Where an idea stands: open, accepted as a task, rejected, or archived after 7 days unanswered. */
export const IdeaStateSchema = z.enum(["open", "accepted", "rejected", "archived"]);

/** The owner's rejection of an idea: a reason, and a note if they gave one. */
export const RejectionSchema = z.object({
  reason: RejectionReasonSchema,
  note: IdeaNoteSchema.optional(),
});

/**
 * An idea: a suggestion Alfred made from memory and recent conversations. A recurring idea proposes a schedule, and
 * one that is not a once schedule; the schedule is absent for a once idea. `taskId` is set exactly when the idea is
 * accepted, and `rejection` exactly when it is rejected.
 */
export const IdeaSchema = z
  .object({
    id: IdeaIdSchema,
    title: TaskTitleSchema,
    why: IdeaWhySchema,
    brief: TaskBriefSchema,
    kind: IdeaKindSchema,
    schedule: ScheduleSchema.optional(),
    model: ModelSchema,
    estimateUsd: z.number().min(0, "must be at least 0").max(MAX_TASK_BUDGET_USD, `must be at most ${MAX_TASK_BUDGET_USD}`),
    state: IdeaStateSchema,
    taskId: TaskIdSchema.optional(),
    rejection: RejectionSchema.optional(),
    runId: RunIdSchema,
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .refine((idea) => (idea.kind === "recurring") === (idea.schedule !== undefined), {
    path: ["schedule"],
    message: "must be set exactly when the idea is recurring",
  })
  .refine((idea) => idea.schedule?.kind !== "once", {
    path: ["schedule"],
    message: "must not be a once schedule",
  })
  .refine((idea) => (idea.state === "accepted") === (idea.taskId !== undefined), {
    path: ["taskId"],
    message: "must be set exactly when the idea is accepted",
  })
  .refine((idea) => (idea.state === "rejected") === (idea.rejection !== undefined), {
    path: ["rejection"],
    message: "must be set exactly when the idea is rejected",
  });

const EventEnvelope = { id: z.int().positive(), at: IsoTimestampSchema };

export const EventSchema = z.discriminatedUnion("type", [
  z.object({ ...EventEnvelope, type: z.literal("message.created"), data: MessageSchema }),
  z.object({ ...EventEnvelope, type: z.literal("run.updated"), data: RunSchema }),
  z.object({ ...EventEnvelope, type: z.literal("question.asked"), data: QuestionAskedSchema }),
  z.object({ ...EventEnvelope, type: z.literal("question.answered"), data: QuestionAnsweredSchema }),
  z.object({ ...EventEnvelope, type: z.literal("task.updated"), data: TaskSchema }),
  z.object({ ...EventEnvelope, type: z.literal("document.updated"), data: DocumentSchema }),
  z.object({ ...EventEnvelope, type: z.literal("annotation.updated"), data: AnnotationSchema }),
  z.object({ ...EventEnvelope, type: z.literal("idea.updated"), data: IdeaSchema }),
]);

const StreamIdSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/, "must be 1-64 letters, digits, _, ., : or -");

// A live event is streamed as it happens and is never stored, so it has no id: it is sent
// without an SSE id line and is never replayed on resume. A client tells the two apart by the
// id key: an Event has one, a LiveEvent does not. A live type the client does not know is skipped.
export const LiveEventSchema = z.discriminatedUnion("type", [
  z.object({
    at: IsoTimestampSchema,
    type: z.literal("message.delta"),
    data: z.object({
      runId: RunIdSchema,
      streamId: StreamIdSchema,
      text: z.string().min(1, "must not be empty"),
    }),
  }),
  z.object({
    at: IsoTimestampSchema,
    type: z.literal("run.step"),
    data: z.object({ runId: RunIdSchema, step: StepSchema }),
  }),
]);

/** The body of GET /api/runs: runs, newest first. */
export const RunListSchema = z.object({ runs: z.array(RunSchema) });

/** The body of GET /api/runs/<id>: a run and its step timeline. */
export const RunDetailSchema = z.object({ run: RunSchema, steps: z.array(StepSchema) });

/** The body of a successful task.create or task.update: the task as Alfred now holds it. */
export const TaskResultSchema = z.object({ task: TaskSchema });

/** The body of GET /api/tasks: the time zone the schedules are computed in, and the tasks, newest created first. */
export const TaskListSchema = z.object({
  timeZone: z.string().min(1, "must not be empty"),
  tasks: z.array(TaskSchema),
});

/** The body of GET /api/tasks/<id>: a task and its runs, newest first. Each run is one of the task's. */
export const TaskDetailSchema = z
  .object({ task: TaskSchema, runs: z.array(RunSchema) })
  .refine((detail) => detail.runs.every((run) => run.taskId === detail.task.id), {
    path: ["runs"],
    message: "must all belong to the task",
  });

/** The body of a successful document.undo: the document as Alfred now holds it. */
export const DocumentResultSchema = z.object({ document: DocumentSchema });

/** The body of GET /api/documents: the documents, newest updated first. */
export const DocumentListSchema = z.object({ documents: z.array(DocumentSchema) });

/**
 * The body of GET /api/documents/<id>: a document, its versions (newest first, the first being the current one), its
 * annotations and its revision runs (newest first). Each annotation and each run is one of the document's own.
 */
export const DocumentDetailSchema = z
  .object({
    document: DocumentSchema,
    versions: z.array(DocumentVersionSchema).min(1, "must have at least 1 version"),
    annotations: z.array(AnnotationSchema),
    runs: z.array(RunSchema),
  })
  .refine((detail) => detail.versions[0]?.version === detail.document.version, {
    path: ["versions"],
    message: "must start with the document's current version",
  })
  .refine((detail) => detail.annotations.every((annotation) => annotation.documentId === detail.document.id), {
    path: ["annotations"],
    message: "must all belong to the document",
  })
  .refine((detail) => detail.runs.every((run) => run.documentId === detail.document.id), {
    path: ["runs"],
    message: "must all belong to the document",
  });

/**
 * The body of a successful document.revise: the revision run and the batch as Alfred recorded it, each annotation
 * submitted to that run.
 */
export const RevisionAcceptedSchema = z
  .object({
    runId: RunIdSchema,
    annotations: z
      .array(AnnotationSchema)
      .min(1, "must have at least 1 annotation")
      .max(MAX_ANNOTATIONS_PER_REVISION, `must have at most ${MAX_ANNOTATIONS_PER_REVISION} annotations`),
  })
  .refine((accepted) => accepted.annotations.every((annotation) => annotation.state === "submitted" && annotation.runId === accepted.runId), {
    path: ["annotations"],
    message: "must all be submitted to the revision run",
  });

/** The body of a successful idea.reject: the idea as Alfred now holds it. */
export const IdeaResultSchema = z.object({ idea: IdeaSchema });

/**
 * The body of a successful idea.accept: the idea, now accepted, and the task it made. The task is an idea's: its
 * origin is idea, and its id is the idea's taskId.
 */
export const IdeaAcceptedSchema = z
  .object({ idea: IdeaSchema, task: TaskSchema })
  .refine((accepted) => accepted.idea.taskId === accepted.task.id, {
    path: ["idea", "taskId"],
    message: "must be the id of the task",
  })
  .refine((accepted) => accepted.task.origin === "idea", {
    path: ["task", "origin"],
    message: "must be idea",
  });

/** The body of a successful idea.generate: the generation run, queued or running. */
export const IdeaGenerationAcceptedSchema = z.object({ runId: RunIdSchema });

/**
 * The body of GET /api/ideas: every idea Alfred keeps, newest created first, and the generation run while one is
 * queued or running.
 */
export const IdeaListSchema = z.object({
  ideas: z.array(IdeaSchema),
  generatingRunId: RunIdSchema.optional(),
});

/** The body of POST /api/uploads: the file Alfred saved under inbox/. */
export const UploadResultSchema = z.object({
  file: FileRefSchema.safeExtend({ path: InboxPathSchema, kind: FileKindSchema }),
});

/** The body of any error response. */
export const ErrorResponseSchema = z.object({ error: z.string() });

// The server part of a pairing is an origin with no path, query, fragment or trailing slash: https, or http on
// 127.0.0.1 or localhost (any port), for local work with no TLS.
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);
function isServerOrigin(text: string): boolean {
  try {
    const url = new URL(text);
    if (url.origin !== text) return false;
    return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  } catch {
    return false;
  }
}

/** The QR code the app scans to pair: where Alfred is, the Cloudflare Access service token and the device token. */
export const PairingSchema = z.strictObject({
  version: z.literal(1),
  server: z
    .string()
    .refine(isServerOrigin, "must be an https:// origin, or an http:// origin on 127.0.0.1 or localhost, with no path, query or trailing slash"),
  access: z.strictObject({
    clientId: z.string().regex(/^[A-Za-z0-9_-]+\.access$/, "must be a Cloudflare Access client id ending in .access"),
    clientSecret: z.string().min(1).max(256),
  }),
  device: z.strictObject({
    id: RunIdSchema,
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "must be 43 characters of base64url"),
  }),
});

/** The APNs device token the app registers for push notifications. */
export const PushRegistrationSchema = z.strictObject({
  token: z.string().regex(/^[0-9a-f]{64,200}$/, "must be a lowercase hex APNs device token"),
  environment: z.enum(["development", "production"]),
});

// A file the owner attaches names no document: a delivery registers those, so a command's file has no documentId or version.
const CommandFileSchema = z.object({ path: InboxPathSchema, kind: FileKindSchema.optional() });

const CommandFilesSchema = z
  .array(CommandFileSchema)
  .min(1, "must not be empty")
  .max(MAX_MESSAGE_FILES, `must have at most ${MAX_MESSAGE_FILES} files`);

// Text is "" only beside files. Otherwise it must not be blank, and it is at most MAX_TEXT_CHARS characters.
const CommandTextSchema = z
  .string()
  .refine((text) => text === "" || text.trim() !== "", "must not be blank")
  .refine((text) => [...text].length <= MAX_TEXT_CHARS, `must be at most ${MAX_TEXT_CHARS} characters`);

export const MessageSendSchema = z
  .strictObject({
    type: z.literal("message.send"),
    clientId: ClientIdSchema,
    text: CommandTextSchema,
    files: CommandFilesSchema.optional(),
  })
  .refine((command) => command.text !== "" || command.files !== undefined, {
    path: ["text"],
    message: "must not be empty unless files are attached",
  });

export const RunStopSchema = z.strictObject({
  type: z.literal("run.stop"),
  runId: RunIdSchema,
});

// An answer is 1 to MAX_ANSWER_CHARS characters of text; the keys must be the texts of the question's questions,
// which only Alfred, who knows the open question, can check.
const AnswerTextSchema = z
  .string()
  .min(1, "must not be empty")
  .refine((text) => [...text].length <= MAX_ANSWER_CHARS, `must be at most ${MAX_ANSWER_CHARS} characters`);

export const QuestionAnswerSchema = z.strictObject({
  type: z.literal("question.answer"),
  questionId: QuestionIdSchema,
  answers: z.record(z.string(), AnswerTextSchema).refine((answers) => Object.keys(answers).length > 0, "must answer at least one question"),
});

export const TaskCreateSchema = z.strictObject({
  type: z.literal("task.create"),
  title: TaskTitleSchema,
  brief: TaskBriefSchema,
  schedule: ScheduleCommandSchema,
  model: ModelSchema.optional(),
  budgetUsd: TaskBudgetSchema.optional(),
});

const TASK_CHANGE_KEYS = ["title", "brief", "schedule", "model", "budgetUsd", "status"] as const;

// A task.update changes at least one field, so an empty one is refused.
export const TaskUpdateSchema = z
  .strictObject({
    type: z.literal("task.update"),
    taskId: TaskIdSchema,
    title: TaskTitleSchema.optional(),
    brief: TaskBriefSchema.optional(),
    schedule: ScheduleCommandSchema.optional(),
    model: ModelSchema.optional(),
    budgetUsd: TaskBudgetSchema.optional(),
    status: TaskStatusSchema.optional(),
  })
  .refine((command) => TASK_CHANGE_KEYS.some((key) => command[key] !== undefined), "must change at least one field besides taskId");

export const TaskRunSchema = z.strictObject({
  type: z.literal("task.run"),
  taskId: TaskIdSchema,
});

/** Revises a document in place: a revision run takes the batch. `version` is the version the owner annotated. */
export const DocumentReviseSchema = z.strictObject({
  type: z.literal("document.revise"),
  documentId: DocumentIdSchema,
  version: VersionSchema,
  annotations: z
    .array(AnnotationDraftSchema)
    .min(1, "must have at least 1 annotation")
    .max(MAX_ANNOTATIONS_PER_REVISION, `must have at most ${MAX_ANNOTATIONS_PER_REVISION} annotations`),
});

/** Undoes the latest revision of a document, named by the revision run that made it. */
export const DocumentUndoSchema = z.strictObject({
  type: z.literal("document.undo"),
  documentId: DocumentIdSchema,
  runId: RunIdSchema,
});

/**
 * Accepts an idea as a task. `title`, `brief`, `model` and `budgetUsd` are the task's, as the owner confirmed them in
 * the app's task form. With a schedule the task runs on it; without one it is a one-time task that runs at once.
 */
export const IdeaAcceptSchema = z.strictObject({
  type: z.literal("idea.accept"),
  ideaId: IdeaIdSchema,
  title: TaskTitleSchema,
  brief: TaskBriefSchema,
  schedule: ScheduleCommandSchema.optional(),
  model: ModelSchema,
  budgetUsd: TaskBudgetSchema,
});

/** Rejects an idea with a reason, and a note of 1 to 500 characters if the owner gives one. */
export const IdeaRejectSchema = z.strictObject({
  type: z.literal("idea.reject"),
  ideaId: IdeaIdSchema,
  reason: RejectionReasonSchema,
  note: IdeaNoteSchema.optional(),
});

/** Asks Alfred to generate ideas now. */
export const IdeaGenerateSchema = z.strictObject({ type: z.literal("idea.generate") });

export const CommandSchema = z.discriminatedUnion("type", [
  MessageSendSchema,
  RunStopSchema,
  QuestionAnswerSchema,
  TaskCreateSchema,
  TaskUpdateSchema,
  TaskRunSchema,
  DocumentReviseSchema,
  DocumentUndoSchema,
  IdeaAcceptSchema,
  IdeaRejectSchema,
  IdeaGenerateSchema,
]);

export type Channel = z.infer<typeof ChannelSchema>;
export type FileRef = z.infer<typeof FileRefSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type Run = z.infer<typeof RunSchema>;
export type Step = z.infer<typeof StepSchema>;
export type Question = z.infer<typeof QuestionSchema>;
export type QuestionAsked = z.infer<typeof QuestionAskedSchema>;
export type QuestionAnswered = z.infer<typeof QuestionAnsweredSchema>;
export type Event = z.infer<typeof EventSchema>;
export type LiveEvent = z.infer<typeof LiveEventSchema>;
export type RunList = z.infer<typeof RunListSchema>;
export type RunDetail = z.infer<typeof RunDetailSchema>;
export type UploadResult = z.infer<typeof UploadResultSchema>;
export type Schedule = z.infer<typeof ScheduleSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type TaskResult = z.infer<typeof TaskResultSchema>;
export type TaskList = z.infer<typeof TaskListSchema>;
export type TaskDetail = z.infer<typeof TaskDetailSchema>;
export type TaskCreate = z.infer<typeof TaskCreateSchema>;
export type TaskUpdate = z.infer<typeof TaskUpdateSchema>;
export type Document = z.infer<typeof DocumentSchema>;
export type DocumentVersion = z.infer<typeof DocumentVersionSchema>;
export type Annotation = z.infer<typeof AnnotationSchema>;
export type AnnotationTarget = z.infer<typeof AnnotationTargetSchema>;
export type DocumentResult = z.infer<typeof DocumentResultSchema>;
export type DocumentList = z.infer<typeof DocumentListSchema>;
export type DocumentDetail = z.infer<typeof DocumentDetailSchema>;
export type RevisionAccepted = z.infer<typeof RevisionAcceptedSchema>;
export type DocumentRevise = z.infer<typeof DocumentReviseSchema>;
export type DocumentUndo = z.infer<typeof DocumentUndoSchema>;
export type Idea = z.infer<typeof IdeaSchema>;
export type IdeaKind = z.infer<typeof IdeaKindSchema>;
export type IdeaState = z.infer<typeof IdeaStateSchema>;
export type RejectionReason = z.infer<typeof RejectionReasonSchema>;
export type Rejection = z.infer<typeof RejectionSchema>;
export type IdeaResult = z.infer<typeof IdeaResultSchema>;
export type IdeaAccepted = z.infer<typeof IdeaAcceptedSchema>;
export type IdeaGenerationAccepted = z.infer<typeof IdeaGenerationAcceptedSchema>;
export type IdeaList = z.infer<typeof IdeaListSchema>;
export type IdeaAccept = z.infer<typeof IdeaAcceptSchema>;
export type IdeaReject = z.infer<typeof IdeaRejectSchema>;
export type IdeaGenerate = z.infer<typeof IdeaGenerateSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type Pairing = z.infer<typeof PairingSchema>;
export type PushRegistration = z.infer<typeof PushRegistrationSchema>;
export type Command = z.infer<typeof CommandSchema>;

export type ParseCommandResult = { ok: true; command: Command } | { ok: false; error: string };

const COMMAND_TYPES: ReadonlySet<string> = new Set(CommandSchema.options.map((option) => option.shape.type.value));

/** Parses a command from a client. On failure, `error` is one line of English. */
export function parseCommand(json: unknown): ParseCommandResult {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { ok: false, error: "command must be a JSON object" };
  }
  const { type } = json as { type?: unknown };
  if (typeof type !== "string") return { ok: false, error: "command has no type" };
  if (!COMMAND_TYPES.has(type)) return { ok: false, error: `unknown command ${type}` };

  const result = CommandSchema.safeParse(json);
  if (result.success) return { ok: true, command: result.data };
  const [issue] = result.error.issues;
  const where = issue && issue.path.length > 0 ? `${issue.path.map(String).join(".")}: ` : "";
  return { ok: false, error: `${where}${issue?.message ?? "invalid command"}` };
}
