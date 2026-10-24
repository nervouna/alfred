// Markdown for the workbench: GFM without raw HTML. HTML in the source shows as
// text, links keep only safe schemes, and images load only from the workspace.

import path from "node:path";

import { Marked } from "marked";
import type { Tokens } from "marked";

import { escapeHtml, query } from "./html.ts";

const SAFE_LINK = /^(https?:|mailto:)/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Resolve a relative reference from a workspace Markdown file to a
 * workspace-relative path, or undefined when it leaves the workspace or is not
 * a plain relative path.
 */
function workspaceRef(href: string, fromFile: string): string | undefined {
  if (!href || HAS_SCHEME.test(href) || href.startsWith("//") || href.startsWith("#")) return undefined;
  const clean = decodeURIComponentSafe(href.split(/[?#]/)[0] ?? "");
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), clean));
  if (joined.startsWith("../") || joined === ".." || path.posix.isAbsolute(joined)) return undefined;
  return joined;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Render workspace Markdown `source` (from the workspace-relative `file`) to HTML safe to embed in a page. */
export function renderMarkdown(source: string, file: string): string {
  const marked = new Marked({ gfm: true, async: false });
  marked.use({
    renderer: {
      html({ text }: Tokens.HTML | Tokens.Tag): string {
        return escapeHtml(text);
      },
      link(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: Tokens.Link): string {
        const label = this.parser.parseInline(token.tokens);
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
        if (SAFE_LINK.test(token.href)) {
          return `<a href="${escapeHtml(token.href)}"${title} rel="noopener noreferrer" target="_blank">${label}</a>`;
        }
        const ref = workspaceRef(token.href, file);
        if (ref !== undefined) return `<a href="/files/view${escapeHtml(query({ path: ref }))}"${title}>${label}</a>`;
        return label;
      },
      image(token: Tokens.Image): string {
        const ref = workspaceRef(token.href, file);
        const alt = escapeHtml(token.text);
        if (ref === undefined) {
          // Remote images are not loaded; show where they point instead.
          return SAFE_LINK.test(token.href)
            ? `<a href="${escapeHtml(token.href)}" rel="noopener noreferrer" target="_blank">[图片：${alt || escapeHtml(token.href)}]</a>`
            : `[图片：${alt}]`;
        }
        return `<img src="/files/raw${escapeHtml(query({ path: ref }))}" alt="${alt}" loading="lazy">`;
      },
    },
  });
  return marked.parse(source) as string;
}
