// The workbench: a read-only web view of Alfred's runs, files and state.
// The pages are GET only, server-rendered, no build step. Two listeners share
// one handler: TCP for the Cloudflare tunnel, where every request needs a valid
// Access JWT, and a 0600 Unix socket for an SSH-tunnel fallback.
//
// /api/ is the native app's way in. It takes GET and POST, and on every listener
// it wants a bearer token of a paired, unrevoked device (devices.ts). On the
// tunnel the Access JWT comes first, and may be the owner's or the app's
// service token's; the pages accept the owner's only. Its commands, event stream
// and uploads are forwarded to Alfred's command socket (forward.ts); its runs,
// tasks and workspace files are read here.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { resolveInside } from "../agent/guard.ts";
import { memoryList } from "../agent/memory-edit.ts";
import { loadMemories } from "../agent/memory.ts";
import { RULES_READ_MAX_BYTES, readRulesForOwner } from "../agent/rules.ts";
import { DocumentDetailSchema, PushRegistrationSchema, RunSchema, StepSchema } from "../api/schema.ts";
import type { DocumentDetail, DocumentList, Run, RunDetail, TaskDetail } from "../api/schema.ts";
import { apiSocketPath } from "../api/server.ts";
import { isTrashedPath, readDocumentFile } from "../documents/store.ts";
import { VERSIONS_GIT_DIR, Versions } from "../documents/versions.ts";
import { describeError, log } from "../log.ts";
import type { AccessVerifier } from "./access.ts";
import { allRuns, alfredStatus, listSessions, readIdeaList, readTaskList, readTranscript, runDetail, spendByDay, tailLog } from "./data.ts";
import { DeviceStore } from "./devices.ts";
import { forwardCommand, forwardEvents, forwardUpload, jsonError, jsonReply, readBody } from "./forward.ts";
import { html, trusted } from "./html.ts";
import type { Html } from "./html.ts";
import { renderMarkdown } from "./markdown.ts";
import {
  dirPage,
  errorPage,
  filePage,
  logsPage,
  memoryPage,
  overviewPage,
  reportPage,
  runPage,
  runsPage,
  sessionPage,
  sessionsPage,
  spendPage,
} from "./views.ts";
import type { DirEntry } from "./views.ts";

const BASE_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

