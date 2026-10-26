// Revision runs on a fake channel and a fake agent, with a real git dir and a document store of their own: no model is
// called, nothing is sent anywhere.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import type { Annotation, DocumentRevise, Message, Run } from "../api/schema.ts";
import type { Outbound } from "../channels.ts";
import type { Document } from "../api/schema.ts";
import type { Documents } from "../documents/register.ts";

// Schedules are local times: pin the zone before any date is made, so the result does not depend on the machine.
process.env.TZ = "Asia/Taipei";
// store.ts and config.ts read these at import time, so set them before loading the modules under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-revision-runs-")));
const workspace = path.join(tmp, "workspace");
Object.assign(process.env, {
  ALFRED_WORKSPACE: workspace,
  ALFRED_STATE_DIR: path.join(tmp, "state"),
  ALFRED_ANTHROPIC_API_KEY: "sk-test",
  ALFRED_MEMORY_SCAN_MINUTES: "0",
  ALFRED_WORKBENCH: "",
  ALFRED_WORKBENCH_URL: "",
  ALFRED_DAILY_BUDGET_USD: "5",
});

const { createAgentHandler } = await import("./handler.ts");
const { EventLog } = await import("../events.ts");
const { DocumentStore } = await import("../documents/store.ts");
const { Versions } = await import("../documents/versions.ts");
const { deliverDocument } = await import("../documents/register.ts");
const { documentCommands } = await import("../documents/commands.ts");
const { TaskStore } = await import("../tasks/store.ts");
const { RunRecorder, readRunFile } = await import("../runs.ts");
const { RevisionAcceptedSchema, MessageSchema } = await import("../api/schema.ts");
const { notificationFor } = await import("../workbench/push.ts");
const { localDate } = await import("../files.ts");
const { TASK_TOOL_NAMES } = await import("./task-tools.ts");

