// Markdown/HTML to PDF with Playwright's Chrome Headless Shell.
//
// The shell is a standalone binary kept in the XDG cache, so rendering never
// launches the user's installed Chrome, whose updater trips macOS App
// Management protection.
//
// Pages are sandboxed. Every request goes through a route handler that only
// serves the page itself plus images, stylesheets and fonts whose real path is
// inside the allowed root; everything else (other local files, frames, network
// URLs) is refused. A CSP and disabled JavaScript back this up, so a report can
// neither pull an arbitrary local file into the PDF nor leak content over the
// network.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { marked } from "marked";
import type { Route } from "playwright-core";

import { resolveInside } from "./agent/guard.ts";

export const BROWSERS_PATH =
  process.env.PLAYWRIGHT_BROWSERS_PATH ??
  path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "alfred", "ms-playwright");

const MARKDOWN_EXTS = new Set([".md", ".markdown"]);
const HTML_EXTS = new Set([".html", ".htm"]);
export const PDF_SOURCE_EXTS = new Set([...MARKDOWN_EXTS, ...HTML_EXTS]);

const PAGE_LOAD_TIMEOUT_MS = 30_000;

// Subresource types a page may load from inside the root. Frames, objects and
// embeds are documents and never qualify.
const LOCAL_RESOURCE_TYPES = new Set(["image", "stylesheet", "font"]);

const CSP = [
  "default-src 'none'",
  "img-src file: data:",
  "style-src file: 'unsafe-inline'",
  "font-src file: data:",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const PRINT_CSS = `
html { font-size: 10.5pt; }
body {
  margin: 0; color: #1f2328; line-height: 1.7;
  font-family: -apple-system, "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif;
}
h1 { font-size: 1.8em; margin: 0 0 .8em; padding-bottom: .3em; border-bottom: 1px solid #d0d7de; }
h2 { font-size: 1.4em; margin: 1.6em 0 .6em; padding-bottom: .25em; border-bottom: 1px solid #eaeef2; }
h3 { font-size: 1.15em; margin: 1.3em 0 .5em; }
h1, h2, h3, h4 { break-after: avoid; }
p, ul, ol, blockquote, table, pre { margin: 0 0 .9em; }
a { color: #0969da; text-decoration: none; overflow-wrap: anywhere; }
blockquote { margin-left: 0; padding: 0 1em; color: #59636e; border-left: .25em solid #d0d7de; }
code { font-family: "SF Mono", Menlo, monospace; font-size: .88em; background: #f6f8fa; padding: .15em .35em; border-radius: 4px; }
pre { background: #f6f8fa; padding: .8em 1em; border-radius: 6px; white-space: pre-wrap; overflow-wrap: anywhere; }
pre code { background: none; padding: 0; }
table { width: 100%; border-collapse: collapse; font-size: .92em; }
tr, img, svg, figure { break-inside: avoid; }
th, td { border: 1px solid #d0d7de; padding: .4em .7em; text-align: left; vertical-align: top; }
th[align="right"], td[align="right"] { text-align: right; }
th[align="center"], td[align="center"] { text-align: center; }
th { background: #f6f8fa; }
img, svg { max-width: 100%; }
hr { border: 0; border-top: 1px solid #d0d7de; margin: 1.5em 0; }
`;

const FOOTER = `<div style="width:100%;font-size:8px;color:#8c959f;text-align:center;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

/** Wrap rendered Markdown in a print stylesheet. The title is the first H1, else `fallbackTitle`. */
export function markdownToHtml(markdown: string, fallbackTitle: string): string {
  const title = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? fallbackTitle;
  const body = marked.parse(markdown, { async: false, gfm: true });
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${PRINT_CSS}</style></head>
<body>
${body}
</body>
</html>`;
}

export function isRendererMissing(err: unknown): boolean {
  return err instanceof Error && /Executable doesn't exist|browserType\.launch/.test(err.message);
}

function filePath(url: string): string | undefined {
  if (!url.startsWith("file:")) return undefined;
  try {
    return fileURLToPath(url);
  } catch {
    return undefined;
  }
}

/** The real path of a file:// URL that names a regular file inside `root`. */
function localFile(root: string, url: string): string | undefined {
  const file = filePath(url);
  const real = file && resolveInside(root, file);
  return real && fs.statSync(real, { throwIfNoEntry: false })?.isFile() ? real : undefined;
}

export interface RenderOptions {
  /** The source and every local image, stylesheet and font it loads must resolve inside this directory. */
  root: string;
}

/** Render a Markdown or HTML file to an A4 PDF with page numbers. */
export async function renderPdf(source: string, output: string, { root }: RenderOptions): Promise<{ bytes: number }> {
  const ext = path.extname(source).toLowerCase();
  if (!PDF_SOURCE_EXTS.has(ext)) throw new Error(`cannot render ${ext || "extensionless"} files; use .md or .html`);
  const real = resolveInside(root, source);
  if (!real) throw new Error(`${source} is outside ${root}`);

  // The page keeps the source's file:// URL so relative image paths resolve,
  // but its content is served from memory: Markdown needs no temporary file.
  const raw = fs.readFileSync(real);
  const html = MARKDOWN_EXTS.has(ext) ? markdownToHtml(raw.toString("utf-8"), path.basename(source, ext)) : raw;
  const pagePath = path.resolve(root, source);

  // Must never throw: Playwright would surface it as an unhandled rejection.
  const handle = async (route: Route) => {
    const request = route.request();
    const type = request.resourceType();
    try {
      if (type === "document" && filePath(request.url()) === pagePath) {
        await route.fulfill({ body: html, contentType: "text/html; charset=utf-8", headers: { "Content-Security-Policy": CSP } });
        return;
      }
      const file = LOCAL_RESOURCE_TYPES.has(type) ? localFile(root, request.url()) : undefined;
      if (file) {
        await route.fulfill({ path: file });
        return;
      }
    } catch {
      // A request that could not be served is refused, never passed on.
    }
    await route.abort("accessdenied").catch(() => {});
  };

  process.env.PLAYWRIGHT_BROWSERS_PATH ??= BROWSERS_PATH;
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ offline: true, javaScriptEnabled: false });
    // Routes see file:// requests too; data: URLs are inline and never become requests.
    await context.route(() => true, handle);
    const tab = await context.newPage();
    await tab.goto(pathToFileURL(pagePath).href, { waitUntil: "load", timeout: PAGE_LOAD_TIMEOUT_MS });
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const pdf = await tab.pdf({
      path: output,
      format: "A4",
      printBackground: true,
      margin: { top: "16mm", bottom: "18mm", left: "14mm", right: "14mm" },
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: FOOTER,
    });
    return { bytes: pdf.length };
  } finally {
    await browser.close();
  }
}