/** Pages run only the copy-button script, by nonce. */
function pageCsp(nonce: string): string {
  return `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

/**
 * The report viewer carries no script of its own. Its policy is inherited by
 * the report's srcdoc frame: inline script and style run so charts draw, but
 * nothing loads from anywhere (no connect, no images or fonts but data:), and
 * the sandbox without allow-same-origin keeps the frame out of this origin.
 */
export const REPORT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Raw files never run as documents of this origin. */
const RAW_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const TEXT_EXTS = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".log", ".yaml", ".yml", ".xml", ".js", ".ts", ".py", ".sh", ".css"]);
const REPORT_EXTS = new Set([".html", ".htm", ".svg"]);
const HTML_EXTS = new Set([".html", ".htm"]);
const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
const MAX_INLINED_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_INLINED_TOTAL_BYTES = 24 * 1024 * 1024;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Response {
  status?: number;
  headers: Record<string, string>;
  /** A stream: a workspace file, or Alfred's event stream as it arrives. */
  body: string | Buffer | fs.ReadStream | http.IncomingMessage;
  /** The request body was not read to its end, so the connection closes once the response is sent. */
  closeConnection?: boolean;
}

function htmlResponse(markup: string, csp: string, status = 200): Response {
  return { status, headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": csp }, body: markup };
}

function disposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** A workspace file or directory by its workspace-relative path; `.git` stays hidden. */
function workspacePath(workspace: string, rel: string): { real: string; rel: string; stat: fs.Stats } {
  const real = resolveInside(workspace, rel || ".");
  if (!real) throw new HttpError(404, "不在工作区里。");
  const relative = path.relative(fs.realpathSync(workspace), real).split(path.sep).join("/");
  if (relative.split("/").includes(".git")) throw new HttpError(404, "找不到。");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch {
    throw new HttpError(404, "找不到这个文件。");
  }
  return { real, rel: relative, stat };
}

function listDir(real: string, rel: string): DirEntry[] {
  const entries: DirEntry[] = [];
  for (const d of fs.readdirSync(real, { withFileTypes: true })) {
    if (d.name === ".git") continue;
    const full = path.join(real, d.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue; // Dangling link.
    }
    entries.push({ name: d.name, rel: rel ? `${rel}/${d.name}` : d.name, dir: stat.isDirectory(), bytes: stat.size, modifiedAt: stat.mtimeMs });
  }
  return entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

function readPreview(real: string, stat: fs.Stats): string {
  if (stat.size > MAX_PREVIEW_BYTES) throw new HttpError(413, "文件太大，不能预览，请下载。");
  return fs.readFileSync(real, "utf8");
}

/**
 * Replace a report's relative image references with data: URIs, so the
 * sandboxed frame needs no request (and no Access cookie) to show them. Only
 * images inside the workspace are inlined; anything else stays as it is and
 * the frame's policy blocks it.
 */
export function inlineImages(markup: string, reportReal: string, workspace: string): string {
  let total = 0;
  return markup.replace(/(\s(?:src|href|xlink:href)\s*=\s*)(["'])([^"']*)\2/gi, (whole, attr: string, quote: string, value: string) => {
    const ext = path.extname(value.split(/[?#]/)[0] ?? "").toLowerCase();
    const type = IMAGE_TYPES[ext] ?? (ext === ".svg" ? "image/svg+xml" : undefined);
    if (!type || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//")) return whole;
    const real = resolveInside(workspace, path.join(path.dirname(reportReal), decodeURIComponent(value.split(/[?#]/)[0] ?? "")));
    if (!real) return whole;
    try {
      const stat = fs.statSync(real);
      if (!stat.isFile() || stat.size > MAX_INLINED_IMAGE_BYTES || total + stat.size > MAX_INLINED_TOTAL_BYTES) return whole;
      total += stat.size;
      return `${attr}${quote}data:${type};base64,${fs.readFileSync(real).toString("base64")}${quote}`;
    } catch {
      return whole;
    }
  });
}

function fileContent(ext: string, rel: string, real: string, stat: fs.Stats): Html {
  const raw = `/files/raw?path=${encodeURIComponent(rel)}`;
  if (ext === ".md" || ext === ".markdown") return html`<div class="card md">${trusted(renderMarkdown(readPreview(real, stat), rel))}</div>`;
  if (IMAGE_TYPES[ext]) return html`<img class="preview" src="${raw}" alt="${rel}">`;
  if (ext === ".pdf") return html`<p><a href="${raw}">打开 PDF</a></p>`;
  if (TEXT_EXTS.has(ext)) return html`<div class="card"><pre>${readPreview(real, stat)}</pre></div>`;
  return html`<p class="meta">这种文件不能预览，请下载。</p>`;
}

/** The content type a raw file is served as, by extension. Markup goes out as text, so it never runs as a document of this origin. */
function rawContentType(ext: string): string {
  if (IMAGE_TYPES[ext]) return IMAGE_TYPES[ext];
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".html" || ext === ".htm" || TEXT_EXTS.has(ext)) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function serveRaw(real: string, rel: string, stat: fs.Stats, download: boolean): Response {
  const ext = path.extname(real).toLowerCase();
  const name = path.basename(real);
  const headers: Record<string, string> = { "Content-Length": String(stat.size), "Content-Type": rawContentType(ext), "Content-Security-Policy": RAW_CSP };
  // A browser's PDF viewer does not run in a sandboxed document.
  if (ext === ".pdf") delete headers["Content-Security-Policy"];
  // Only images, PDFs and text open here; SVG and HTML, and anything unknown, download. An <img> still shows SVG.
  if (!IMAGE_TYPES[ext] && ext !== ".pdf" && !TEXT_EXTS.has(ext)) download = true;
  headers["Content-Disposition"] = disposition(download ? "attachment" : "inline", name);
  log.debug(`workbench raw ${rel}`);
  return { headers, body: fs.createReadStream(real) };
}

export interface HandlerOptions {
  workspace: string;
  /** Checks the Access JWT; undefined for the Unix socket and --dev. */
  access?: AccessVerifier;
  /** The paired devices /api/ authenticates against; the default store when omitted. */
  devices?: DeviceStore;
  /** Alfred's command socket for /api/ to forward to; ALFRED_API_SOCKET when omitted. */
  apiSocket?: string;
  /** Collects the event streams this handler opens, so that closing the workbench can end them. A new set when omitted. */
  streams?: Set<http.ServerResponse>;
}

const API_PREFIX = "/api/";
const BEARER = /^Bearer ([A-Za-z0-9_-]{1,256})$/i;
const RUN_PATH = /^\/api\/runs\/([2-9a-hjkmnp-z]{6})$/;
const TASK_PREFIX = "/api/tasks/";
/** A task id has the run id's alphabet and length. */
const TASK_ID = /^[2-9a-hjkmnp-z]{6}$/;
const DOCUMENT_PREFIX = "/api/documents/";
/** A document id has the run id's alphabet and length. */
const DOCUMENT_ID = /^[2-9a-hjkmnp-z]{6}$/;
/** A version is a commit id: 40 lowercase hex characters. */
const COMMIT_ID = /^[0-9a-f]{40}$/;
const FILE_PATH = "/api/files/";
/** How many runs GET /api/runs lists, newest first. */
const LISTED_RUNS = 100;
/** How many of a task's runs GET /api/tasks/<id> lists, newest first. */
const LISTED_TASK_RUNS = 50;
/** How many of a document's revision runs GET /api/documents/<id> lists, newest first. */
const LISTED_DOCUMENT_RUNS = 50;
/** The largest POST /api/push body: a registration is a token and an environment. */
const MAX_PUSH_BYTES = 4096;
/** On close, how long a request in flight gets to finish before its connection is cut. */
const CLOSE_GRACE_MS = 2000;

/** The device token in an Authorization header, or why there is none. */
function bearerToken(header: string | undefined): { token: string } | { reason: string } {
  if (!header) return { reason: "no Authorization header" };
  const token = BEARER.exec(header)?.[1];
  return token ? { token } : { reason: "malformed Authorization header" };
}

async function route(url: URL, workspace: string): Promise<Response> {
  const nonce = crypto.randomBytes(16).toString("base64");
  const now = Date.now();
  const p = url.pathname;
  const param = (k: string) => url.searchParams.get(k) ?? "";

  if (p === "/") {
    return htmlResponse(overviewPage({ status: alfredStatus(now), runs: allRuns(), now, nonce }), pageCsp(nonce));
  }
  if (p === "/runs") {
    const offset = Math.max(0, Number.parseInt(param("offset") || "0", 10) || 0);
    return htmlResponse(runsPage({ runs: allRuns(), offset, live: alfredStatus(now).up, now, nonce }), pageCsp(nonce));
  }
  const runMatch = /^\/runs\/([2-9a-hjkmnp-z]{6})$/.exec(p);
  if (runMatch?.[1]) {
    const id = runMatch[1];
    const detail = runDetail(id);
    if (!detail) throw new HttpError(404, "没有这个运行。");
    const children = allRuns().filter((r) => r.parentRunId === id).reverse();
    return htmlResponse(runPage({ ...detail, children, live: alfredStatus(now).up, now, nonce }), pageCsp(nonce));
  }
  if (p === "/spend") return htmlResponse(spendPage({ days: spendByDay(allRuns()) }), pageCsp(nonce));
  if (p === "/files") {
    const { real, rel, stat } = workspacePath(workspace, param("path"));
    if (!stat.isDirectory()) return { status: 302, headers: { Location: `/files/view?path=${encodeURIComponent(rel)}` }, body: "" };
    return htmlResponse(dirPage({ rel, entries: listDir(real, rel) }), pageCsp(nonce));
  }
  if (p === "/files/view") {
    const { real, rel, stat } = workspacePath(workspace, param("path"));
    if (stat.isDirectory()) return { status: 302, headers: { Location: `/files?path=${encodeURIComponent(rel)}` }, body: "" };
    const ext = path.extname(real).toLowerCase();
    if (REPORT_EXTS.has(ext)) {
      const srcdoc = inlineImages(readPreview(real, stat), real, workspace);
      return htmlResponse(reportPage({ rel, bytes: stat.size, modifiedAt: stat.mtimeMs, srcdoc }), REPORT_CSP);
    }
    return htmlResponse(filePage({ rel, bytes: stat.size, modifiedAt: stat.mtimeMs, content: fileContent(ext, rel, real, stat) }), pageCsp(nonce));
  }
  if (p === "/files/raw") {
    const { real, rel, stat } = workspacePath(workspace, param("path"));
    if (!stat.isFile()) throw new HttpError(404, "不是文件。");
    return serveRaw(real, rel, stat, param("download") === "1");
  }
  if (p === "/sessions") return htmlResponse(sessionsPage({ sessions: listSessions(workspace) }), pageCsp(nonce));
  const sessionMatch = /^\/sessions\/([0-9a-f-]{36})$/.exec(p);
  if (sessionMatch?.[1]) {
    const id = sessionMatch[1];
    const session = listSessions(workspace).find((s) => s.id === id);
    if (!session) throw new HttpError(404, "没有这个会话。");
    return htmlResponse(sessionPage({ id, ...readTranscript(session.file) }), pageCsp(nonce));
  }
  if (p === "/memory") return htmlResponse(memoryPage({ memories: loadMemories(workspace) }), pageCsp(nonce));
  if (p === "/logs") {
    const level = ["warn", "error"].includes(param("level")) ? param("level") : "all";
    const pattern = level === "error" ? / ERROR / : level === "warn" ? / (WARN|ERROR) / : undefined;
    const lines = tailLog(pattern ? 5000 : 500).filter((l) => !pattern || pattern.test(l)).slice(-500);
    return htmlResponse(logsPage({ lines, level }), pageCsp(nonce));
  }
  throw new HttpError(404, "没有这个页面。");
}

function accessToken(req: http.IncomingMessage): string | undefined {
  const token = req.headers["cf-access-jwt-assertion"];
  return Array.isArray(token) ? token[0] : token;
}

interface ApiContext {
  access?: AccessVerifier;
  devices: DeviceStore;
  workspace: string;
  /** Alfred's command socket; undefined when the API is off. */
  alfred?: string;
  /** Aborted when the client goes away. */
  gone: AbortSignal;
}

/** GET /api/runs: the newest runs, each through RunSchema so that only the client's fields go out. A record that does not fit is left out and logged. */
function runList(): Response {
  const runs: Run[] = [];
  let left = 0;
  for (const record of allRuns()) {
    if (runs.length === LISTED_RUNS) break;
    const parsed = RunSchema.safeParse(record);
    if (parsed.success) runs.push(parsed.data);
    else left++;
  }
  if (left) log.warn(`workbench left out ${left} run record(s) that do not fit the client's schema`);
  return jsonReply(200, { runs });
}

