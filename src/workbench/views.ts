// Workbench pages. Each function returns a whole HTML page; data comes in as
// arguments, so the pages hold no I/O and every value goes through html``.

import type { Memory } from "../agent/memory.ts";
import type { RunFile, RunRecord, RunStatus } from "../runs.ts";
import { PUSH_WINDOW_MS, countsForSpend } from "./data.ts";
import type { AlfredStatus, DaySpend, SessionInfo, TranscriptEntry } from "./data.ts";
import { Html, html, page, query } from "./html.ts";

const STATUS_LABELS: Record<RunStatus, string> = {
  queued: "排队中",
  running: "进行中",
  done: "完成",
  stopped: "已停止",
  failed: "失败",
  lost: "丢失",
};

export function fmtTime(iso: string | number | undefined): string {
  if (iso === undefined) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟`;
  if (s < 48 * 3600) return `${(s / 3600).toFixed(1)} 小时`;
  return `${Math.round(s / 86400)} 天`;
}

export function fmtUsd(n: number | undefined): string {
  const v = n ?? 0;
  return `$${v.toFixed(v < 1 ? 3 : 2)}`;
}

function fmtBytes(n: number | undefined): string {
  if (n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function shortModel(model: string | undefined): string {
  return model ? model.replace(/^claude-/, "") : "";
}

function isLive(status: RunStatus): boolean {
  return status === "running" || status === "queued";
}

function statusBadge(status: RunStatus, live: boolean): Html {
  const shown = isLive(status) && !live ? "可能已中断" : STATUS_LABELS[status] ?? status;
  const cls = isLive(status) && !live ? "s-lost" : status === "queued" ? "s-running" : `s-${status}`;
  return html`<span class="status ${cls}">${shown}</span>`;
}

function fileLink(rel: string): Html {
  return html`<a href="/files/view${query({ path: rel })}">${rel}</a>`;
}

export function runCard(r: RunRecord, opts: { live: boolean; now: number; latest?: string; link?: boolean }): Html {
  const end = r.endedAt ? Date.parse(r.endedAt) : opts.now;
  const meta = [
    r.kind === "scan" ? "记忆扫描" : r.kind === "subagent" ? `${r.role ?? "子任务"} · ${shortModel(r.model)}` : shortModel(r.model),
    fmtTime(r.startedAt),
    r.status === "queued" ? "" : fmtAge(end - Date.parse(r.startedAt)),
    `${r.costEstimated ? "≈" : ""}${fmtUsd(r.costUsd)}`,
    `工具 ${r.toolCalls} 次`,
  ].filter(Boolean);
  const undelivered = r.undelivered?.length
    ? html`<div class="warn">微信未送达：${r.undelivered.map((u, i) => html`${i ? "、" : ""}${u.path ? fileLink(u.path) : "回复"}`)}</div>`
    : "";
  return html`<div class="card">
<div class="top"><span class="id">${r.id}</span><button class="copy" type="button" data-copy="${r.id}">复制</button>${statusBadge(r.status, opts.live)}</div>
<div class="title">${opts.link === false ? r.title : html`<a href="/runs/${r.id}">${r.title}</a>`}</div>
<div class="meta">${meta.join(" · ")}${r.parentRunId ? html` · 来自 <a href="/runs/${r.parentRunId}">${r.parentRunId}</a>` : ""}</div>
${r.status === "running" && opts.latest ? html`<div class="meta">最新：${opts.latest}</div>` : ""}
${r.error ? html`<div class="warn">${r.error}</div>` : ""}
${undelivered}
${r.files.length ? html`<ul class="files">${r.files.map((f) => html`<li>${fileLink(f.path)} <span class="meta">${f.tool}</span></li>`)}</ul>` : ""}
</div>`;
}

function latestStep(f: RunRecord): string | undefined {
  const steps = (f as Partial<RunFile>).steps;
  const s = steps?.at(-1);
  return s ? `${s.agent ? `[${s.agent}] ` : ""}${s.tool} ${s.detail}`.trim() : undefined;
}

export function overviewPage(params: { status: AlfredStatus; runs: RunRecord[]; now: number; nonce: string }): string {
  const { status, runs, now } = params;
  const beat = status.beat;
  const running = runs.filter((r) => isLive(r.status));
  const today = new Date(now).toLocaleDateString("en-CA");
  const weekAgo = now - 7 * 86_400_000;
  const spent = runs.filter(countsForSpend);
  const spendToday = spent.filter((r) => new Date(r.startedAt).toLocaleDateString("en-CA") === today).reduce((a, r) => a + (r.costUsd || 0), 0);
  const spendWeek = spent.filter((r) => Date.parse(r.startedAt) >= weekAgo).reduce((a, r) => a + (r.costUsd || 0), 0);

  let window = "—";
  if (beat?.ownerLastInboundAt) {
    const left = beat.ownerLastInboundAt + PUSH_WINDOW_MS - now;
    window = left > 0 ? `约剩 ${fmtAge(left)}` : `已关闭（${fmtAge(now - beat.ownerLastInboundAt)}前收到最后一条消息）`;
  }
  const mem = beat?.memory;
  const memory = mem?.cgroupBytes
    ? `${fmtBytes(mem.cgroupBytes)}${mem.cgroupMaxBytes ? ` / ${fmtBytes(mem.cgroupMaxBytes)}（${Math.round((mem.cgroupBytes / mem.cgroupMaxBytes) * 100)}%）` : ""}`
    : mem
      ? `${fmtBytes(mem.rssBytes)}（进程）`
      : "—";

  const body = html`<h1>概览</h1>
<div class="card">
<div class="top"><span class="title">Alfred</span><span class="status ${status.up ? "s-up" : "s-down"}">${status.up ? "运行中" : "未运行"}</span></div>
<dl class="kv">
<dt>心跳</dt><dd>${beat ? `${fmtAge(now - Date.parse(beat.updatedAt))}前${beat.stoppedAt ? `（${fmtTime(beat.stoppedAt)} 正常退出）` : ""}` : "没有心跳记录"}</dd>
<dt>启动</dt><dd>${beat ? fmtTime(beat.startedAt) : "—"}</dd>
<dt>上次拉取</dt><dd>${beat?.lastPollAt ? `${fmtAge(now - Date.parse(beat.lastPollAt))}前，${beat.lastPollOk ? "成功" : "失败"}` : "—"}</dd>
<dt>内存</dt><dd>${memory}</dd>
<dt>推送窗口</dt><dd>${window}</dd>
<dt>花费</dt><dd>今天 ${fmtUsd(spendToday)} · 7 天 ${fmtUsd(spendWeek)}</dd>
</dl>
</div>
${running.length ? html`<h2>进行中</h2>${running.map((r) => runCard(r, { live: status.up, now, latest: latestStep(r) }))}` : ""}
<h2>最近</h2>
${runs.filter((r) => !isLive(r.status)).slice(0, 8).map((r) => runCard(r, { live: status.up, now }))}
<p><a href="/runs">全部运行 →</a></p>`;
  return page({ title: "概览", section: "/", nonce: params.nonce, refresh: running.length ? 5 : 30 }, body);
}

export const RUNS_PER_PAGE = 40;

export function runsPage(params: { runs: RunRecord[]; offset: number; live: boolean; now: number; nonce: string }): string {
  const { runs, offset } = params;
  const shown = runs.slice(offset, offset + RUNS_PER_PAGE);
  const more = offset + RUNS_PER_PAGE < runs.length;
  const body = html`<h1>运行</h1>
${shown.length ? shown.map((r) => runCard(r, { live: params.live, now: params.now, latest: latestStep(r) })) : html`<p class="meta">还没有运行记录。</p>`}
<p>${offset > 0 ? html`<a href="/runs${query({ offset: Math.max(0, offset - RUNS_PER_PAGE) })}">← 较新</a> ` : ""}${more ? html`<a href="/runs${query({ offset: offset + RUNS_PER_PAGE })}">更早 →</a>` : ""}</p>`;
  return page({ title: "运行", section: "/runs", nonce: params.nonce, refresh: shown.some((r) => isLive(r.status)) ? 5 : undefined }, body);
}

export function runPage(params: { record: RunRecord; file?: RunFile; children: RunRecord[]; live: boolean; now: number; nonce: string }): string {
  const { record, file, now } = params;
  const steps = file?.steps ?? [];
  const body = html`<p class="crumbs"><a href="/runs">← 运行</a></p>
<h1>${record.title}</h1>
${runCard(record, { live: params.live, now, latest: latestStep(record), link: false })}
<div class="card"><dl class="kv">
<dt>开始</dt><dd>${fmtTime(record.startedAt)}</dd>
<dt>结束</dt><dd>${fmtTime(record.endedAt)}</dd>
<dt>会话</dt><dd>${record.sessionId ? html`<a href="/sessions/${record.sessionId}">${record.sessionId.slice(0, 8)}</a>` : "—"}</dd>
${record.modelCostUsd && Object.keys(record.modelCostUsd).length ? html`<dt>按模型</dt><dd>${Object.entries(record.modelCostUsd).sort((a, b) => b[1] - a[1]).map(([m, c]) => `${shortModel(m)} ${fmtUsd(c)}`).join(" · ")}</dd>` : ""}
</dl></div>
${params.children.length ? html`<h2>子任务（${params.children.length}）</h2>${params.children.map((c) => runCard(c, { live: params.live, now, latest: latestStep(c) }))}` : ""}
<h2>步骤${steps.length ? `（${steps.length}）` : ""}</h2>
${file
    ? steps.length
      ? html`<div class="card"><ul class="steps">${[...steps].reverse().map((s) => html`<li><span class="meta">${fmtTime(s.at).slice(6)}</span> ${s.agent ? html`<span class="id">${s.agent}</span> ` : ""}<b>${s.tool}</b> ${s.detail}</li>`)}</ul></div>`
      : html`<p class="meta">还没有步骤。</p>`
    : html`<p class="meta">步骤明细已过保留期，只剩上面的记录。</p>`}`;
  const refresh = params.live && (isLive(record.status) || params.children.some((c) => isLive(c.status)));
  return page({ title: record.title, section: "/runs", nonce: params.nonce, refresh: refresh ? 5 : undefined }, body);
}

export function spendPage(params: { days: DaySpend[] }): string {
  const totals: Record<string, number> = {};
  for (const d of params.days) for (const [m, c] of Object.entries(d.byModel)) totals[m] = (totals[m] ?? 0) + c;
  const all = params.days.reduce((a, d) => a + d.costUsd, 0);
  const body = html`<h1>花费</h1>
<div class="card"><dl class="kv">
<dt>合计</dt><dd>${fmtUsd(all)}</dd>
${Object.entries(totals).sort((a, b) => b[1] - a[1]).map(([m, c]) => html`<dt>${shortModel(m)}</dt><dd>${fmtUsd(c)}</dd>`)}
</dl></div>
<div class="card scroll"><table>
<thead><tr><th>日期</th><th class="num">运行</th><th class="num">花费</th><th>按模型</th></tr></thead>
<tbody>${params.days.map((d) => html`<tr><td>${d.day}</td><td class="num">${d.runs}</td><td class="num">${fmtUsd(d.costUsd)}</td><td class="meta">${Object.entries(d.byModel).sort((a, b) => b[1] - a[1]).map(([m, c]) => `${shortModel(m)} ${fmtUsd(c)}`).join(" · ")}</td></tr>`)}</tbody>
</table></div>`;
  return page({ title: "花费", section: "/spend" }, body);
}

function crumbs(rel: string): Html {
  const parts = rel ? rel.split("/") : [];
  const links = parts.map((p, i) => html` / <a href="/files${query({ path: parts.slice(0, i + 1).join("/") })}">${p}</a>`);
  return html`<p class="crumbs"><a href="/files">工作区</a>${links}</p>`;
}

export interface DirEntry {
  name: string;
  rel: string;
  dir: boolean;
  bytes: number;
  modifiedAt: number;
}

export function dirPage(params: { rel: string; entries: DirEntry[] }): string {
  const body = html`${crumbs(params.rel)}
<h1>${params.rel || "工作区"}</h1>
<div class="card"><ul class="files">${params.entries.map((e) =>
    e.dir
      ? html`<li>📁 <a href="/files${query({ path: e.rel })}">${e.name}/</a></li>`
      : html`<li><a href="/files/view${query({ path: e.rel })}">${e.name}</a> <span class="meta">${fmtBytes(e.bytes)} · ${fmtTime(e.modifiedAt)}</span></li>`,
  )}</ul>${params.entries.length ? "" : html`<p class="meta">空目录。</p>`}</div>`;
  return page({ title: params.rel || "工作区", section: "/files" }, body);
}

/** A file's page around content that is already safe markup (rendered Markdown, an <img>, a <pre>). */
export function filePage(params: { rel: string; bytes: number; modifiedAt: number; content: Html }): string {
  const parent = params.rel.includes("/") ? params.rel.slice(0, params.rel.lastIndexOf("/")) : "";
  const body = html`${crumbs(parent)}
<h1>${params.rel.split("/").at(-1)}</h1>
<p class="meta">${fmtBytes(params.bytes)} · ${fmtTime(params.modifiedAt)} · <a href="/files/raw${query({ path: params.rel, download: 1 })}">下载</a></p>
${params.content}`;
  return page({ title: params.rel, section: "/files" }, body);
}

/**
 * An HTML or SVG report in a sandboxed frame: scripts run, but in an opaque
 * origin with no network, so it can neither read the workbench nor send
 * anything out. The page itself carries no script; see REPORT_CSP.
 */
export function reportPage(params: { rel: string; bytes: number; modifiedAt: number; srcdoc: string }): string {
  return filePage({
    ...params,
    content: html`<iframe class="report" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${params.srcdoc}" title="report"></iframe>`,
  });
}

