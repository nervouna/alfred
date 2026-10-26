// Run records for the workbench. A run is one execution of the agent (a task,
// or a memory scan). Alfred writes the records under $STATE_DIR/workbench and
// the workbench only reads them:
//   runs.jsonl      one line per finished run, kept for good
//   runs/<id>.json  one file per live or recent run with its step timeline,
//                   rewritten at most every few seconds and pruned after 30 days
//   status.json     Alfred's heartbeat

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { type EventLog, sharedEventLog } from "./events.ts";
import { describeError, log } from "./log.ts";
import { STATE_DIR, readJson, writeJson } from "./store.ts";

export const WORKBENCH_STATE_DIR = path.join(STATE_DIR, "workbench");
export const RUNS_LOG = path.join(WORKBENCH_STATE_DIR, "runs.jsonl");
export const RUN_FILES_DIR = path.join(WORKBENCH_STATE_DIR, "runs");
export const STATUS_FILE = path.join(WORKBENCH_STATE_DIR, "status.json");
export const TASKS_FILE = path.join(WORKBENCH_STATE_DIR, "tasks.json");
export const LOG_FILE = path.join(WORKBENCH_STATE_DIR, "alfred.log");

/** Run files are kept this long after the run ends; runs.jsonl keeps the record for good. */
export const RUN_FILE_DAYS = 30;
const WRITE_INTERVAL_MS = 2_000;
const MAX_STEPS = 400;
const DAY_MS = 86_400_000;

/** A subagent run is a background subagent a task started; it has a card of its own. */
export type RunKind = "task" | "scan" | "subagent" | "revision";
/** `queued`: a subagent waiting for a background slot. `lost`: the process ended while the run was live, e.g. a restart. */
export type RunStatus = "queued" | "running" | "done" | "stopped" | "failed" | "lost";

export interface RunFileChange {
  /** Workspace-relative path. */
  path: string;
  /** The tool that last wrote it, e.g. Write, Edit, move_file. */
  tool: string;
}

/** A send that failed, as an earlier version recorded it on the run. */
export interface Undelivered {
  /** A text reply, or a file the deliver tool sent. */
  kind: "reply" | "file";
  path?: string;
  at: string;
  error: string;
}

/** One line of runs.jsonl, and the head of a run file. */
export interface RunRecord {
  id: string;
  kind: RunKind;
  /** The task this run is a run of; chat runs have none. */
  taskId?: string;
  title: string;
  status: RunStatus;
  model?: string;
  sessionId?: string;
  /** For a subagent run: the run that started it, its role, and its SDK task id while it runs. */
  parentRunId?: string;
  role?: string;
  agentId?: string;
  /** True when costUsd is estimated from tokens rather than reported. */
  costEstimated?: boolean;
  startedAt: string;
  endedAt?: string;
  costUsd: number;
  modelCostUsd?: Record<string, number>;
  toolCalls: number;
  files: RunFileChange[];
  /** Failed sends recorded by an earlier version. Nothing writes it any more, but old records still carry it and still load. */
  undelivered?: Undelivered[];
  error?: string;
}

export interface RunStep {
  at: string;
  tool: string;
  detail: string;
  /** Set for a step a subagent took: its role. */
  agent?: string;
}

export interface RunFile extends RunRecord {
  updatedAt: string;
  steps: RunStep[];
}

/** Alfred's heartbeat, rewritten while it runs. Only these fields reach the workbench. */
export interface Heartbeat {
  pid: number;
  startedAt: string;
  updatedAt: string;
  memory: { rssBytes: number; cgroupBytes?: number; cgroupMaxBytes?: number };
  /** Set on a clean shutdown, so the workbench shows Alfred as down at once. */
  stoppedAt?: string;
}

// Ids are short and easy to type on a phone: no 0/o, 1/l/i, at least one digit
// and one letter, so a word in a message is never taken for one.
const ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const ID_LENGTH = 6;
const ID_PATTERN = /(?<![0-9a-z])[2-9a-hjkmnp-z]{6}(?![0-9a-z])/g;