/** GET /api/runs/<id>: the run and its steps. An unknown run is 404; a record that does not fit fails the request, and is logged. */
function runDetailReply(id: string): Response {
  const detail = runDetail(id);
  if (!detail) return jsonError(404, "There is no such run.");
  const run = RunSchema.safeParse(detail.record);
  if (!run.success) throw new Error(`run ${id} does not fit the client's schema: ${run.error.message}`);
  const body: RunDetail = { run: run.data, steps: (detail.file?.steps ?? []).map((step) => StepSchema.parse(step)) };
  return jsonReply(200, body);
}

/** GET /api/tasks: the task list the store wrote, as TaskList. A file that does not fit fails the request, and is logged. */
function taskListReply(): Response {
  return jsonReply(200, readTaskList());
}

/**
 * GET /api/tasks/<id>: the task and its runs, newest first, at most 50. A malformed or unknown id is 404; runs whose
 * record does not fit the client's schema are left out and logged, as GET /api/runs leaves them out.
 */
function taskDetailReply(id: string): Response {
  const notFound = () => jsonError(404, "There is no such task.");
  if (!TASK_ID.test(id)) return notFound();
  const task = readTaskList().tasks.find((t) => t.id === id);
  if (!task) return notFound();
  const runs: Run[] = [];
  let left = 0;
  for (const record of allRuns()) {
    if (record.taskId !== id) continue;
    if (runs.length === LISTED_TASK_RUNS) break;
    const parsed = RunSchema.safeParse(record);
    if (parsed.success) runs.push(parsed.data);
    else left++;
  }
  if (left) log.warn(`workbench left out ${left} run record(s) of task ${id} that do not fit the client's schema`);
  const body: TaskDetail = { task, runs };
  return jsonReply(200, body);
}

