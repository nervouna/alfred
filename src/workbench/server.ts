// The workbench: a read-only web view of Alfred's runs, files and state.
// GET only, server-rendered, no build step. Two listeners share one handler:
// TCP for the Cloudflare tunnel, where every request needs a valid Access JWT,
// and a 0600 Unix socket for an SSH-tunnel fallback.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { resolveInside } from "../agent/guard.ts";
import { loadMemories } from "../agent/memory.ts";
import { describeError, log } from "../log.ts";
import type { AccessVerifier } from "./access.ts";
import { allRuns, alfredStatus, listSessions, readTranscript, runDetail, spendByDay, tailLog } from "./data.ts";
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
  body: string | Buffer | fs.ReadStream;
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

function serveRaw(real: string, rel: string, stat: fs.Stats, download: boolean): Response {
  const ext = path.extname(real).toLowerCase();
  const name = path.basename(real);
  const headers: Record<string, string> = { "Content-Length": String(stat.size), "Content-Security-Policy": RAW_CSP };
  if (IMAGE_TYPES[ext]) {
    headers["Content-Type"] = IMAGE_TYPES[ext];
  } else if (ext === ".pdf") {
    headers["Content-Type"] = "application/pdf";
    // A browser's PDF viewer does not run in a sandboxed document.
    delete headers["Content-Security-Policy"];
  } else if (ext === ".svg") {
    // An <img> still shows it; opened directly, it downloads instead of running here.
    headers["Content-Type"] = "image/svg+xml";
    download = true;
  } else if (ext === ".html" || ext === ".htm") {
    headers["Content-Type"] = "text/plain; charset=utf-8";
    download = true;
  } else if (TEXT_EXTS.has(ext)) {
    headers["Content-Type"] = "text/plain; charset=utf-8";
  } else {
    headers["Content-Type"] = "application/octet-stream";
    download = true;
  }
  headers["Content-Disposition"] = disposition(download ? "attachment" : "inline", name);
  log.debug(`workbench raw ${rel}`);
  return { headers, body: fs.createReadStream(real) };
}

export interface HandlerOptions {
  workspace: string;
  /** Checks the Access JWT; undefined for the Unix socket and --dev. */
  access?: AccessVerifier;
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

export function createHandler(opts: HandlerOptions): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  return async (req, res) => {
    const send = (r: Response) => {
      res.writeHead(r.status ?? 200, { ...BASE_HEADERS, ...r.headers });
      if (r.body instanceof fs.ReadStream) {
        r.body.on("error", () => res.destroy());
        r.body.pipe(res);
      } else {
        res.end(r.body);
      }
    };
    const fail = (status: number, message: string) => send(htmlResponse(errorPage(status, message), pageCsp("none"), status));
    try {
      if (req.method !== "GET") {
        res.writeHead(405, { ...BASE_HEADERS, Allow: "GET", "Content-Type": "text/plain; charset=utf-8" });
        res.end("Only GET is allowed.\n");
        return;
      }
      if (opts.access) {
        const token = req.headers["cf-access-jwt-assertion"];
        const verdict = await opts.access.verify(Array.isArray(token) ? token[0] : token);
        if ("error" in verdict) {
          log.warn(`workbench refused ${req.url ?? ""}: ${verdict.error}`);
          return fail(403, "需要通过 Cloudflare Access 登录。");
        }
      }
      const url = new URL(req.url ?? "/", "http://workbench.invalid");
      send(await route(url, opts.workspace));
    } catch (err) {
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
  if (opts.tcp) {
    const server = http.createServer(createHandler({ workspace: opts.workspace, access: opts.tcp.access }));
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
    const server = http.createServer(createHandler({ workspace: opts.workspace }));
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
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  };
}