const REPLY_TOOL = "mcp__alfred__reply_annotation";

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups) await cleanup();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Waits for `done`. The limit is generous: the commits at the end of a run run git, which a loaded machine makes slow. */
async function until(what: string, done: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** What a turn ends with: the reply of a successful result, or the fields of a result of another kind. */
type Ended = string | Record<string, unknown>;
type TurnFn = (prompt: string, signal: AbortSignal, options: Options) => Promise<Ended>;

interface Query {
  options: Options;
  prompts: string[];
}

/** Stands in for the SDK's query(): answers every message of the input with one result, in a turn of its own. */
function fakeAgent(turn: TurnFn = async (prompt) => `echo: ${prompt}`) {
  const queries: Query[] = [];
  const runQuery = ((params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => {
    const options = params.options ?? {};
    const signal = options.abortController?.signal ?? new AbortController().signal;
    const record: Query = { options, prompts: [] };
    queries.push(record);
    const outbox: object[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    let failure: unknown;
    const push = (message: object) => {
      outbox.push(message);
      wake?.();
    };
    void (async () => {
      for await (const message of params.prompt) {
        const prompt = String(message.message.content);
        record.prompts.push(prompt);
        push({ type: "system", subtype: "init", session_id: "sess-1" });
        const result = await turn(prompt, signal, options);
        push({
          type: "result",
          subtype: "success",
          is_error: false,
          result: typeof result === "string" ? result : "",
          num_turns: 1,
          total_cost_usd: 0,
          modelUsage: {},
          session_id: "sess-1",
          user_message_uuid: message.uuid,
          ...(typeof result === "string" ? {} : result),
        });
      }
    })()
      .catch((err: unknown) => (failure = err))
      .finally(() => {
        ended = true;
        wake?.();
      });
    async function* messages() {
      for (;;) {
        const next = outbox.shift();
        if (next) {
          yield next;
          continue;
        }
        if (ended) break;
        await new Promise<void>((resolve) => (wake = resolve));
      }
      if (failure) throw failure;
    }
    return Object.assign(messages(), {
      stopTask: async () => {},
      setModel: async () => {},
      interrupt: async () => ({ still_queued: [] }),
    });
  }) as unknown as typeof query;
  return {
    runQuery,
    queries,
    /** The queries of revision runs: those that are offered reply_annotation. */
    get revisionQueries(): Query[] {
      return queries.filter((q) => isRevision(q.options));
    },
    /** The queries of scheduled runs. */
    get taskQueries(): Query[] {
      return queries.filter((q) => q.options.persistSession === false && !isRevision(q.options));
    },
    get chatQueries(): Query[] {
      return queries.filter((q) => q.options.persistSession !== false);
    },
  };
}

const isRevision = (options: Options) => Boolean(options.allowedTools?.includes(REPLY_TOOL));
const isScheduled = (options: Options) => options.persistSession === false && !isRevision(options);

/** A turn that ends when the test says so, or when the run is aborted. */
function held() {
  const waiting: ((ended: Ended) => void)[] = [];
  return {
    turn: (_prompt: string, signal: AbortSignal) =>
      new Promise<Ended>((resolve, reject) => {
        waiting.push(resolve);
        signal.addEventListener(
          "abort",
          () => {
            const i = waiting.indexOf(resolve);
            if (i >= 0) waiting.splice(i, 1);
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }),
    get waiting() {
      return waiting.length;
    },
    release: (ended: Ended) => waiting.shift()?.(ended),
  };
}

/** A channel that records what it is asked to send. */
function fakeApp() {
  const texts: string[] = [];
  const out: Outbound = {
    channel: "app",
    async text(text) {
      texts.push(text);
    },
    async file(absPath, caption) {
      if (caption) texts.push(caption);
      return "file";
    },
  };
  return { out, texts };
}

// Tuesday 09:00 in Taipei.
const T0 = new Date("2026-10-27T01:00:00Z");
let clock = T0;
const minutesAfterStart = (n: number) => new Date(T0.getTime() + n * 60_000);

let stacks = 0;

/** A task store, an event log and a document store with a git dir of their own, on the tests' workspace. */
async function stack() {
  clock = T0;
  const dir = path.join(tmp, `stack-${stacks++}`);
  const events = new EventLog(path.join(dir, "events.jsonl"));
  const tasks = new TaskStore({ file: path.join(dir, "tasks.json"), events, now: () => clock });
  const gitDir = path.join(dir, "versions.git");
  const versions = new Versions({ workspace, gitDir });
  await versions.init();
  const store = new DocumentStore({ file: path.join(dir, "documents.json"), events });
  const git = (...args: string[]) => execFileSync("git", [`--git-dir=${gitDir}`, `--work-tree=${workspace}`, ...args], { encoding: "utf8" }).trim();
  const documents: Documents = { versions, store };
  return { dir, events, tasks, stateFile: path.join(dir, "agent-state.json"), documents, store, git };
}
type Stack = Awaited<ReturnType<typeof stack>>;

let files = 0;
/** A file delivered as a document, as `deliver` does: written, committed and registered. */
async function deliver(s: Stack, content: string, extra: { name?: string; ext?: string; runId?: string; taskId?: string } = {}): Promise<Document> {
  const rel = `reports/rev-${files++}-${extra.name ?? "doc"}.${extra.ext ?? "md"}`;
  const abs = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  const delivered = await deliverDocument(s.documents, { path: rel, abs, size: Buffer.byteLength(content), runId: extra.runId, taskId: extra.taskId });
  assert.ok(delivered, "the file is versioned");
  const document = s.store.get(delivered.documentId);
  assert.ok(document);
  return document;
}

const NOTE = "# 海边小记\n\n清晨的海面很平静，几只海鸥在沙滩上走来走去。\n\n中午的阳光有点刺眼。\n";

const passage = (quote: string, comment: string, prefix = "", suffix = "") => ({ target: { kind: "passage" as const, quote, prefix, suffix }, comment });
const whole = (comment: string) => ({ target: { kind: "document" as const }, comment });
const batchOf = (document: Document, ...annotations: DocumentRevise["annotations"]): DocumentRevise => ({
  type: "document.revise",
  documentId: document.id,
  version: document.version,
  annotations: annotations.length ? annotations : [whole("整体再顺一顺")],
});
/** A batch of three, the way the app sends one: two passages and a comment on the whole document. */
const threeOf = (document: Document) =>
  batchOf(
    document,
    passage("几只海鸥", "改成一群海鸥", "清晨的海面很平静，", "在沙滩上走来走去"),
    passage("阳光有点刺眼", "写得具体一点", "中午的", "。"),
    whole("结尾加一句收束"),
  );

/** A handler on the stack, a fake channel and a fake agent. */
function start(s: Stack, options: { turn?: TurnFn; taskPollMs?: number; documents?: Documents | null; stateFile?: string; tasks?: boolean } = {}) {
  const app = fakeApp();
  const agent = fakeAgent(options.turn);
  const handler = createAgentHandler({
    out: app.out,
    events: s.events,
    stateFile: options.stateFile ?? s.stateFile,
    runQuery: agent.runQuery,
    ...(options.tasks === false ? {} : { tasks: s.tasks }),
    taskPollMs: options.taskPollMs,
    documents: options.documents === null ? undefined : (options.documents ?? s.documents),
  });
  cleanups.push(() => handler.shutdown());
  const messages = (): Message[] => s.events.readSince(0).flatMap((e) => (e.type === "message.created" ? [e.data] : []));
  const outbound = (): Message[] => messages().filter((m) => m.direction === "out");
  const runs = (): Run[] => s.events.readSince(0).flatMap((e) => (e.type === "run.updated" ? [e.data] : []));
  /** The last state of every run, oldest first. */
  const lastRuns = (): Run[] => [...new Map(runs().map((r) => [r.id, r])).values()];
  const revisionRuns = (): Run[] => lastRuns().filter((r) => r.kind === "revision");
  const revisionRun = (id: string): Run | undefined => lastRuns().find((r) => r.id === id);
  /** The messages of a revision run. */
  const messagesOf = (runId: string): Message[] => outbound().filter((m) => m.runId === runId);
  /** The annotations of a batch, in the owner's order. */
  const annotationsOf = (runId: string): Annotation[] => s.store.list().flatMap((d) => s.store.annotations(d.id)).filter((a) => a.runId === runId);
  const state = (): Record<string, unknown> => {
    try {
      return (JSON.parse(fs.readFileSync(options.stateFile ?? s.stateFile, "utf8")) as Record<string, Record<string, unknown>>).owner ?? {};
    } catch {
      return {};
    }
  };
  const send = (text: string) => handler.submit({ text, files: [] });
  /** Submits a batch and returns the accepted body; fails the test when it is refused. */
  const revise = (command: DocumentRevise) => {
    const reply = handler.reviseDocument(command);
    assert.ok(reply.ok, reply.ok ? "" : `${reply.status} ${reply.error}`);
    return reply.body;
  };
  /** The run is over: ended, and the message that says so is posted. */
  const over = (runId: string) => {
    const run = revisionRun(runId);
    return run !== undefined && run.status !== "running" && run.status !== "queued";
  };
  const posted = (runId: string) => over(runId) && messagesOf(runId).length > 0;
  return { handler, app, agent, messages, outbound, runs, lastRuns, revisionRuns, revisionRun, messagesOf, annotationsOf, state, send, revise, over, posted };
}

/** The ids of the annotations a revision prompt lists, in its order. */
const idsOf = (prompt: string): string[] => [...prompt.matchAll(/^\d+\. annotation ([2-9a-hjkmnp-z]{6})\b/gm)].map((m) => m[1] ?? "");

interface Result {
  content: { type: string; text: string }[];
  isError?: boolean;
}

/** Alfred's tools in these options, by name. */
function registeredTools(options: Options): string[] {
  const server = options.mcpServers?.alfred as unknown as { instance: { _registeredTools: Record<string, unknown> } };
  return Object.keys(server.instance._registeredTools);
}

/** Calls one of Alfred's tools, as the agent of the query with these options would. */
async function call(options: Options, name: string, args: Record<string, unknown>): Promise<Result> {
  const server = options.mcpServers?.alfred as unknown as {
    instance: { _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }> };
  };
  const tool = server.instance._registeredTools[name];
  assert.ok(tool, name);
  return (await tool.handler(args, {})) as Result;
}
const textOf = (result: Result) => result.content.map((c) => c.text).join("\n");

/** Answers the annotations a prompt lists, except those at the indexes in `skip`; each reply names its annotation. */
async function answer(prompt: string, options: Options, skip: number[] = []): Promise<void> {
  for (const [i, id] of idsOf(prompt).entries()) {
    if (skip.includes(i)) continue;
    const result = await call(options, "reply_annotation", { annotationId: id, reply: `已处理 ${id}` });
    assert.ok(!result.isError, textOf(result));
  }
}

/** Writes a file in the workspace and tells the run's hooks, as the SDK does after a Write. */
async function wrote(options: Options, rel: string, content: string): Promise<void> {
  fs.mkdirSync(path.dirname(path.join(workspace, rel)), { recursive: true });
  fs.writeFileSync(path.join(workspace, rel), content);
  const hook = { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: rel }, tool_response: {}, tool_use_id: "toolu_w" };
  for (const matcher of options.hooks?.PostToolUse ?? []) {
    for (const h of matcher.hooks) await h(hook as never, "toolu_w", { signal: new AbortController().signal });
  }
}

/** The reason the query's PreToolUse hooks give for denying a tool call, or undefined when they let it through. */
async function denial(options: Options, tool: string, input: Record<string, unknown>, agent?: { id: string; type: string }): Promise<string | undefined> {
  const hookInput = {
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: input,
    tool_use_id: "toolu_1",
    ...(agent ? { agent_id: agent.id, agent_type: agent.type } : {}),
  };
  for (const matcher of options.hooks?.PreToolUse ?? []) {
    for (const hook of matcher.hooks) {
      const out = (await hook(hookInput as never, "toolu_1", { signal: new AbortController().signal })) as {
        hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
      };
      if (out.hookSpecificOutput?.permissionDecision === "deny") return out.hookSpecificOutput.permissionDecisionReason ?? "";
    }
  }
  return undefined;
}

/** A one-time task whose time comes `after` minutes after the start; with the clock moved past it, the task is due. */
function oneTime(s: Stack, title: string, extra: Record<string, unknown> = {}, after = 1) {
  return s.tasks.create(
    { title, brief: `Brief of ${title}`, schedule: { kind: "once", at: minutesAfterStart(after).toISOString() }, ...extra },
    "manual",
  );
}

/** Starts a handler whose task run holds the lane, and returns it with the hold. */
async function behindATaskRun(s: Stack, revisionTurn: TurnFn = async (prompt, _signal, options) => (await answer(prompt, options), "改好了。")) {
  const hold = held();
  const task = oneTime(s, "晨报");
  clock = minutesAfterStart(2);
  const t = start(s, {
    turn: (prompt, signal, options) => (isRevision(options) ? revisionTurn(prompt, signal, options) : isScheduled(options) ? hold.turn(prompt, signal) : Promise.resolve(`echo: ${prompt}`)),
  });
  await until("the task run to start", () => hold.waiting === 1);
  return { t, hold, task };
}

test("a batch is accepted with its run and its annotations, the run is queued behind a task run that is live, and then it runs", async () => {
  const s = await stack();
  const document = await deliver(s, NOTE);
  const { t, hold } = await behindATaskRun(s);

  const body = t.revise(threeOf(document));
  assert.ok(RevisionAcceptedSchema.safeParse(body).success, "the answer fits the contract");
  assert.deepEqual(
    body.annotations.map((a) => [a.comment, a.state, a.runId, a.version, a.documentId]),
    [
      ["改成一群海鸥", "submitted", body.runId, document.version, document.id],
      ["写得具体一点", "submitted", body.runId, document.version, document.id],
      ["结尾加一句收束", "submitted", body.runId, document.version, document.id],
    ],
    "recorded in the owner's order, each submitted to the run",
  );
  assert.equal(s.store.revisionOf(document.id), body.runId);

  const queued = t.revisionRun(body.runId);
  assert.ok(queued);
  assert.deepEqual([queued.kind, queued.status, queued.documentId, queued.title, queued.taskId], ["revision", "queued", document.id, "修订「海边小记」", undefined]);
  await sleep(100);
  assert.equal(t.agent.revisionQueries.length, 0, "it waits for the lane");
  assert.equal(t.agent.queries.length, 1, "only the task run has started");

  hold.release("晨报好了");
  await until("the revision run to be over", () => t.posted(body.runId));
  assert.equal(t.revisionRun(body.runId)?.status, "done");
  assert.deepEqual(
    t.agent.queries.map((q) => isRevision(q.options)),
    [false, true],
    "the task run first, then the revision run",
  );
  assert.deepEqual(
    t.annotationsOf(body.runId).map((a) => a.state),
    ["resolved", "resolved", "resolved"],
  );
});

test("revision runs wait their turn in the order they arrived, one at a time", async () => {
  const s = await stack();
  const first = await deliver(s, NOTE, { name: "first" });
  const second = await deliver(s, NOTE, { name: "second" });
  const hold = held();
  const t = start(s, { turn: (prompt, signal, options) => (isRevision(options) ? hold.turn(prompt, signal) : Promise.resolve("ok")) });

  const a = t.revise(batchOf(first));
  const b = t.revise(batchOf(second));
  await until("the first run to start", () => hold.waiting === 1);
  await sleep(50);
  assert.equal(t.agent.revisionQueries.length, 1, "one at a time");
  assert.deepEqual([t.revisionRun(a.runId)?.status, t.revisionRun(b.runId)?.status], ["running", "queued"]);
  assert.match(t.agent.revisionQueries[0]?.prompts[0] ?? "", /整体再顺一顺/);

  hold.release("一");
  await until("the second run to start", () => hold.waiting === 1 && t.agent.revisionQueries.length === 2);
  assert.equal(t.revisionRun(a.runId)?.status === "running", false, "the first is over");
  hold.release("二");
  await until("both runs to be over", () => t.posted(a.runId) && t.posted(b.runId));
});

test("every refusal is answered with its status and message, and leaves no run, no annotation and no query", async () => {
  const s = await stack();
  const document = await deliver(s, NOTE);
  const html = await deliver(s, "<title>报告</title><p>x</p>", { ext: "html", name: "report" });
  const { t, hold } = await behindATaskRun(s);
  const first = t.revise(batchOf(document));
  const runsBefore = t.revisionRuns().length;
  const annotationsBefore = s.store.list().flatMap((d) => s.store.annotations(d.id)).length;

  const refused = (command: DocumentRevise) => {
    const reply = t.handler.reviseDocument(command);
    assert.equal(reply.ok, false);
    return reply.ok ? undefined : reply;
  };
  assert.deepEqual(refused({ ...batchOf(document), documentId: "zzzzzz" }), { ok: false, status: 404, error: "no such document" });
  assert.deepEqual(refused({ ...batchOf(html), version: "a".repeat(40) }), { ok: false, status: 409, error: "the document has changed since; reload it" });
  assert.deepEqual(refused(batchOf(document, whole("再来一批"))), { ok: false, status: 409, error: "a revision of this document is queued or running" });
  assert.deepEqual(refused(batchOf(html, passage("x", "改"))), { ok: false, status: 400, error: "only Markdown and text documents take passage annotations" });

  assert.equal(t.revisionRuns().length, runsBefore, "a refused batch leaves no run in the run list");
  assert.equal(s.store.list().flatMap((d) => s.store.annotations(d.id)).length, annotationsBefore, "and no annotation");
  assert.equal(s.store.revisionOf(html.id), undefined);
  assert.equal(s.store.revisionOf(document.id), first.runId, "the first batch is still the document's");

  // A whole-document comment on an HTML document is fine.
  const ok = t.revise(batchOf(html, whole("标题再大一点")));
  assert.ok(ok.runId);
  hold.release("好");
  await until("both runs to be over", () => t.posted(first.runId) && t.posted(ok.runId));
});

test("over the daily cap a batch is refused with 409, and nothing is recorded", async () => {
  const s = await stack();
  const document = await deliver(s, NOTE);
  fs.mkdirSync(path.dirname(s.stateFile), { recursive: true });
  fs.writeFileSync(s.stateFile, JSON.stringify({ owner: { model: "sonnet", sessionCostUsd: 0, totalCostUsd: 5, spendDay: localDate(), spendDayUsd: 5 } }));
  const t = start(s);

  assert.deepEqual(t.handler.reviseDocument(batchOf(document)), { ok: false, status: 409, error: "today's spend cap is reached" });
  assert.equal(t.revisionRuns().length, 0);
  assert.deepEqual(s.store.annotations(document.id), []);
  assert.equal(s.store.revisionOf(document.id), undefined);
  // The cap is checked before the document: it is the same answer for a document that does not exist.
  assert.equal(t.handler.reviseDocument({ ...batchOf(document), documentId: "zzzzzz" }).ok, false);
  await sleep(50);
  assert.equal(t.agent.queries.length, 0);
});

test("a handler without documents refuses a batch, and the command wrapper hands the batch to the handler", async () => {
  const s = await stack();
  const document = await deliver(s, NOTE);
  const without = start(s, { documents: null });
  assert.deepEqual(without.handler.reviseDocument(batchOf(document)), { ok: false, status: 404, error: "no such document" });

  const t = start(s);
  const reply = await documentCommands(t.handler).revise(batchOf(document));
  assert.ok(reply.ok);
  await until("the run to be over", () => t.posted(reply.ok ? reply.body.runId : ""));
});

test("the model and the cap: a task's document has the task's; a chat's, the model of the run that delivered it first; any other, sonnet and $2", async () => {
  const s = await stack();
  const task = s.tasks.create({ title: "周报", brief: "b", schedule: { kind: "daily", time: "23:00" }, model: "opus", budgetUsd: 3.5 }, "manual");
  const record = (model: string) => {
    const r = new RunRecorder({ kind: "task", title: "chat", model, events: s.events });
    r.finish("done");
    return r.id;
  };
  const taskDoc = await deliver(s, NOTE, { name: "task", taskId: task.id });
  const opusDoc = await deliver(s, NOTE, { name: "opus", runId: record("claude-opus-5-5") });
  const haikuFirst = await deliver(s, NOTE, { name: "haiku-first", runId: record("claude-haiku-5-5") });
  // Delivered again on opus: the first delivery decides.
  fs.writeFileSync(path.join(workspace, haikuFirst.path), `${NOTE}\n新的一段。\n`);
  const again = await deliverDocument(s.documents, {
    path: haikuFirst.path,
    abs: path.join(workspace, haikuFirst.path),
    size: 100,
    runId: record("claude-opus-5-5"),
  });
  assert.ok(again);
  const haikuDoc = s.store.get(haikuFirst.id);
  assert.ok(haikuDoc);
  assert.equal(s.store.versions(haikuDoc.id)?.filter((v) => v.reason === "delivered").length, 2);
  const unknownModel = await deliver(s, NOTE, { name: "unknown-model", runId: record("some-other-model") });
  const noRun = await deliver(s, NOTE, { name: "no-run" });
  const lostRun = await deliver(s, NOTE, { name: "lost-run", runId: "zzzzzz" });

  const t = start(s);
  const expected: [Document, string, number][] = [
    [taskDoc, "claude-opus-5-5", 3.5],
    [opusDoc, "claude-opus-5-5", 2],
    [haikuDoc, "claude-haiku-5-5", 2],
    [unknownModel, "claude-sonnet-5-5", 2],
    [noRun, "claude-sonnet-5-5", 2],
    [lostRun, "claude-sonnet-5-5", 2],
  ];
  const ids: string[] = [];
  for (const [document] of expected) ids.push(t.revise(batchOf(document)).runId);
  await until("all the runs to be over", () => ids.every((id) => t.posted(id)));
  assert.equal(t.agent.revisionQueries.length, expected.length);
  for (const [i, [document, model, budget]] of expected.entries()) {
    const options = t.agent.revisionQueries[i]?.options;
    assert.equal(options?.model, model, document.path);
    assert.equal(options?.maxBudgetUsd, budget, document.path);
    assert.equal(t.revisionRun(ids[i] ?? "")?.model, model, "the run's record has it too");
  }
  const taskRun = t.revisionRun(ids[0] ?? "");
  assert.equal(taskRun?.taskId, task.id, "the run of a task's document carries the task");
  assert.equal(t.revisionRun(ids[1] ?? "")?.taskId, undefined);
});

test("a revision run is unattended: a session of its own that is not kept, no questions, no background subagents, memory, skills and rules read-only, no task tools", async () => {
  const s = await stack();
  const document = await deliver(s, NOTE);
  const t = start(s);
  const { runId } = t.revise(batchOf(document));
  await until("the run to be over", () => t.posted(runId));
  await t.send("你好");
  await until("the chat run to start", () => t.agent.chatQueries.length === 1);

  const options = t.agent.revisionQueries[0]?.options;
  const chat = t.agent.chatQueries[0]?.options;
  assert.ok(options && chat);
  assert.equal(options.resume, undefined);
  assert.equal(options.persistSession, false, "no transcript, so nothing to resume or to memory-scan");
  assert.ok(Array.isArray(options.tools) && !options.tools.includes("AskUserQuestion"));
  assert.equal(options.canUseTool, undefined);
  assert.doesNotMatch(String(options.systemPrompt), /AskUserQuestion/);
  assert.ok(options.allowedTools?.every((name) => !TASK_TOOL_NAMES.includes(name)), "a run of a document manages no tasks");
  assert.ok(registeredTools(options).every((name) => !name.startsWith("task_")));

  for (const [tool, input] of [
    ["Write", { file_path: "memory/x.md" }],
    ["Edit", { file_path: "ALFRED.md" }],
    ["Write", { file_path: "skills/weekly/SKILL.md" }],
  ] as [string, Record<string, unknown>][]) {
    assert.match((await denial(options, tool, input)) ?? "", /read-only/, `${tool} ${JSON.stringify(input)}`);
    assert.equal(await denial(chat, tool, input), undefined, `chat may ${tool} ${JSON.stringify(input)}`);
  }
  assert.equal(await denial(options, "Write", { file_path: document.path }), undefined, "the document itself may be written");
  const agentCall = { subagent_type: "collector", description: "读一页", prompt: "read it" };
  assert.match((await denial(options, "Agent", { ...agentCall, run_in_background: true })) ?? "", /run_in_background: false/);
  assert.equal(await denial(options, "Agent", { ...agentCall, run_in_background: false }), undefined, "a foreground subagent works as in chat");
});

test("the chat goes on while a revision run is live, and the run's spend counts toward the day and not the session", async () => {
  const s = await stack();
  const document = await deliver(s, NOTE);
  const hold = held();
  const t = start(s, { turn: (prompt, signal, options) => (isRevision(options) ? hold.turn(prompt, signal) : Promise.resolve(`echo: ${prompt}`)) });
  const { runId } = t.revise(batchOf(document));
  await until("the revision run to start", () => hold.waiting === 1);

  await t.send("你好");
  await until("the chat reply", () => t.messages().some((m) => m.direction === "out" && m.text === "echo: 你好"));
  assert.equal(t.revisionRun(runId)?.status, "running", "the revision run is still live");

  hold.release({ result: "好了", total_cost_usd: 0.25, modelUsage: { "claude-sonnet-5-5": { costUSD: 0.25 } } });
  await until("the revision run to be over", () => t.posted(runId));
  const state = t.state();
  assert.equal(state.totalCostUsd, 0.25);
  assert.equal(state.spendDay, localDate());
  assert.equal(state.spendDayUsd, 0.25, "it counts toward the daily cap");
  assert.ok(!state.sessionCostUsd, "the chat session's figure is untouched");
  assert.equal(state.sessionId, "sess-1", "so is the session, which is the chat's own");
  assert.equal(readRunFile(runId)?.costUsd, 0.25, "and the spend is on the run's record");
});

test("the first message names the document, the version, the batch with every quote and its context, and what to do", async () => {
  const s = await stack();
  const document = await deliver(s, NOTE, { ext: "md", name: "prompt" });
  const t = start(s);
  const body = t.revise(
    batchOf(
      document,
      passage("几只海鸥", "改成一群海鸥\n并写出它们在做什么", "清晨的海面很平静，", "在沙滩上走来走去"),
      whole("结尾加一句收束"),
      passage("中午的阳光有点刺眼", "写得具体一点", "\n\n", "。\n"),
    ),
  );
  await until("the run's first message", () => t.agent.revisionQueries[0]?.prompts.length === 1);
  const prompt = t.agent.revisionQueries[0]?.prompts[0] ?? "";

  assert.ok(prompt.includes(document.path) && prompt.includes("海边小记") && prompt.includes("markdown") && prompt.includes(document.version), "the document: path, title, kind, version");
  assert.match(prompt, /in place/i);
  assert.ok(prompt.includes(`under the same path`), "under the same path");
  assert.match(prompt, /not watching/);
  assert.match(prompt, /ask no questions/i);
  assert.match(prompt, /assumption/);
  assert.match(prompt, /reply_annotation/);
  assert.match(prompt, /every annotation/i);
  assert.match(prompt, /decide not to act/i);
  assert.match(prompt, /short final message/i);
  assert.deepEqual(idsOf(prompt), body.annotations.map((a) => a.id), "every annotation, in the owner's order");
  for (const needle of ["几只海鸥", "清晨的海面很平静，", "在沙滩上走来走去", "中午的阳光有点刺眼", "结尾加一句收束", "写得具体一点"]) {
    assert.ok(prompt.includes(needle), needle);
  }
  assert.ok(prompt.includes(JSON.stringify("改成一群海鸥\n并写出它们在做什么")), "a comment of several lines is one quoted string, so it cannot pass for the list");
  assert.ok(prompt.indexOf("几只海鸥") < prompt.indexOf("结尾加一句收束") && prompt.indexOf("结尾加一句收束") < prompt.indexOf("中午的阳光有点刺眼"), "in the owner's order");
  assert.equal(prompt.match(/on the whole document/g)?.length, 1);
  assert.equal(prompt.match(/on a passage/g)?.length, 2);
  await until("the run to be over", () => t.posted(body.runId));
});

test("reply_annotation answers an annotation of this run; another run's, an answered one, an unknown one and a blank reply are refused with the reason", async () => {
  const s = await stack();
  const document = await deliver(s, NOTE, { name: "mine" });
  const other = await deliver(s, NOTE, { name: "other" });
  const results: Record<string, Result> = {};
  const { t, hold } = await behindATaskRun(s, async (prompt, _signal, options) => {
    if (!prompt.includes(document.path)) return (await answer(prompt, options), "好");
    const [a, b, c] = idsOf(prompt);
    assert.ok(a && b && c);
    const otherId = t.annotationsOf(otherRun).at(0)?.id ?? "";
    results.ok = await call(options, "reply_annotation", { annotationId: a, reply: "  已改成「一群海鸥」。  " });
    results.again = await call(options, "reply_annotation", { annotationId: a, reply: "再答一次" });
    results.blank = await call(options, "reply_annotation", { annotationId: b, reply: "  \n " });
    results.unknown = await call(options, "reply_annotation", { annotationId: "zzzzzz", reply: "?" });
    results.foreign = await call(options, "reply_annotation", { annotationId: otherId, reply: "不是我的" });
    results.tooLong = await call(options, "reply_annotation", { annotationId: b, reply: "长".repeat(4001) });
    results.b = await call(options, "reply_annotation", { annotationId: b, reply: "不改，因为原文已经具体。" });
    results.c = await call(options, "reply_annotation", { annotationId: c, reply: "已加。" });
    return "完成";
  });
  const mine = t.revise(threeOf(document));
  const otherRun = t.revise(batchOf(other)).runId;
  hold.release("好");
  await until("both runs to be over", () => t.posted(mine.runId) && t.posted(otherRun));

  assert.ok(!results.ok?.isError);
  assert.match(textOf(results.ok as Result), /2 annotation/, "it says how many still wait");
  const [a, b, c] = t.annotationsOf(mine.runId);
  assert.deepEqual([a?.state, a?.reply], ["resolved", "已改成「一群海鸥」。"], "the reply is trimmed");
  assert.deepEqual([b?.state, b?.reply], ["resolved", "不改，因为原文已经具体。"]);
  assert.equal(c?.state, "resolved");
  assert.match(textOf(results.b as Result), /1 annotation/);
  assert.match(textOf(results.c as Result), /every annotation|all/i);

  const refusals: [string, RegExp][] = [
    ["again", /already/i],
    ["blank", /empty|blank/i],
    ["unknown", /no annotation/i],
    ["foreign", /not (in|part of) this/i],
    ["tooLong", /4000/],
  ];
  for (const [name, why] of refusals) {
    const result = results[name];
    assert.ok(result?.isError, `${name} is a tool error`);
    assert.match(textOf(result), why, name);
  }
  assert.equal(t.annotationsOf(otherRun)[0]?.state === "resolved", true, "the other run answered its own");
  assert.notEqual(t.annotationsOf(otherRun)[0]?.reply, "不是我的", "and the foreign reply was not recorded");
});

test("only a revision run has reply_annotation: the chat, a task run and a subagent do not", async () => {
  const s = await stack();
  const document = await deliver(s, NOTE);
  const { t, hold, task } = await behindATaskRun(s);
  const { runId } = t.revise(batchOf(document));
  await t.send("你好");
  await until("the chat run to start", () => t.agent.chatQueries.length === 1);
  hold.release("好");
  await until("the revision run to be over", () => t.posted(runId));

  const revision = t.agent.revisionQueries[0]?.options;
  const scheduled = t.agent.taskQueries[0]?.options;
  const chat = t.agent.chatQueries[0]?.options;
  assert.ok(revision && scheduled && chat && task);
  assert.ok(registeredTools(revision).includes("reply_annotation"));
  assert.ok(revision.allowedTools?.includes(REPLY_TOOL));
  for (const [what, options] of [["the chat", chat], ["a task run", scheduled]] as [string, Options][]) {
    assert.ok(!registeredTools(options).includes("reply_annotation"), what);
    assert.ok(!options.allowedTools?.includes(REPLY_TOOL), what);
  }
  const input = { annotationId: "zzzzzz", reply: "x" };
  assert.equal(await denial(revision, REPLY_TOOL, input), undefined, "the run's own agent may");
  assert.match((await denial(revision, REPLY_TOOL, input, { id: "agent-1", type: "general-purpose" })) ?? "", /Subagents may not/);
  assert.deepEqual(registeredTools(revision).sort(), ["deliver", "generate_image", "move_file", "render_pdf", "reply_annotation"]);
});

test("reply_annotation stops with the run: once the run is stopped it records nothing", async () => {
  const s = await stack();
  const document = await deliver(s, NOTE);
  let late: Result | undefined;
  const t = start(s, {
    turn: async (prompt, signal, options) => {
      await new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true })));
      late = await call(options, "reply_annotation", { annotationId: idsOf(prompt)[0] ?? "", reply: "太晚了" });
      throw new Error("aborted");
    },
  });
  const { runId } = t.revise(batchOf(document));
  await until("the run's first message", () => t.agent.revisionQueries[0]?.prompts.length === 1);
  assert.equal(await t.handler.stopRun(runId), true);
  await until("the run to be over", () => t.posted(runId));
  await until("the late call", () => late !== undefined);

  assert.ok(late?.isError);
  assert.match(textOf(late as Result), /stopped/i);
  assert.equal(t.annotationsOf(runId)[0]?.state, "returned", "the reply was not recorded");
});

