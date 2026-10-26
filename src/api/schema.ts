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
const MAX_TEXT_CHARS = 20_000;
const MAX_ANSWER_CHARS = 2000;

const IsoTimestampSchema = z.iso.datetime();
// The shape newRunId in src/runs.ts draws from: no 0, o, 1, l or i.
const RunIdSchema = z.string().regex(/^[2-9a-hjkmnp-z]{6}$/, "must be a six-character run id");
// A task id has the run id's alphabet and length.
const TaskIdSchema = z.string().regex(/^[2-9a-hjkmnp-z]{6}$/, "must be a six-character task id");
const ClientIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "must be 1-64 letters, digits, _ or -");
const QuestionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "must be 1-64 letters, digits, _ or -");

// "app" is the only channel Alfred uses now. The other is a retired one: its messages stay in the event log, so clients still read it.
export const ChannelSchema = z.enum(["app", "wechat"]);

export const FileKindSchema = z.enum(["image", "voice", "video", "file"]);

// A path relative to the workspace.
const WorkspacePathSchema = z
  .string()
  .min(1, "must not be empty")
  .refine((path) => !path.startsWith("/"), "must not start with /")
  .refine((path) => !path.split("/").includes(".."), "must not contain a .. segment");

export const FileRefSchema = z.object({
  path: WorkspacePathSchema,
  kind: FileKindSchema.optional(),
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

export const RunKindSchema = z.enum(["task", "scan", "subagent"]);
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

const EventEnvelope = { id: z.int().positive(), at: IsoTimestampSchema };

export const EventSchema = z.discriminatedUnion("type", [
  z.object({ ...EventEnvelope, type: z.literal("message.created"), data: MessageSchema }),
  z.object({ ...EventEnvelope, type: z.literal("run.updated"), data: RunSchema }),
  z.object({ ...EventEnvelope, type: z.literal("question.asked"), data: QuestionAskedSchema }),
  z.object({ ...EventEnvelope, type: z.literal("question.answered"), data: QuestionAnsweredSchema }),
  z.object({ ...EventEnvelope, type: z.literal("task.updated"), data: TaskSchema }),
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

/** The body of POST /api/uploads: the file Alfred saved under inbox/. */
export const UploadResultSchema = z.object({
  file: FileRefSchema.extend({ path: InboxPathSchema, kind: FileKindSchema }),
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

const CommandFileSchema = FileRefSchema.extend({ path: InboxPathSchema });

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

export const CommandSchema = z.discriminatedUnion("type", [
  MessageSendSchema,
  RunStopSchema,
  QuestionAnswerSchema,
  TaskCreateSchema,
  TaskUpdateSchema,
  TaskRunSchema,
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
