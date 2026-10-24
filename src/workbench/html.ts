// HTML building for the workbench. Every interpolated value is escaped unless
// it is already Html, so nothing read from state or the workspace reaches a
// page as markup.

export class Html {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

function render(value: unknown): string {
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  if (value === undefined || value === null || value === false) return "";
  return escapeHtml(String(value));
}

/** Tagged template: literal parts are markup, interpolations are escaped (arrays are joined). */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0] ?? "";
  values.forEach((v, i) => {
    out += render(v) + (strings[i + 1] ?? "");
  });
  return new Html(out);
}

/** Markup produced by trusted code, such as the Markdown renderer. */
export function trusted(markup: string): Html {
  return new Html(markup);
}

/** A query string with each value encoded, for links built from paths and ids. */
export function query(params: Record<string, string | number | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

const CSS = `
:root { --bg:#f6f7f9; --card:#fff; --fg:#1f2328; --muted:#656d76; --line:#d0d7de; --accent:#0969da;
  --ok:#1a7f37; --warn:#9a6700; --bad:#cf222e; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --card:#161b22; --fg:#e6edf3; --muted:#8d96a0;
  --line:#30363d; --accent:#4493f8; --ok:#3fb950; --warn:#d29922; --bad:#f85149; } }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans CJK SC", "Segoe UI", sans-serif; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
header { position: sticky; top: 0; z-index: 1; background: var(--card); border-bottom: 1px solid var(--line); }
nav { max-width: 880px; margin: 0 auto; padding: 8px 16px; display: flex; flex-wrap: wrap; gap: 4px 14px; align-items: center; }
nav .brand { font-weight: 600; color: var(--fg); margin-right: 6px; }
nav a.on { font-weight: 600; color: var(--fg); }
main { max-width: 880px; margin: 0 auto; padding: 16px; }
h1 { font-size: 20px; margin: 4px 0 12px; overflow-wrap: anywhere; }
h2 { font-size: 16px; margin: 22px 0 8px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin: 0 0 10px; overflow-wrap: anywhere; }
.card .top { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.card .title { font-weight: 600; flex: 1 1 200px; min-width: 0; }
.meta { color: var(--muted); font-size: 13px; }
.id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; padding: 1px 6px; border: 1px solid var(--line); border-radius: 6px; }
button.copy { font: inherit; font-size: 12px; padding: 1px 8px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: var(--fg); cursor: pointer; }
.status { font-size: 12px; padding: 1px 8px; border-radius: 999px; border: 1px solid currentColor; white-space: nowrap; }
.s-running { color: var(--accent); } .s-done { color: var(--ok); } .s-stopped { color: var(--warn); }
.s-failed, .s-lost, .s-down { color: var(--bad); } .s-up { color: var(--ok); }
ul.files, ul.steps { list-style: none; padding: 0; margin: 6px 0 0; }
ul.files li, ul.steps li { padding: 3px 0; border-top: 1px solid var(--line); font-size: 14px; }
ul.files li:first-child, ul.steps li:first-child { border-top: 0; }
.warn { color: var(--bad); }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
td.num, th.num { text-align: right; white-space: nowrap; }
.scroll { overflow-x: auto; }
dl.kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; margin: 0; }
dl.kv dt { color: var(--muted); } dl.kv dd { margin: 0; overflow-wrap: anywhere; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; }
.md { overflow-wrap: anywhere; }
.md img { max-width: 100%; }
.md pre, .md code { background: var(--bg); border-radius: 4px; }
.md pre { padding: 8px; }
.md table { display: block; overflow-x: auto; }
.md blockquote { margin: 0; padding-left: 12px; border-left: 3px solid var(--line); color: var(--muted); }
img.preview { max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: 6px; }
iframe.report { width: 100%; height: 78vh; border: 1px solid var(--line); border-radius: 8px; background: #fff; }
.msg { margin: 8px 0; }
.msg .who { font-size: 12px; color: var(--muted); }
.msg.tool { color: var(--muted); font-size: 13px; }
.crumbs { margin-bottom: 8px; overflow-wrap: anywhere; }
`;

const NAV = [
  ["/", "概览"],
  ["/runs", "运行"],
  ["/spend", "花费"],
  ["/files", "文件"],
  ["/sessions", "会话"],
  ["/memory", "记忆"],
  ["/logs", "日志"],
] as const;

export interface PageOptions {
  title: string;
  /** Path of the nav entry to highlight. */
  section?: string;
  /** Reload the page this often (seconds), e.g. while a run is live. */
  refresh?: number;
  /** Nonce for the page's one script; pages without it carry no script. */
  nonce?: string;
}

/** Copies a run id when its button is clicked; the only script the workbench serves. */
const COPY_SCRIPT = `document.addEventListener("click", (e) => {
  const b = e.target instanceof Element ? e.target.closest("button[data-copy]") : null;
  if (!b) return;
  const done = () => { b.textContent = "已复制"; setTimeout(() => { b.textContent = "复制"; }, 1500); };
  if (navigator.clipboard) navigator.clipboard.writeText(b.dataset.copy).then(done, () => { b.textContent = b.dataset.copy; });
  else b.textContent = b.dataset.copy;
});`;

export function page(opts: PageOptions, body: Html): string {
  const nav = NAV.map(([href, label]) => html`<a href="${href}" class="${opts.section === href ? "on" : ""}">${label}</a>`);
  return html`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
${opts.refresh ? html`<meta http-equiv="refresh" content="${opts.refresh}">` : ""}
<title>${opts.title} · Alfred</title>
<style>${trusted(CSS)}</style>
</head>
<body>
<header><nav><span class="brand">Alfred</span>${nav}</nav></header>
<main>
${body}
</main>
${opts.nonce ? html`<script nonce="${opts.nonce}">${trusted(COPY_SCRIPT)}</script>` : ""}
</body>
</html>`.value;
}