test("the run's commit makes a revised version of the document, and other documents the run changed stay changed", async () => {
  const s = await stack();
  const document = await deliver(s, NOTE, { name: "revised" });
  const side = await deliver(s, "# 旁注\n\n原文\n", { name: "side" });
  const t = start(s, {
    turn: async (prompt, _signal, options) => {
      await wrote(options, document.path, `${NOTE}\n结尾：潮水退了。\n`);
      await wrote(options, side.path, "# 旁注\n\n改过了\n");
      await wrote(options, "notes/rev-scratch.md", "草稿\n");
      await answer(prompt, options);
      return "加了结尾。";
    },
  });
  const { runId } = t.revise(batchOf(document));
  await until("the run to be over", () => t.posted(runId));

  const versions = s.store.versions(document.id) ?? [];
  assert.deepEqual(versions.map((v) => [v.reason, v.runId]), [["revised", runId], ["delivered", undefined]]);
  const revised = s.store.get(document.id);
  assert.equal(revised?.version, versions[0]?.version);
  assert.notEqual(revised?.version, document.version);
  assert.equal(s.git("log", "-1", "--format=%s", revised?.version ?? ""), `Run ${runId}: 修订「海边小记」`);
  assert.deepEqual(
    (s.store.versions(side.id) ?? []).map((v) => [v.reason, v.runId, v.version]),
    [["changed", runId, revised?.version], ["delivered", undefined, side.version]],
    "a document the run touched besides the revised one is changed, in the same commit",
  );
  assert.match(fs.readFileSync(path.join(workspace, document.path), "utf8"), /潮水退了/);
  const sent = t.messagesOf(runId)[0]?.files[0];
  assert.deepEqual(sent, { path: document.path, kind: "file", documentId: document.id, version: revised?.version });
});

