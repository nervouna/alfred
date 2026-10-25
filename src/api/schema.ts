// The client API contract: the events Alfred emits, the commands it accepts and
// the objects they carry. The iOS client decodes the same shapes, and the JSON
// fixtures under fixtures/api/ (see its README.md) are what both sides test against.
//
// Events and the objects they carry ignore keys they do not know, so a newer
// Alfred can add fields. Commands are strict: Alfred rejects unknown command types and keys.

import { z } from "zod";

import type { RunKind, RunStatus } from "../runs.ts";

/** The command API's request body limit, in bytes. */
export const MAX_COMMAND_BYTES = 65_536;
const MAX_TEXT_CHARS = 20_000;

const IsoTimestampSchema = z.iso.datetime();
// The shape newRunId in src/runs.ts draws from: no 0, o, 1, l or i.
const RunIdSchema = z.string().regex(/^[2-9a-hjkmnp-z]{6}$/, "must be a six-character run id");
const ClientIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "must be 1-64 letters, digits, _ or -");

export const ChannelSchema = z.enum(["app", "wechat"]);

export const FileKindSchema = z.enum(["image", "voice", "video", "file"]);

export const FileRefSchema = z.object({
  path: z
    .string()
    .min(1, "must not be empty")
    .refine((path) => !path.startsWith("/"), "must not start with /")
    .refine((path) => !path.split("/").includes(".."), "must not contain a .. segment"),
  kind: FileKindSchema.optional(),
});

export const MessageSchema = z
  .object({
    id: z.string().min(1).max(64),
    channel: ChannelSchema,
    direction: z.enum(["in", "out"]),
    text: z.string(),
    files: z.array(FileRefSchema),
    at: IsoTimestampSchema,
    runId: RunIdSchema.optional(),
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

/** The client's view of a run record: the fields of RunRecord it shows, nothing else. */
export const RunSchema = z.object({
  id: RunIdSchema,
  kind: RunKindSchema,
  taskId: z.string().optional(),
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

const EventEnvelope = { id: z.int().positive(), at: IsoTimestampSchema };

export const EventSchema = z.discriminatedUnion("type", [
  z.object({ ...EventEnvelope, type: z.literal("message.created"), data: MessageSchema }),
  z.object({ ...EventEnvelope, type: z.literal("run.updated"), data: RunSchema }),
]);

const CommandTextSchema = z
  .string()
  .min(1, "must not be empty")
  .refine((text) => text.trim() !== "", "must not be blank")
  .refine((text) => [...text].length <= MAX_TEXT_CHARS, `must be at most ${MAX_TEXT_CHARS} characters`);

export const MessageSendSchema = z.strictObject({
  type: z.literal("message.send"),
  clientId: ClientIdSchema,
  text: CommandTextSchema,
});

export const RunStopSchema = z.strictObject({
  type: z.literal("run.stop"),
  runId: RunIdSchema,
});

export const CommandSchema = z.discriminatedUnion("type", [MessageSendSchema, RunStopSchema]);

export type Channel = z.infer<typeof ChannelSchema>;
export type FileRef = z.infer<typeof FileRefSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type Run = z.infer<typeof RunSchema>;
export type Event = z.infer<typeof EventSchema>;
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