/** GET /api/ideas: the ideas the store wrote, as IdeaList. A file that does not fit fails the request, and is logged. */
function ideaListReply(): Response {
  return jsonReply(200, readIdeaList());
}

/**
 * GET /api/documents: the documents the store keeps in documents.json, most recently updated first, those in .trash/
 * left out. A missing file is an empty list; a file that does not fit fails the request, and is logged.
 */
function documentListReply(): Response {
  const documents = readDocumentFile()
    .documents.map((entry) => entry.document)
    .filter((document) => !isTrashedPath(document.path));
  documents.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const body: DocumentList = { documents };
  return jsonReply(200, body);
}

/**
 * GET /api/documents/<id>: the document, its versions (newest first, the first being the current one), its annotations
 * (newest first) and its revision runs (newest first, at most 50). A malformed or unknown id is 404, and so is the id of
 * a document in .trash/; runs whose record does not fit the client's schema are left out and logged, as
 * GET /api/tasks/<id> leaves them out. A body that does not fit DocumentDetailSchema fails the request, and is logged.
 */
function documentDetailReply(id: string): Response {
  const notFound = () => jsonError(404, "There is no such document.");
  if (!DOCUMENT_ID.test(id)) return notFound();
  const file = readDocumentFile();
  const entry = file.documents.find((other) => other.document.id === id);
  if (!entry || isTrashedPath(entry.document.path)) return notFound();
  const runs: Run[] = [];
  let left = 0;
  for (const record of allRuns()) {
    if (record.documentId !== id) continue;
    if (runs.length === LISTED_DOCUMENT_RUNS) break;
    const parsed = RunSchema.safeParse(record);
    if (parsed.success) runs.push(parsed.data);
    else left++;
  }
  if (left) log.warn(`workbench left out ${left} run record(s) of document ${id} that do not fit the client's schema`);
  const body: DocumentDetail = DocumentDetailSchema.parse({
    document: entry.document,
    versions: entry.versions,
    annotations: file.annotations.filter((annotation) => annotation.documentId === id),
    runs,
  });
  return jsonReply(200, body);
}