test("a run that changes nothing makes no version, and its message names the version the document is at", async () => {
  const s = await stack();
  const document = await deliver(s, NOTE, { name: "unchanged" });
  const commits = s.git("rev-list", "--count", "HEAD");
  const t = start(s, { turn: async (prompt, _signal, options) => (await answer(prompt, options), "不用改。") });
  const { runId } = t.revise(batchOf(document));
  await until("the run to be over", () => t.posted(runId));

  assert.equal(s.store.versions(document.id)?.length, 1);
  assert.equal(s.store.get(document.id)?.version, document.version);
  assert.equal(s.git("rev-list", "--count", "HEAD"), commits, "no commit");
  const [message] = t.messagesOf(runId);
  assert.deepEqual(message?.files, [{ path: document.path, kind: "file", documentId: document.id, version: document.version }]);
  assert.match(message?.text ?? "", /^修订了「海边小记」：1 条已回复\n\n不用改。$/);
});

test("all answered: the run is done, the annotations are resolved with their replies, and the message counts them", async () => {
  const s = await stack();
  const document = await deliver(s, NOTE);
  const t = start(s, { turn: async (prompt, _signal, options) => (await answer(prompt, options), "改了两处，加了结尾。") });
  const { runId, annotations } = t.revise(threeOf(document));
  await until("the run to be over", () => t.posted(runId));

  assert.equal(t.revisionRun(runId)?.status, "done");
  const after = t.annotationsOf(runId);
  assert.deepEqual(after.map((a) => [a.id, a.state, a.reply, a.returnReason]), annotations.map((a) => [a.id, "resolved", `已处理 ${a.id}`, undefined]));
  assert.equal(t.messagesOf(runId).length, 1);
  assert.equal(t.messagesOf(runId)[0]?.text, "修订了「海边小记」：3 条已回复\n\n改了两处，加了结尾。");
  assert.equal(s.store.revisionOf(document.id), undefined, "the document can take another batch");
  const next = t.revise(batchOf(s.store.get(document.id) as Document));
  assert.ok(next.runId, "and does");
  await until("the next run to be over", () => t.posted(next.runId));
});

