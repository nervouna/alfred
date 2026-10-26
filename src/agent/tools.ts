// In-process MCP tools that let the agent reach the owner and act on the workspace.

import fs from "node:fs";
import path from "node:path";

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { DeliveredDocument, Outbound } from "../channels.ts";
import { type Documents, deliverDocument } from "../documents/register.ts";
import { humanSize } from "../files.ts";
import { describeError, log } from "../log.ts";
import { PDF_SOURCE_EXTS, isRendererMissing, renderPdf } from "../pdf.ts";
import type { RunRecorder } from "../runs.ts";
import { WORKSPACE_DIR } from "../store.ts";
import { resolveInside } from "./guard.ts";
import { ASPECT_RATIOS, MAX_IMAGES_PER_CALL, MAX_IMAGES_PER_TASK, createImageGenerator } from "./image.ts";
import { QUESTION_HOOK_TIMEOUT_SECONDS } from "./questions.ts";

export const ALFRED_TOOL_NAMES = ["mcp__alfred__deliver", "mcp__alfred__move_file", "mcp__alfred__render_pdf", "mcp__alfred__generate_image"];

/** deliver refuses a file over this size. */
const DELIVER_MAX_BYTES = 100 * 1024 * 1024;

export function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

/** Workspace-relative form of a path resolveInside returned. */
function relPath(real: string): string {
  return path.relative(fs.realpathSync(WORKSPACE_DIR), real);
}

/** The signal the SDK gives a tool call, in the `extra` argument of its handler: aborted when the turn is interrupted. */
export function callSignal(extra: unknown): AbortSignal | undefined {
  const own = (extra as { signal?: unknown } | undefined)?.signal;
  return own instanceof AbortSignal ? own : undefined;
}

/** The run's signal and a call's own, together: a tool stops when either aborts. */
export function anySignal(run: AbortSignal | undefined, call: AbortSignal | undefined): AbortSignal | undefined {
  if (!run) return call;
  return call ? AbortSignal.any([run, call]) : run;
}

/**
 * Alfred's tools, bound to the channel a run delivers on, for the duration of the run. Each one stops when
 * `signal` aborts (the run is stopped) or when its own call's signal does (the turn is interrupted). `run`
 * records the files they write, and gives a delivery its run and task. `documents` is the history of the workspace and
 * the document store: with it, a file delivered becomes a document, and a file moved takes its document along.
 */