/**
 * POST /api/push: the device's APNs registration, replacing its earlier one; 204. A body that is not a
 * PushRegistration is 400 with the first problem found; a device revoked meanwhile is 401.
 */
async function pushRegistrationReply(req: http.IncomingMessage, deviceId: string, devices: DeviceStore): Promise<Response> {
  const body = await readBody(req, MAX_PUSH_BYTES);
  if (body === undefined) return { ...jsonError(413, `registration is over ${MAX_PUSH_BYTES} bytes`), closeConnection: true };
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return jsonError(400, "body is not valid JSON");
  }
  const parsed = PushRegistrationSchema.safeParse(json);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const where = issue && issue.path.length > 0 ? `${issue.path.map(String).join(".")}: ` : "";
    return jsonError(400, `${where}${issue?.message ?? "invalid registration"}`);
  }
  if (!devices.setPush(deviceId, parsed.data)) {
    return jsonError(401, "A paired device's token is required.", { "WWW-Authenticate": "Bearer" });
  }
  return { status: 204, headers: {}, body: "" };
}

/**
 * GET /api/rules: the root ALFRED.md as a Rules: its text and the sha256 of its bytes as the version, which rules.save
 * is made against. A missing file and a symlink read as empty text. A file over RULES_READ_MAX_BYTES is 413, so that an
 * editor never holds a cut-off text.
 */
function rulesReply(workspace: string): Response {
  const rules = readRulesForOwner(workspace);
  if (!rules) return jsonError(413, `ALFRED.md is over ${RULES_READ_MAX_BYTES} bytes, too long to edit here.`);
  return jsonReply(200, rules);
}

/**
 * GET /api/memories: the long-term memories as a MemoryList, in the order of the system prompt's index, each with the
 * sha256 of its file's bytes as the version that memory.update and memory.delete are made against. No memory folder is
 * an empty list.
 */