test("one annotation left unanswered goes back to the owner as unanswered, and the message counts it", async () => {
  const s = await stack();
  const document = await deliver(s, NOTE);
  const t = start(s, { turn: async (prompt, _signal, options) => (await answer(prompt, options, [1]), "改了两处。") });
  const { runId } = t.revise(threeOf(document));
  await until("the run to be over", () => t.posted(runId));

  assert.equal(t.revisionRun(runId)?.status, "done");
  assert.deepEqual(t.annotationsOf(runId).map((a) => [a.state, a.returnReason, a.reply === undefined]), [
    ["resolved", undefined, false],
    ["returned", "unanswered", true],
    ["resolved", undefined, false],
  ]);
  assert.equal(t.messagesOf(runId)[0]?.text, "修订了「海边小记」：2 条已回复，1 条退回\n\n改了两处。");
});

test("a run stopped while it works ends stopped: what it answered stays, the rest goes back as stopped, and one message says so", async () => {
  const s = await stack();
  const document = await deliver(s, NOTE);
  const hold = held();
  const answeredOne = Promise.withResolvers<void>();
  const t = start(s, {
    turn: async (prompt, signal, options) => {
      await answer(prompt, options, [1, 2]);
      answeredOne.resolve();
      return hold.turn(prompt, signal);
    },
  });
  const { runId } = t.revise(threeOf(document));
  await answeredOne.promise;
  await until("the turn to be held", () => hold.waiting === 1);

  assert.equal(await t.handler.stopRun(runId), true);
  await until("the run to be over", () => t.posted(runId));
  assert.equal(t.revisionRun(runId)?.status, "stopped");
  assert.deepEqual(t.annotationsOf(runId).map((a) => [a.state, a.returnReason]), [["resolved", undefined], ["returned", "stopped"], ["returned", "stopped"]]);
  assert.equal(t.messagesOf(runId).length, 1);
  assert.equal(t.messagesOf(runId)[0]?.text, "修订「海边小记」已停止");
  assert.deepEqual(t.messagesOf(runId)[0]?.files, [{ path: document.path, kind: "file", documentId: document.id, version: document.version }]);
  assert.equal(await t.handler.stopRun(runId), false, "an ended run cannot be stopped again");
  assert.equal(s.store.revisionOf(document.id), undefined);
});