function isIdShape(s: string): boolean {
  return /[2-9]/.test(s) && /[a-z]/.test(s);
}

export function newRunId(exists: (id: string) => boolean = (id) => fs.existsSync(runFilePath(id))): string {
  for (;;) {
    const bytes = crypto.randomBytes(ID_LENGTH);
    const id = Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
    if (isIdShape(id) && !exists(id)) return id;
  }
}

/** Candidate run ids in a message, lowercased and deduplicated, in order of appearance. */
export function runIdCandidates(text: string): string[] {
  const found = text.toLowerCase().match(ID_PATTERN) ?? [];
  return [...new Set(found.filter(isIdShape))];
}

export function runFilePath(id: string): string {
  return path.join(RUN_FILES_DIR, `${id}.json`);
}

export function readRunFile(id: string): RunFile | undefined {
  if (!/^[2-9a-hjkmnp-z]{6}$/.test(id)) return undefined;
  try {
    return readJson<RunFile>(runFilePath(id));
  } catch (err) {
    log.warn(`unreadable run file ${id}: ${describeError(err)}`);
    return undefined;
  }
}

/** Every record in runs.jsonl, oldest first. Unparsable lines are skipped. */
export function readRunLog(file = RUNS_LOG): RunRecord[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const records: RunRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as RunRecord);
    } catch {
      // A line cut short by a crash; the rest of the log is still good.
    }
  }
  return records;
}

/** The record of a run: its run file while it exists, else its line in runs.jsonl. */
export function findRun(id: string): RunRecord | undefined {
  return readRunFile(id) ?? readRunLog().findLast((r) => r.id === id);
}

/** One-line summary of a tool call's input for the step timeline. */
export function stepDetail(tool: string, input: Record<string, unknown>, workspace: string): string {
  const rel = (p: unknown) => (typeof p === "string" ? (path.isAbsolute(p) ? path.relative(workspace, p) || "." : p) : "");
  let detail: string;
  switch (tool) {
    case "WebSearch":
      detail = String(input.query ?? "");
      break;
    case "WebFetch":
      detail = String(input.url ?? "");
      break;
    case "Read":
    case "Write":
    case "Edit":
      detail = rel(input.file_path);
      break;
    case "Glob":
    case "Grep":
      detail = [input.pattern, input.path ?? input.glob].filter((v) => typeof v === "string" && v).join(" in ");
      break;
    case "Skill":
      detail = String(input.skill ?? "");
      break;
    case "Agent":
      detail = `${String(input.subagent_type ?? "?")}「${String(input.description ?? "")}」`;
      break;
    case "mcp__alfred__deliver":
      detail = rel(input.path);
      break;
    case "mcp__alfred__move_file":
      detail = `${rel(input.from)} → ${rel(input.to)}`;
      break;
    case "mcp__alfred__render_pdf":
      detail = rel(input.source);
      break;
    case "mcp__alfred__generate_image":
      detail = String(input.prompt ?? "");
      break;
    default:
      detail = "";
  }
  return detail.length > 160 ? `${detail.slice(0, 159)}…` : detail;
}

/** Display name of a tool in steps and file lists. */
export function toolName(tool: string): string {
  return tool.replace(/^mcp__alfred__/, "");
}

/**
 * Records one run: its run file while it is live, then its line in runs.jsonl.
 * Writes are throttled and never throw, so a full disk cannot break a task.
 */
export class RunRecorder {
  readonly id: string;
  private readonly file: RunFile;
  private readonly events: EventLog;
  private timer?: NodeJS.Timeout;
  private lastWrite = 0;
  private finished = false;
  /** Paths the run moved files away from. They leave `files`, but the run's commit must still record the removal. Not part of the run's record. */
  private readonly movedAway = new Set<string>();