export function alfredToolDefinitions(out: Outbound, signal?: AbortSignal, run?: RunRecorder, documents?: Documents) {
  const deliver = tool(
    "deliver",
    "Deliver a file from the workspace to the owner in the app. A delivered file becomes a document the owner can annotate in the app. Revise a delivered document in place, under the same path, since every version is kept: change the file and deliver it again, and do not write a copy under a new name. The app opens Markdown, PDF, images, video, text files and HTML reports; an HTML report opens in a sandbox where inline scripts and SVG charts work, with no network access.",
    {
      path: z.string().describe("File path, relative to the workspace or absolute inside it"),
      caption: z.string().optional().describe("Short message sent just before the file"),
    },
    async ({ path: p, caption }, extra) => {
      // Checked before anything is delivered: a delivery that has started goes on to the end.
      if (anySignal(signal, callSignal(extra))?.aborted) return fail("The task was stopped; the file was not sent.");
      const real = resolveInside(WORKSPACE_DIR, p);
      if (!real) return fail(`${p} is outside the workspace.`);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(real);
      } catch {
        return fail(`${p} does not exist.`);
      }
      if (!stat.isFile()) return fail(`${p} is not a file.`);
      if (stat.size > DELIVER_MAX_BYTES) return fail(`${p} is ${humanSize(stat.size)}, over the ${humanSize(DELIVER_MAX_BYTES)} limit.`);
      // The file becomes a document, or a new version of one. If that fails the file is still sent, without a document.
      let document: DeliveredDocument | undefined;
      if (documents) {
        try {
          document = await deliverDocument(documents, { path: relPath(real), abs: real, size: stat.size, runId: run?.id, taskId: run?.record.taskId });
        } catch (err) {
          log.warn(`registering ${relPath(real)} as a document failed, delivering it without one: ${describeError(err)}`);
        }
      }
      try {
        const kind = await out.file(real, caption, document);
        log.info(`agent delivered ${relPath(real)} as ${kind}${document ? ` (document ${document.documentId}, version ${document.version.slice(0, 8)})` : ""}`);
        return ok(`Delivered ${path.basename(real)} (${humanSize(stat.size)}) to the user as ${kind}.`);
      } catch (err) {
        const error = describeError(err);
        log.warn(`sending ${relPath(real)} failed: ${error}`);
        return fail(`Sending failed: ${error}. The file stays in the workspace. Do not retry; say in your reply that it did not arrive and where it is.`);
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
    async ({ from, to }, extra) => {
      if (anySignal(signal, callSignal(extra))?.aborted) return fail("The task was stopped; nothing was moved.");
      const src = resolveInside(WORKSPACE_DIR, from);
      const dst = resolveInside(WORKSPACE_DIR, to);
      if (!src || !dst) return fail("Both paths must be inside the workspace.");
      if (src === fs.realpathSync(WORKSPACE_DIR)) return fail("Cannot move the workspace itself.");
      if (!fs.existsSync(src)) return fail(`${from} does not exist.`);
      if (fs.existsSync(dst)) return fail(`${to} already exists.`);
      if (dst.startsWith(src + path.sep)) return fail("Cannot move a directory into itself.");
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
      const [fromRel, toRel] = [relPath(src), relPath(dst)];
      run?.moved(fromRel, toRel);
      // The move is done whatever happens to the documents: the store is told, and a failure there is only logged.
      try {
        documents?.store.move(fromRel, toRel);
      } catch (err) {
        log.warn(`moving the documents under ${fromRel} to ${toRel} failed: ${describeError(err)}`);
      }
      return ok(`Moved ${from} to ${to}.`);
    },
  );

  const renderPdfTool = tool(
    "render_pdf",
    "Convert a Markdown or HTML file in the workspace to an A4 PDF with page numbers. Only images, stylesheets and fonts inside the workspace load (reference them by relative path, e.g. ../images/<date>/cover.jpg from reports/); network URLs, files outside the workspace, iframes, embeds and scripts are blocked, so draw charts as inline SVG. Deliver the result with deliver.",
    {
      source: z.string().describe("Markdown (.md) or HTML (.html) file, relative to the workspace"),
      output: z.string().optional().describe("PDF path relative to the workspace; defaults to the source path with .pdf"),
    },
    async ({ source, output }, extra) => {
      const stop = anySignal(signal, callSignal(extra));
      if (stop?.aborted) return fail("The task was stopped; the PDF was not rendered.");
      const src = resolveInside(WORKSPACE_DIR, source);
      if (!src) return fail(`${source} is outside the workspace.`);
      if (!fs.existsSync(src) || !fs.statSync(src).isFile()) return fail(`${source} is not an existing file.`);
      if (!PDF_SOURCE_EXTS.has(path.extname(src).toLowerCase())) return fail("Only .md and .html files can be rendered.");
      const outRel = output ?? `${source.slice(0, source.length - path.extname(source).length)}.pdf`;
      const out = resolveInside(WORKSPACE_DIR, outRel);
      if (!out) return fail(`${outRel} is outside the workspace.`);
      if (path.extname(out).toLowerCase() !== ".pdf") return fail("The output must end in .pdf.");
      try {
        const { bytes } = await renderPdf(src, out, { root: WORKSPACE_DIR, signal: stop });
        const rel = path.relative(WORKSPACE_DIR, out);
        log.info(`agent rendered ${rel} (${bytes} bytes)`);
        run?.wrote(relPath(out), "render_pdf");
        return ok(`Wrote ${rel} (${humanSize(bytes)}).`);
      } catch (err) {
        // The browser was closed by the stop, so the error is the stop's and not the renderer's.
        if (stop?.aborted) return fail("The task was stopped; the PDF was not rendered.");
        if (isRendererMissing(err)) return fail("PDF rendering is not set up on this machine (npm run setup:pdf). Send Markdown instead.");
        return fail(`Rendering failed: ${describeError(err)}`);
      }
    },
  );

  // One generator per task, so the image cap applies per task.
  const generateImages = createImageGenerator({ root: WORKSPACE_DIR, signal });
  const generateImage = tool(
    "generate_image",
    `Generate images from a text prompt with MiniMax image-01 and save them as JPEG in the workspace. Use it when the user asks for an image, or for illustrative visuals such as a report cover; never for charts or data, which you draw as inline SVG. Every call is billed, even when it fails or times out, so never retry a failed call on your own. At most ${MAX_IMAGES_PER_CALL} images per call and ${MAX_IMAGES_PER_TASK} per task. Read each image to check it before using it; deliver sends .jpg files as images.`,
    {
      prompt: z.string().min(1).describe("What the image shows: subject, style, composition, lighting. English or Chinese"),
      aspect_ratio: z.enum(ASPECT_RATIOS).describe("16:9 for covers and wide illustrations, 1:1 or 3:4 for phone viewing"),
      n: z.number().int().min(1).max(MAX_IMAGES_PER_CALL).optional().describe("Number of variants; default 1"),
      output: z
        .string()
        .optional()
        .describe("JPEG path relative to the workspace (.jpg). With n > 1 the files are <stem>_001.jpg and so on. Defaults to images/<date>/<slug>.jpg"),
    },
    async ({ prompt, aspect_ratio, n, output }, extra) => {
      try {
        // The generator stops on the run's signal (given when it was made) and on this call's.
        const { files, failed } = await generateImages({ prompt, aspectRatio: aspect_ratio, n, output }, callSignal(extra));
        for (const f of files) run?.wrote(f, "generate_image");
        const note = failed ? ` ${failed} of ${files.length + failed} images failed.` : "";
        return ok(`Generated ${files.join(", ")}.${note}`);
      } catch (err) {
        return fail(describeError(err));
      }
    },
  );

  return [deliver, moveFile, renderPdfTool, generateImage];
}

/**
 * Alfred's tools as the in-process MCP server the agent's query gets (see alfredToolDefinitions). `asking` are tools
 * that wait for the owner's answer to a question (the task tools): the server waits for them as long as a question
 * does, not for the SDK's default of about a day.
 */
export function createAlfredTools(
  out: Outbound,
  signal?: AbortSignal,
  run?: RunRecorder,
  asking: SdkMcpToolDefinition<any>[] = [],
  documents?: Documents,
) {
  return createSdkMcpServer({
    name: "alfred",
    version: "0.1.0",
    tools: [...alfredToolDefinitions(out, signal, run, documents), ...asking],
    alwaysLoad: true,
    ...(asking.length ? { timeout: QUESTION_HOOK_TIMEOUT_SECONDS * 1000 } : {}),
  });
}