test("a run stopped while it is queued ends stopped without ever starting, and its annotations go back as stopped", async () => {
  const s = await stack();
  const document = await deliver(s, NOTE);
  const { t, hold, task } = await behindATaskRun(s);
  const { runId } = t.revise(threeOf(document));
  assert.equal(t.revisionRun(runId)?.status, "queued");

  assert.equal(await t.handler.stopRun(runId), true);
  assert.equal(t.revisionRun(runId)?.status, "stopped");
  assert.deepEqual(t.annotationsOf(runId).map((a) => [a.state, a.returnReason]), [["returned", "stopped"], ["returned", "stopped"], ["returned", "stopped"]]);
  assert.equal(t.messagesOf(runId)[0]?.text, "修订「海边小记」已停止");
  assert.equal(await t.handler.stopRun(runId), false);
  assert.equal(s.store.revisionOf(document.id), undefined);

  hold.release("晨报");
  await until("the task run to be over", () => s.tasks.get(task.id)?.lastRunId !== undefined && t.lastRuns().some((r) => r.taskId === task.id && r.status === "done"));
  await sleep(100);
  assert.equal(t.agent.revisionQueries.length, 0, "the stopped run never ran");
});

test("the run's id stops it from the chat as well, queued or running", async () => {
  const s = await stack();
  const running = await deliver(s, NOTE, { name: "running" });
  const queued = await deliver(s, NOTE, { name: "queued" });
  const hold = held();
  const t = start(s, { turn: (prompt, signal, options) => (isRevision(options) ? hold.turn(prompt, signal) : Promise.resolve("ok")) });
  const a = t.revise(batchOf(running));
  const b = t.revise(batchOf(queued));
  await until("the first run to start", () => hold.waiting === 1);

  await t.send(`/status`);
  const status = t.app.texts.at(-1) ?? "";
  assert.match(status, new RegExp(`修订运行 ${a.runId}：修订「${running.title}」，进行中`));
  assert.match(status, /排队的修订运行：1 个/);

  await t.send(`/stop ${b.runId}`);
  assert.equal(t.revisionRun(b.runId)?.status, "stopped");
  assert.match(t.app.texts.at(-1) ?? "", new RegExp(`已停止修订运行 ${b.runId}`));
  await t.send(`/stop ${a.runId}`);
  await until("the first run to be over", () => t.posted(a.runId));
  assert.equal(t.revisionRun(a.runId)?.status, "stopped");
  assert.ok(t.app.texts.some((text) => text.includes(`已停止修订运行 ${a.runId}`)));
});