function memoryListReply(workspace: string): Response {
  return jsonReply(200, memoryList(workspace));
}

/**
 * GET /api/files/<path>: a workspace file's bytes, typed by extension as the pages type them, under the sandbox policy.
 * An HTML report comes with its workspace images inlined, as the report page shows it; one over the preview cap is
 * sent as it is, since the page would refuse it. With `?version=<commit>` it is the file as it was at that commit.
 */
function fileReply(workspace: string, rest: string, query: URLSearchParams): Response | Promise<Response> {
  const notFound = () => jsonError(404, "There is no such file.");
  let rel: string;
  try {
    rel = decodeURIComponent(rest);
  } catch {
    return notFound();
  }
  if (rel.includes("\0")) return notFound();
  if (query.has("version")) return versionFileReply(workspace, rel, query.getAll("version"));
  let target: ReturnType<typeof workspacePath>;
  try {
    target = workspacePath(workspace, rel);
  } catch (err) {
    if (err instanceof HttpError) return notFound();
    throw err;
  }
  if (!target.stat.isFile()) return notFound();
  const ext = path.extname(target.real).toLowerCase();
  const headers: Record<string, string> = { "Content-Type": rawContentType(ext), "Content-Security-Policy": "sandbox" };
  if (HTML_EXTS.has(ext) && target.stat.size <= MAX_PREVIEW_BYTES) {
    const markup = inlineImages(fs.readFileSync(target.real, "utf8"), target.real, workspace);
    headers["Content-Length"] = String(Buffer.byteLength(markup));
    return { headers, body: markup };
  }
  headers["Content-Length"] = String(target.stat.size);
  return { headers, body: fs.createReadStream(target.real) };
}

/**
 * GET /api/files/<path>?version=<commit>: the file's bytes at that commit of the workspace's history, typed and sandboxed
 * as the live file is. An HTML report gets its workspace images inlined from the live workspace, under the same cap.
 * Anything the history does not hold is 404: a version that is not one commit id, a commit that is not in the history,
 * a path that is not a file in that commit, and a path the history refuses (outside the workspace, inside .git).
 * The refusal of a path or commit is logged with its reason.
 */
async function versionFileReply(workspace: string, rel: string, asked: string[]): Promise<Response> {
  const notFound = () => jsonError(404, "There is no such file.");
  const [version] = asked;
  if (asked.length !== 1 || version === undefined || !COMMIT_ID.test(version)) return notFound();
  const real = resolveInside(workspace, rel || ".");
  if (!real) return notFound();
  let bytes: Buffer | undefined;
  try {
    bytes = await new Versions({ workspace, gitDir: VERSIONS_GIT_DIR }).show(version, rel);
  } catch (err) {
    log.warn(`workbench refused ${rel} at ${version}: ${describeError(err)}`);
    return notFound();
  }
  if (bytes === undefined) return notFound();
  const ext = path.extname(real).toLowerCase();
  const headers: Record<string, string> = { "Content-Type": rawContentType(ext), "Content-Security-Policy": "sandbox" };
  if (HTML_EXTS.has(ext) && bytes.length <= MAX_PREVIEW_BYTES) {
    const markup = inlineImages(bytes.toString("utf8"), real, workspace);
    headers["Content-Length"] = String(Buffer.byteLength(markup));
    return { headers, body: markup };
  }
  headers["Content-Length"] = String(bytes.length);
  return { headers, body: bytes };
}