  constructor(init: {
    kind: RunKind;
    title: string;
    model?: string;
    /** The task this run is a run of. */
    taskId?: string;
    id?: string;
    startedAt?: string;
    queued?: boolean;
    parentRunId?: string;
    role?: string;
    /** Where the run.updated events go; the shared event log by default. */
    events?: EventLog;
  }) {
    this.id = init.id ?? newRunId();
    this.events = init.events ?? sharedEventLog();
    const now = new Date().toISOString();
    this.file = {
      id: this.id,
      kind: init.kind,
      ...(init.taskId ? { taskId: init.taskId } : {}),
      title: init.title,
      status: init.queued ? "queued" : "running",
      model: init.model,
      ...(init.parentRunId ? { parentRunId: init.parentRunId } : {}),
      ...(init.role ? { role: init.role } : {}),
      startedAt: init.startedAt ?? now,
      updatedAt: now,
      costUsd: 0,
      toolCalls: 0,
      files: [],
      steps: [],
    };
    this.write();
    this.publish();
  }

  get record(): Readonly<RunFile> {
    return this.file;
  }

  get wroteFiles(): boolean {
    return this.file.files.length > 0;
  }

  /** The paths (workspace-relative) the run moved files away from, kept beside `files`: both are what its end commits. */
  get movedFrom(): readonly string[] {
    return [...this.movedAway];
  }

  /** A tool call of the run. Besides the timeline, it is published as a live run.step event (never stored in the log). */
  step(tool: string, detail: string, agent?: string): void {
    const step: RunStep = { at: new Date().toISOString(), tool: toolName(tool), detail, ...(agent ? { agent } : {}) };
    this.file.toolCalls++;
    this.file.steps.push(step);
    if (this.file.steps.length > MAX_STEPS) this.file.steps.splice(0, this.file.steps.length - MAX_STEPS);
    this.schedule();
    this.events.publish("run.step", { runId: this.id, step: { ...step } });
  }

  /** A file the run created or changed (workspace-relative); a later write replaces the tool. */
  wrote(relPath: string, tool: string): void {
    const name = toolName(tool);
    const existing = this.file.files.find((f) => f.path === relPath);
    if (existing) existing.tool = name;
    else this.file.files.push({ path: relPath, tool: name });
    this.schedule();
  }

  /** A file moved away: the old path leaves the list, and is kept in `movedFrom`. */
  moved(fromRel: string, toRel: string): void {
    this.file.files = this.file.files.filter((f) => f.path !== fromRel);
    this.movedAway.add(fromRel);
    this.wrote(toRel, "move_file");
  }

  update(patch: Partial<Pick<RunRecord, "title" | "model" | "role" | "sessionId" | "costUsd" | "modelCostUsd" | "agentId" | "costEstimated">>): void {
    Object.assign(this.file, patch);
    this.schedule();
  }

  /** A queued run gets its slot: it runs from now. */
  start(): void {
    if (this.file.status !== "queued") return;
    this.file.status = "running";
    this.file.startedAt = new Date().toISOString();
    this.write();
    this.publish();
  }

  /** Final state: the run file is written at once and the record appended to runs.jsonl. */
  finish(status: Exclude<RunStatus, "running">, error?: string): void {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.timer);
    this.file.status = status;
    this.file.endedAt = new Date().toISOString();
    if (error) this.file.error = error;
    this.write();
    appendRunLog(toRecord(this.file));
    this.publish();
  }

  /** Lifecycle changes only: the client sees the run's record in the event log. */
  private publish(): void {
    this.events.append("run.updated", toRecord(this.file));
  }

  private schedule(): void {
    if (this.finished || this.timer) return;
    const wait = Math.max(0, this.lastWrite + WRITE_INTERVAL_MS - Date.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.write();
    }, wait);
    this.timer.unref();
  }

  private write(): void {
    this.lastWrite = Date.now();
    this.file.updatedAt = new Date(this.lastWrite).toISOString();
    try {
      writeJson(runFilePath(this.id), this.file);
    } catch (err) {
      log.warn(`writing run file ${this.id} failed: ${describeError(err)}`);
    }
  }
}

function toRecord(file: RunFile): RunRecord {
  const { steps: _steps, updatedAt: _updatedAt, ...record } = file;
  return record;
}

export function appendRunLog(record: RunRecord, file = RUNS_LOG): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch (err) {
    log.warn(`appending run ${record.id} to the run log failed: ${describeError(err)}`);
  }
}