test("a run that ends in an error result is failed: the annotations go back as failed and one message says why", async () => {
  const s = await stack();
  const document = await deliver(s, NOTE);
  const t = start(s, {
    turn: async (prompt, _signal, options) => {
      await answer(prompt, options, [1, 2]);
      return { subtype: "error_max_budget_usd", is_error: true, errors: [], total_cost_usd: 2.1 };
    },
  });
  const { runId } = t.revise(threeOf(document));
  await until("the run to be over", () => t.posted(runId));

  const run = t.revisionRun(runId);
  assert.equal(run?.status, "failed");
  assert.match(run?.error ?? "", /\$2\.00/);
  assert.deepEqual(t.annotationsOf(runId).map((a) => [a.state, a.returnReason]), [["resolved", undefined], ["returned", "failed"], ["returned", "failed"]]);
  assert.equal(t.messagesOf(runId).length, 1);
  assert.match(t.messagesOf(runId)[0]?.text ?? "", /^修订「海边小记」失败：花费超过这次运行的上限 \$2\.00/);
  assert.equal(t.messagesOf(runId)[0]?.files[0]?.documentId, document.id);
  assert.equal(t.state().spendDayUsd, 2.1, "what it spent counts");
});

test("a run that throws is failed, and its message carries the error", async () => {
  const s = await stack();
  const document = await deliver(s, NOTE);
  const t = start(s, {
    turn: async () => {
      throw new Error("the process died");
    },
  });
  const { runId } = t.revise(batchOf(document));
  await until("the run to be over", () => t.posted(runId));

  assert.equal(t.revisionRun(runId)?.status, "failed");
  assert.deepEqual(t.annotationsOf(runId).map((a) => [a.state, a.returnReason]), [["returned", "failed"]]);
  assert.equal(t.messagesOf(runId).length, 1);
  assert.match(t.messagesOf(runId)[0]?.text ?? "", /^修订「海边小记」失败：.*the process died/);
});

test("a run whose turn is an error with a changed document still commits what it wrote, as a revised version", async () => {
  const s = await stack();
  const document = await deliver(s, NOTE, { name: "half" });
  const t = start(s, {
    turn: async (_prompt, _signal, options) => {
      await wrote(options, document.path, `${NOTE}\n写了一半\n`);
      return { subtype: "error_during_execution", is_error: true, errors: ["the model failed"], total_cost_usd: 0.1 };
    },
  });
  const { runId } = t.revise(batchOf(document));
  await until("the run to be over", () => t.posted(runId));

  assert.equal(t.revisionRun(runId)?.status, "failed");
  assert.deepEqual((s.store.versions(document.id) ?? []).map((v) => [v.reason, v.runId]), [["revised", runId], ["delivered", undefined]]);
  assert.equal(t.messagesOf(runId)[0]?.files[0]?.version, s.store.get(document.id)?.version, "the message names the version the run made");
});

test("a batch still queued when the day's cap is reached does not start: the run fails with the cap's message", async () => {
  const s = await stack();
  const document = await deliver(s, NOTE);
  const { t, hold } = await behindATaskRun(s, async () => {
    throw new Error("a run over the cap must not start");
  });
  const { runId } = t.revise(batchOf(document));
  // The task run ahead of the batch spends the day's cap.
  hold.release({ result: "好", total_cost_usd: 6, modelUsage: { "claude-sonnet-5-5": { costUSD: 6 } } });
  await until("the run to be over", () => t.posted(runId));

  assert.equal(t.agent.revisionQueries.length, 0, "no query");
  assert.equal(t.revisionRun(runId)?.status, "failed");
  assert.deepEqual(t.annotationsOf(runId).map((a) => [a.state, a.returnReason]), [["returned", "failed"]]);
  assert.match(t.messagesOf(runId)[0]?.text ?? "", /^修订「海边小记」失败：.*每日上限 \$5\.00/);
});