/** The app's way in: the Access JWT (owner or service token) on the tunnel, then a paired device's bearer token everywhere. */
async function apiRoute(req: http.IncomingMessage, url: URL, ctx: ApiContext): Promise<Response> {
  const refuse = (status: number, reason: string, message: string, headers?: Record<string, string>) => {
    log.warn(`workbench refused ${req.method ?? ""} ${url.pathname}: ${reason}`);
    return jsonError(status, message, headers);
  };
  if (ctx.access) {
    const verdict = await ctx.access.verify(accessToken(req));
    if ("error" in verdict) return refuse(403, verdict.error, "Cloudflare Access sign-in is required.");
  }
  const bearer = bearerToken(req.headers.authorization);
  const device = "token" in bearer ? ctx.devices.authenticate(bearer.token) : undefined;
  if (!device) {
    return refuse(401, "token" in bearer ? "not a paired device" : bearer.reason, "A paired device's token is required.", { "WWW-Authenticate": "Bearer" });
  }
  const method = req.method ?? "";
  if (method !== "GET" && method !== "POST") return jsonError(405, "Only GET and POST are allowed.", { Allow: "GET, POST" });
  // A route takes one method; any other gets 405 naming it.
  const only = (want: "GET" | "POST", handle: () => Response | Promise<Response>) =>
    method === want ? handle() : jsonError(405, `Only ${want} is allowed here.`, { Allow: want });
  const p = url.pathname;
  if (p === "/api/ping") return only("GET", () => ({ status: 204, headers: {}, body: "" }));
  if (p === "/api/commands") return only("POST", () => forwardCommand(req, ctx.alfred, ctx.gone));
  if (p === "/api/uploads") return only("POST", () => forwardUpload(req, url.searchParams.get("name"), ctx.alfred, ctx.gone));
  if (p === "/api/events") return only("GET", () => forwardEvents(req, url, ctx.alfred, ctx.gone));
  if (p === "/api/runs") return only("GET", () => runList());
  if (p === "/api/tasks") return only("GET", () => taskListReply());
  if (p.startsWith(TASK_PREFIX)) return only("GET", () => taskDetailReply(p.slice(TASK_PREFIX.length)));
  if (p === "/api/documents") return only("GET", () => documentListReply());
  if (p.startsWith(DOCUMENT_PREFIX)) return only("GET", () => documentDetailReply(p.slice(DOCUMENT_PREFIX.length)));
  if (p === "/api/ideas") return only("GET", () => ideaListReply());
  if (p === "/api/rules") return only("GET", () => rulesReply(ctx.workspace));
  if (p === "/api/memories") return only("GET", () => memoryListReply(ctx.workspace));
  if (p === "/api/push") return only("POST", () => pushRegistrationReply(req, device.id, ctx.devices));
  const run = RUN_PATH.exec(p)?.[1];
  if (run) return only("GET", () => runDetailReply(run));
  if (p.startsWith(FILE_PATH)) return only("GET", () => fileReply(ctx.workspace, p.slice(FILE_PATH.length), url.searchParams));
  return jsonError(404, "There is no such endpoint.");
}

export function createHandler(opts: HandlerOptions): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  const devices = opts.devices ?? new DeviceStore();
  const alfred = opts.apiSocket ?? apiSocketPath();
  const streams = opts.streams ?? new Set<http.ServerResponse>();
  return async (req, res) => {
    // Aborted when the client goes away, which also ends any request or stream forwarded to Alfred.
    const gone = new AbortController();
    res.once("close", () => gone.abort());
    const send = (r: Response) => {
      const headers = { ...BASE_HEADERS, ...r.headers };
      if (r.closeConnection) headers.Connection = "close";
      res.writeHead(r.status ?? 200, headers);
      // The request body was refused unread: the connection goes once the reply is out, rather than reading the rest.
      if (r.closeConnection) res.once("finish", () => req.destroy());
      if (r.body instanceof http.IncomingMessage) {
        // Alfred's stream goes out as it arrives. A broken upstream ends the response where it stands.
        res.flushHeaders();
        streams.add(res);
        res.once("close", () => streams.delete(res));
        r.body.on("error", () => res.end());
        r.body.once("close", () => res.end());
        r.body.pipe(res);
      } else if (r.body instanceof fs.ReadStream) {
        r.body.on("error", () => res.destroy());
        r.body.pipe(res);
      } else {
        res.end(r.body);
      }
    };
    const fail = (status: number, message: string) => send(htmlResponse(errorPage(status, message), pageCsp("none"), status));
    // The path decides which rules apply, and it is the path that gets routed, so a dot-segment cannot slip between the two.
    let url: URL | undefined;
    try {
      url = new URL(req.url ?? "/", "http://workbench.invalid");
    } catch {
      // Answered as a page request below.
    }
    try {
      if (url?.pathname.startsWith(API_PREFIX)) {
        return send(await apiRoute(req, url, { access: opts.access, devices, workspace: opts.workspace, alfred, gone: gone.signal }));
      }
      if (req.method !== "GET") {
        res.writeHead(405, { ...BASE_HEADERS, Allow: "GET", "Content-Type": "text/plain; charset=utf-8" });
        res.end("Only GET is allowed.\n");
        return;
      }
      if (opts.access) {
        const verdict = await opts.access.verify(accessToken(req));
        if ("error" in verdict) {
          log.warn(`workbench refused ${req.url ?? ""}: ${verdict.error}`);
          return fail(403, "需要通过 Cloudflare Access 登录。");
        }
        if (!("email" in verdict)) {
          log.warn(`workbench refused ${req.url ?? ""}: pages are for the owner, not a service token`);
          return fail(403, "这个页面只对所有者开放。");
        }
      }
      if (!url) throw new HttpError(400, "请求地址无效。");
      send(await route(url, opts.workspace));
    } catch (err) {
      if (url?.pathname.startsWith(API_PREFIX)) {
        // A client that went away mid-request is not an error of ours.
        if (gone.signal.aborted) return;
        log.error(`workbench ${url.pathname} failed: ${describeError(err)}`);
        return send(jsonError(500, "Something went wrong; see the log."));
      }
      if (err instanceof HttpError) return fail(err.status, err.message);
      log.error(`workbench ${req.url ?? ""} failed: ${describeError(err)}`);
      fail(500, "出错了，详情见日志。");
    }
  };
}