/** Ids of the runs that have a run file, without reading them. */
export function runFileIds(dir = RUN_FILES_DIR): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => /^[2-9a-hjkmnp-z]{6}\.json$/.test(n))
      .map((n) => n.slice(0, -5));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** Every run file, newest first. */
export function listRunFiles(dir = RUN_FILES_DIR): RunFile[] {
  const names = runFileIds(dir).map((id) => `${id}.json`);
  const files: RunFile[] = [];
  for (const name of names) {
    try {
      const f = readJson<RunFile>(path.join(dir, name));
      if (f) files.push(f);
    } catch {
      // Being rewritten or damaged; the next listing sees it again.
    }
  }
  return files.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/**
 * At startup: runs still marked running belonged to an earlier process, so they
 * are lost. Their files say so, runs.jsonl gets their record, and the event log
 * gets a run.updated for each. Returns them.
 */
export function markLostRuns(dir = RUN_FILES_DIR, logFile = RUNS_LOG, events: EventLog = sharedEventLog()): RunRecord[] {
  const lost: RunRecord[] = [];
  for (const f of listRunFiles(dir)) {
    if (f.status !== "running" && f.status !== "queued") continue;
    f.status = "lost";
    f.endedAt = f.updatedAt;
    f.error = "Alfred stopped while this run was live";
    try {
      writeJson(path.join(dir, `${f.id}.json`), f);
    } catch (err) {
      log.warn(`marking run ${f.id} lost failed: ${describeError(err)}`);
    }
    const record = toRecord(f);
    appendRunLog(record, logFile);
    events.append("run.updated", record);
    lost.push(record);
  }
  return lost;
}

/** Delete run files of runs that ended more than RUN_FILE_DAYS ago. Returns how many went. */
export function pruneRunFiles(now = Date.now(), dir = RUN_FILES_DIR): number {
  let pruned = 0;
  for (const f of listRunFiles(dir)) {
    const ended = Date.parse(f.endedAt ?? "");
    if (f.status === "running" || f.status === "queued" || Number.isNaN(ended) || now - ended < RUN_FILE_DAYS * DAY_MS) continue;
    try {
      fs.rmSync(path.join(dir, `${f.id}.json`), { force: true });
      pruned++;
    } catch (err) {
      log.warn(`pruning run file ${f.id} failed: ${describeError(err)}`);
    }
  }
  return pruned;
}

function readNumber(file: string): number | undefined {
  try {
    const value = Number(fs.readFileSync(file, "utf8").trim());
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Memory in use: the process, and its cgroup (the container) with the cap when cgroup v2 shows them. */
export function memoryUsage(): Heartbeat["memory"] {
  return {
    rssBytes: process.memoryUsage.rss(),
    cgroupBytes: readNumber("/sys/fs/cgroup/memory.current"),
    cgroupMaxBytes: readNumber("/sys/fs/cgroup/memory.max"),
  };
}

export function writeHeartbeat(beat: Heartbeat): void {
  try {
    writeJson(STATUS_FILE, beat);
  } catch (err) {
    log.warn(`writing the heartbeat failed: ${describeError(err)}`);
  }
}

/** The workbench shows Alfred as down when the heartbeat is older than 90 s. */
const HEARTBEAT_MS = 30_000;

/**
 * Writes Alfred's heartbeat now and every 30 s. The function it returns ends the beat and writes the mark
 * of a clean stop, so the workbench shows Alfred as down at once.
 */
export function startHeartbeat(startedAt = new Date()): () => void {
  const beat: Heartbeat = { pid: process.pid, startedAt: startedAt.toISOString(), updatedAt: "", memory: memoryUsage() };
  const write = (patch: Partial<Heartbeat> = {}) => {
    Object.assign(beat, patch, { updatedAt: new Date().toISOString(), memory: memoryUsage() });
    writeHeartbeat(beat);
  };
  write();
  const timer = setInterval(() => write(), HEARTBEAT_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    write({ stoppedAt: new Date().toISOString() });
  };
}