export function sessionsPage(params: { sessions: SessionInfo[] }): string {
  const body = html`<h1>会话</h1>
<div class="card"><ul class="files">${params.sessions.map((s) => html`<li><a href="/sessions/${s.id}">${s.id.slice(0, 8)}</a> <span class="meta">${fmtTime(s.modifiedAt)} · ${fmtBytes(s.bytes)}</span></li>`)}</ul>${params.sessions.length ? "" : html`<p class="meta">还没有会话记录。</p>`}</div>`;
  return page({ title: "会话", section: "/sessions" }, body);
}

const ROLE_LABELS = { user: "用户", assistant: "Alfred", tool: "工具" } as const;

export function sessionPage(params: { id: string; entries: TranscriptEntry[]; truncated: boolean }): string {
  const body = html`<p class="crumbs"><a href="/sessions">← 会话</a></p>
<h1>会话 ${params.id.slice(0, 8)}</h1>
${params.truncated ? html`<p class="meta">记录太长，只显示最后一部分。</p>` : ""}
<div class="card">${params.entries.map((e) => html`<div class="msg ${e.role === "tool" ? "tool" : ""}"><div class="who">${ROLE_LABELS[e.role]}${e.sidechain ? " · 子代理" : ""} · ${fmtTime(e.at)}</div><pre>${e.text}</pre></div>`)}</div>`;
  return page({ title: `会话 ${params.id.slice(0, 8)}`, section: "/sessions" }, body);
}

export function memoryPage(params: { memories: Memory[] }): string {
  const body = html`<h1>记忆（${params.memories.length}）</h1>
${params.memories.map((m) => html`<div class="card"><div class="title"><a href="/files/view${query({ path: `memory/${m.file}` })}">${m.name}</a></div><div class="meta">${m.type} · ${m.updated || "—"}</div><div>${m.description}</div></div>`)}
${params.memories.length ? "" : html`<p class="meta">还没有长期记忆。</p>`}`;
  return page({ title: "记忆", section: "/memory" }, body);
}

export function logsPage(params: { lines: string[]; level: string }): string {
  const levels = ["all", "warn", "error"];
  const body = html`<h1>日志</h1>
<p>${levels.map((l) => html`<a href="/logs${query({ level: l === "all" ? undefined : l })}" class="${params.level === l ? "on" : ""}">${l}</a> `)}</p>
<div class="card"><pre>${params.lines.length ? params.lines.join("\n") : "没有日志。"}</pre></div>`;
  return page({ title: "日志", section: "/logs" }, body);
}

export function errorPage(status: number, message: string): string {
  return page({ title: String(status) }, html`<h1>${status}</h1><p>${message}</p>`);
}