export interface WorkbenchOptions {
  workspace: string;
  /** TCP listener for the tunnel; omitted to listen on the socket only. */
  tcp?: { host: string; port: number; access?: AccessVerifier };
  /** Unix socket for the SSH-tunnel fallback, created 0600. */
  socket?: string;
  /** The paired devices, shared by both listeners; the default store when omitted. */
  devices?: DeviceStore;
}

function listen(server: http.Server, target: { host: string; port: number } | string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    const done = () => {
      server.off("error", reject);
      resolve();
    };
    if (typeof target === "string") server.listen(target, done);
    else server.listen(target.port, target.host, done);
  });
}

/** Start the listeners; resolves to a function that closes them. */
export async function startWorkbench(opts: WorkbenchOptions): Promise<() => Promise<void>> {
  const servers: http.Server[] = [];
  const devices = opts.devices ?? new DeviceStore();
  // The event streams open on either listener; closing ends them all.
  const streams = new Set<http.ServerResponse>();
  if (opts.tcp) {
    const server = http.createServer(createHandler({ workspace: opts.workspace, access: opts.tcp.access, devices, streams }));
    await listen(server, opts.tcp);
    servers.push(server);
    log.info(`workbench listening on ${opts.tcp.host}:${opts.tcp.port}${opts.tcp.access ? " (Cloudflare Access required)" : " WITHOUT an Access check"}`);
  }
  if (opts.socket) {
    try {
      if (fs.lstatSync(opts.socket).isSocket()) fs.rmSync(opts.socket);
    } catch {
      // No socket left over.
    }
    const server = http.createServer(createHandler({ workspace: opts.workspace, devices, streams }));
    // Created owner-only from the start, so no other user can connect in between.
    const umask = process.umask(0o177);
    try {
      await listen(server, opts.socket);
    } finally {
      process.umask(umask);
    }
    servers.push(server);
    log.info(`workbench listening on ${opts.socket}`);
  }
  if (!servers.length) throw new Error("the workbench has no listener: set ALFRED_WORKBENCH_LISTEN or ALFRED_WORKBENCH_SOCKET");
  return async () => {
    const closed = Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    // Every event stream ends at once. Its upstream request ends with it: the handler aborts that when the response closes.
    for (const res of streams) res.destroy();
    // Other requests in flight get the grace period to finish. Then the connections that remain are cut, idle keep-alive ones included.
    const cutAt = Date.now() + CLOSE_GRACE_MS;
    const sweep = setInterval(() => {
      for (const s of servers) {
        if (Date.now() < cutAt) s.closeIdleConnections();
        else s.closeAllConnections();
      }
    }, 20);
    try {
      await closed;
    } finally {
      clearInterval(sweep);
    }
  };
}