test("a shutdown ends the running revision as lost and sends its annotations back as failed; a queued one too; nothing is posted", async () => {
  const s = await stack();
  const running = await deliver(s, NOTE, { name: "running" });
  const queued = await deliver(s, NOTE, { name: "queued" });
  const hold = held();
  const t = start(s, { turn: (prompt, signal, options) => (isRevision(options) ? hold.turn(prompt, signal) : Promise.resolve("ok")) });
  const a = t.revise(batchOf(running));
  const b = t.revise(batchOf(queued));
  await until("the first run to start", () => hold.waiting === 1);

  await t.handler.shutdown();
  await until("the running one to end", () => t.revisionRun(a.runId)?.status === "lost");
  assert.equal(t.revisionRun(b.runId)?.status, "lost", "the queued one is lost as well");
  assert.deepEqual(t.annotationsOf(a.runId).map((x) => [x.state, x.returnReason]), [["returned", "failed"]]);
  assert.deepEqual(t.annotationsOf(b.runId).map((x) => [x.state, x.returnReason]), [["returned", "failed"]]);
  await sleep(100);
  assert.deepEqual(t.outbound(), [], "no message");
  assert.equal(t.agent.revisionQueries.length, 1);
  assert.equal(s.store.revisionOf(running.id), undefined);
  assert.equal(t.handler.reviseDocument(batchOf(s.store.get(running.id) as Document)).ok, false, "and a batch is refused while Alfred stops");
  const lost = ((t.state().lostRuns ?? []) as { id: string }[]).map((r) => r.id).sort();
  assert.deepEqual(lost, [a.runId, b.runId].sort(), "the owner's next message names both");
});

test("the message of a finished revision is a message of the run and its task, carries the file at its version, and pushes", async () => {
  const s = await stack();
  const task = s.tasks.create({ title: "周报", brief: "b", schedule: { kind: "daily", time: "23:00" } }, "manual");
  const document = await deliver(s, NOTE, { name: "message", taskId: task.id });
  const t = start(s, {
    turn: async (prompt, _signal, options) => {
      await wrote(options, document.path, `${NOTE}\n结尾。\n`);
      await answer(prompt, options);
      return "加了结尾。\n第二行也在。";
    },
  });
  const { runId } = t.revise(threeOf(document));
  await until("the run to be over", () => t.posted(runId));

  const event = s.events.readSince(0).find((e) => e.type === "message.created" && e.data.runId === runId);
  assert.ok(event && event.type === "message.created");
  const message = event.data;
  assert.ok(MessageSchema.safeParse(message).success);
  assert.deepEqual([message.direction, message.channel, message.runId, message.taskId, message.error], ["out", "app", runId, task.id, undefined]);
  assert.equal(message.text, "修订了「海边小记」：3 条已回复\n\n加了结尾。\n第二行也在。");
  const version = s.store.get(document.id)?.version;
  assert.notEqual(version, document.version);
  assert.deepEqual(message.files, [{ path: document.path, kind: "file", documentId: document.id, version }]);
  assert.equal(t.messagesOf(runId).length, 1, "one message");

  const note = notificationFor(event);
  assert.ok(note, "the push rule notifies it");
  assert.equal(note.runId, runId);
  assert.equal(note.eventId, event.id);
  assert.ok(note.aps.alert.body.startsWith("修订了「海边小记」：3 条已回复"));
  const stopped = notificationFor({ ...event, data: { ...message, text: "修订「海边小记」已停止" } });
  assert.equal(stopped?.aps.alert.body, "修订「海边小记」已停止");
});

test("the chat hears of a revision on its next message, once, and a command leaves the note for the one after", async () => {
  const s = await stack();
  const document = await deliver(s, NOTE, { name: "note" });
  const other = await deliver(s, NOTE, { name: "note-b" });
  const t = start(s, {
    turn: async (prompt, _signal, options) => {
      if (!isRevision(options)) return `echo: ${prompt}`;
      await answer(prompt, options, prompt.includes("不用管") ? [0] : []);
      return "改了两处。\n第二行不会进摘要。";
    },
  });
  const a = t.revise(batchOf(document, whole("结尾加一句收束"), whole("再润色")));
  await until("the first run to be over", () => t.posted(a.runId));
  const b = t.revise(batchOf(other, whole("不用管这条")));
  await until("the second run to be over", () => t.posted(b.runId));
  await until("the notes to be kept", () => Array.isArray(t.state().revisionDeliveries) && (t.state().revisionDeliveries as unknown[]).length === 2);

  await t.send("/help");
  assert.ok(Array.isArray(t.state().revisionDeliveries), "a command leaves the list for the next message");
  await t.send("改得怎么样？");
  await until("the chat run to start", () => t.agent.chatQueries.length === 1);
  const prompt = t.agent.chatQueries[0]?.prompts[0] ?? "";
  assert.ok(prompt.endsWith("\n\n改得怎么样？"), "the message comes last");
  for (const needle of ["海边小记", document.id, document.path, a.runId, b.runId, "改了两处。"]) assert.ok(prompt.includes(needle), needle);
  assert.ok(prompt.includes("answered 2, returned 0"), "what was answered");
  assert.ok(prompt.includes("answered 0, returned 1"), "and what went back");
  assert.ok(!prompt.includes("第二行不会进摘要"), "the first line only");
  assert.equal(t.state().revisionDeliveries, undefined, "the list is cleared");

  await until("the chat run to end", () => t.lastRuns().some((r) => r.kind === "task" && r.taskId === undefined && r.status === "done"));
  await t.send("谢谢");
  await until("the second chat run to start", () => t.agent.chatQueries.length === 2);
  assert.equal(t.agent.chatQueries[1]?.prompts[0], "谢谢", "without a note the prompt is unchanged");
});

test("a failed revision is told to the chat as well", async () => {
  const s = await stack();
  const document = await deliver(s, NOTE);
  const t = start(s, {
    turn: async () => {
      throw new Error("boom");
    },
  });
  const { runId } = t.revise(batchOf(document));
  await until("the run to be over", () => t.posted(runId));
  await until("the note to be kept", () => Array.isArray(t.state().revisionDeliveries));
  await t.send("怎么了？");
  await until("the chat run to start", () => t.agent.chatQueries.length === 1);
  const prompt = t.agent.chatQueries[0]?.prompts[0] ?? "";
  assert.ok(prompt.includes(runId) && /failed/.test(prompt) && prompt.includes("boom"), prompt);
});

test("after a crash the next start sends the annotations of a revision that was live back as failed", async () => {
  const s = await stack();
  const document = await deliver(s, NOTE);
  const hold = held();
  const first = start(s, { turn: (prompt, signal, options) => (isRevision(options) ? hold.turn(prompt, signal) : Promise.resolve("ok")) });
  const { runId } = first.revise(batchOf(document));
  await until("the run to start", () => hold.waiting === 1);

  // Another process: the same files, the first one never got to say anything.
  const store = new DocumentStore({ file: path.join(s.dir, "documents.json"), events: s.events });
  assert.equal(store.annotation(first.annotationsOf(runId)[0]?.id ?? "")?.state, "submitted");
  start(s, { documents: { versions: s.documents.versions, store }, stateFile: path.join(s.dir, "second-state.json") });
  assert.deepEqual(store.annotations(document.id).map((a) => [a.state, a.returnReason]), [["returned", "failed"]]);
  assert.equal(store.revisionOf(document.id), undefined);
});
