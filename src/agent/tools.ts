// In-process MCP tools that let the agent act on WeChat and the workspace.

import fs from "node:fs";
import path from "node:path";

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { reply } from "../bot.ts";
import type { BotContext } from "../bot.ts";
import { humanSize } from "../files.ts";
import { MEDIA_MAX_BYTES } from "../ilink/inbound.ts";
import { sendMedia } from "../ilink/send.ts";
import { describeError, log } from "../log.ts";
import { PDF_SOURCE_EXTS, isRendererMissing, renderPdf } from "../pdf.ts";
import { WORKSPACE_DIR } from "../store.ts";
import { resolveInside } from "./guard.ts";
import { ASPECT_RATIOS, MAX_IMAGES_PER_CALL, MAX_IMAGES_PER_TASK, createImageGenerator } from "./image.ts";

export const ALFRED_TOOL_NAMES = ["mcp__alfred__send_file", "mcp__alfred__move_file", "mcp__alfred__render_pdf", "mcp__alfred__generate_image"];

const UNOPENABLE_EXTS = new Set([".html", ".htm"]);

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

/** Tools bound to one WeChat user for the duration of a run. */
export function createAlfredTools(ctx: BotContext, userId: string) {
  const sendFile = tool(
    "send_file",
    "Send a file from the workspace to the user in WeChat. WeChat opens Markdown, PDF, images, video and Office files; it cannot open HTML.",
    {
      path: z.string().describe("File path, relative to the workspace or absolute inside it"),
      caption: z.string().optional().describe("Short message sent just before the file"),
    },
    async ({ path: p, caption }) => {
      const real = resolveInside(WORKSPACE_DIR, p);
      if (!real) return fail(`${p} is outside the workspace.`);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(real);
      } catch {
        return fail(`${p} does not exist.`);
      }
      if (!stat.isFile()) return fail(`${p} is not a file.`);
      if (stat.size > MEDIA_MAX_BYTES) return fail(`${p} is ${humanSize(stat.size)}, over the ${humanSize(MEDIA_MAX_BYTES)} limit.`);
      if (UNOPENABLE_EXTS.has(path.extname(real).toLowerCase())) {
        return fail("WeChat cannot open HTML files. Send Markdown or PDF instead.");
      }
      try {
        if (caption) await reply(ctx, userId, caption);
        const kind = await sendMedia({
          client: ctx.client,
          cdnBaseUrl: ctx.cdnBaseUrl,
          to: userId,
          data: fs.readFileSync(real),
          fileName: path.basename(real),
          contextToken: ctx.tokens.get(userId)?.token,
        });
        log.info(`agent sent ${path.relative(WORKSPACE_DIR, real)} as ${kind}`);
        return ok(`Sent ${path.basename(real)} (${humanSize(stat.size)}) to the user as ${kind}.`);
      } catch (err) {
        return fail(`Sending failed: ${describeError(err)}`);
      }
    },
  );

  const moveFile = tool(
    "move_file",
    "Move or rename a file or directory inside the workspace. Parent directories are created as needed; existing targets are never overwritten. To delete, move into .trash/.",
    {
      from: z.string().describe("Existing path, relative to the workspace"),
      to: z.string().describe("New path, relative to the workspace"),
    },
    async ({ from, to }) => {
      const src = resolveInside(WORKSPACE_DIR, from);
      const dst = resolveInside(WORKSPACE_DIR, to);
      if (!src || !dst) return fail("Both paths must be inside the workspace.");
      if (src === fs.realpathSync(WORKSPACE_DIR)) return fail("Cannot move the workspace itself.");
      if (!fs.existsSync(src)) return fail(`${from} does not exist.`);
      if (fs.existsSync(dst)) return fail(`${to} already exists.`);
      if (dst.startsWith(src + path.sep)) return fail("Cannot move a directory into itself.");
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
      return ok(`Moved ${from} to ${to}.`);
    },
  );

  const renderPdfTool = tool(
    "render_pdf",
    "Convert a Markdown or HTML file in the workspace to an A4 PDF with page numbers. Rendering is offline: workspace images load by relative path (e.g. ../images/<date>/cover.jpg from reports/), but external images, fonts and scripts do not, so draw charts as inline SVG. Deliver the result with send_file.",
    {
      source: z.string().describe("Markdown (.md) or HTML (.html) file, relative to the workspace"),
      output: z.string().optional().describe("PDF path relative to the workspace; defaults to the source path with .pdf"),
    },
    async ({ source, output }) => {
      const src = resolveInside(WORKSPACE_DIR, source);
      if (!src) return fail(`${source} is outside the workspace.`);
      if (!fs.existsSync(src) || !fs.statSync(src).isFile()) return fail(`${source} is not an existing file.`);
      if (!PDF_SOURCE_EXTS.has(path.extname(src).toLowerCase())) return fail("Only .md and .html files can be rendered.");
      const outRel = output ?? `${source.slice(0, source.length - path.extname(source).length)}.pdf`;
      const out = resolveInside(WORKSPACE_DIR, outRel);
      if (!out) return fail(`${outRel} is outside the workspace.`);
      if (path.extname(out).toLowerCase() !== ".pdf") return fail("The output must end in .pdf.");
      try {
        const { bytes } = await renderPdf(src, out);
        const rel = path.relative(WORKSPACE_DIR, out);
        log.info(`agent rendered ${rel} (${bytes} bytes)`);
        return ok(`Wrote ${rel} (${humanSize(bytes)}).`);
      } catch (err) {
        if (isRendererMissing(err)) return fail("PDF rendering is not set up on this machine (npm run setup:pdf). Send Markdown instead.");
        return fail(`Rendering failed: ${describeError(err)}`);
      }
    },
  );

  // One generator per task, so the image cap applies per task.
  const generateImages = createImageGenerator({ root: WORKSPACE_DIR });
  const generateImage = tool(
    "generate_image",
    `Generate images from a text prompt with MiniMax image-01 and save them as JPEG in the workspace. Use it when the user asks for an image, or for illustrative visuals such as a report cover; never for charts or data, which you draw as inline SVG. Every call is billed, even when it fails or times out, so never retry a failed call on your own. At most ${MAX_IMAGES_PER_CALL} images per call and ${MAX_IMAGES_PER_TASK} per task. Read each image to check it before using it; send_file delivers .jpg files as WeChat image messages.`,
    {
      prompt: z.string().min(1).describe("What the image shows: subject, style, composition, lighting. English or Chinese"),
      aspect_ratio: z.enum(ASPECT_RATIOS).describe("16:9 for covers and wide illustrations, 1:1 or 3:4 for phone viewing"),
      n: z.number().int().min(1).max(MAX_IMAGES_PER_CALL).optional().describe("Number of variants; default 1"),
      output: z
        .string()
        .optional()
        .describe("JPEG path relative to the workspace (.jpg). With n > 1 the files are <stem>_001.jpg and so on. Defaults to images/<date>/<slug>.jpg"),
    },
    async ({ prompt, aspect_ratio, n, output }) => {
      try {
        const { files, failed } = await generateImages({ prompt, aspectRatio: aspect_ratio, n, output });
        const note = failed ? ` ${failed} of ${files.length + failed} images failed.` : "";
        return ok(`Generated ${files.join(", ")}.${note}`);
      } catch (err) {
        return fail(describeError(err));
      }
    },
  );

  return createSdkMcpServer({
    name: "alfred",
    version: "0.1.0",
    tools: [sendFile, moveFile, renderPdfTool, generateImage],
    alwaysLoad: true,
  });
}
