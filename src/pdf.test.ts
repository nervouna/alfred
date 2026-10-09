import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";

import { isRendererMissing, markdownToHtml, renderPdf } from "./pdf.ts";

test("markdownToHtml renders GFM tables and takes the title from the first H1", () => {
  const html = markdownToHtml("# 报告 <草稿>\n\n| a | b |\n| - | - |\n| 1 | 2 |\n", "fallback");
  assert.match(html, /<title>报告 &lt;草稿&gt;<\/title>/);
  assert.match(html, /<table>/);
  assert.match(html, /<td>2<\/td>/);
  assert.match(html, /@page|font-family/);
});

test("markdownToHtml falls back to the given title without an H1", () => {
  assert.match(markdownToHtml("plain text", "notes"), /<title>notes<\/title>/);
});

/** A solid grey RGB PNG. The tests tell images apart by their size. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolor
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(Array<Buffer>(height).fill(row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

interface PdfObject {
  dict: string;
  data?: Buffer;
}

/** Indirect objects of a PDF as Chrome writes it (no object streams, direct stream lengths), Flate streams inflated. */
function pdfObjects(pdf: Buffer): Map<string, PdfObject> {
  const src = pdf.toString("latin1");
  const objects = new Map<string, PdfObject>();
  const header = /(\d+) 0 obj\b/g;
  for (let m = header.exec(src); m; m = header.exec(src)) {
    const start = header.lastIndex;
    const end = src.indexOf("endobj", start);
    const streamAt = src.indexOf("stream", start);
    if (streamAt === -1 || streamAt > end) {
      objects.set(m[1]!, { dict: src.slice(start, end) });
      continue;
    }
    const dict = src.slice(start, streamAt);
    const dataStart = streamAt + (src.startsWith("stream\r\n", streamAt) ? 8 : 7);
    const length = Number(/\/Length\s+(\d+)/.exec(dict)?.[1]);
    const raw = pdf.subarray(dataStart, dataStart + length);
    objects.set(m[1]!, { dict, data: dict.includes("/FlateDecode") ? zlib.inflateSync(raw) : raw });
    header.lastIndex = dataStart + length;
  }
  return objects;
}

/** Sizes of the embedded raster images, as "WxH". */
function pdfImageSizes(pdf: Buffer): string[] {
  return [...pdfObjects(pdf).values()]
    .map(({ dict }) => /\/Subtype\s*\/Image/.test(dict) && /\/Width (\d+)[\s\S]*?\/Height (\d+)/.exec(dict))
    .filter((m) => !!m)
    .map((m) => `${m[1]}x${m[2]}`);
}

/** The drawn text: each glyph run mapped through its font's ToUnicode CMap. */
function pdfText(pdf: Buffer): string {
  const objects = pdfObjects(pdf);
  const utf16 = (hex: string) => Buffer.from(hex, "hex").swap16().toString("utf16le");
  const cmapOf = new Map<string, Map<number, string>>(); // font object id -> glyph id -> text
  for (const [id, { dict }] of objects) {
    const ref = /\/ToUnicode (\d+) 0 R/.exec(dict)?.[1];
    const cmap = ref ? objects.get(ref)?.data?.toString("latin1") : undefined;
    if (!cmap) continue;
    const glyphs = new Map<number, string>();
    for (const [, block = ""] of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const [, g = "", text = ""] of block.matchAll(/<(\w+)>\s*<(\w+)>/g)) glyphs.set(parseInt(g, 16), utf16(text));
    }
    for (const [, block = ""] of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const [, lo = "", hi = "", first = ""] of block.matchAll(/<(\w+)>\s*<(\w+)>\s*<(\w+)>/g)) {
        for (let g = parseInt(lo, 16); g <= parseInt(hi, 16); g++) {
          glyphs.set(g, String.fromCodePoint(parseInt(first, 16) + g - parseInt(lo, 16)));
        }
      }
    }
    cmapOf.set(id, glyphs);
  }
  const fonts = new Map<string, Map<number, string>>(); // resource name -> glyph id -> text
  for (const { dict } of objects.values()) {
    for (const [, entries = ""] of dict.matchAll(/\/Font\s*<<([^>]*)>>/g)) {
      for (const [, name = "", ref = ""] of entries.matchAll(/\/(\S+)\s+(\d+) 0 R/g)) {
        const glyphs = cmapOf.get(ref);
        if (glyphs) fonts.set(name, glyphs);
      }
    }
  }
  let text = "";
  for (const { dict, data } of objects.values()) {
    if (!data || /\/Subtype\s*\/Image|\/Length1/.test(dict)) continue;
    let font: Map<number, string> | undefined;
    for (const [, name, run] of data.toString("latin1").matchAll(/\/(\S+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f]+)>/g)) {
      if (name) font = fonts.get(name);
      else if (font && run) for (let i = 0; i < run.length; i += 4) text += font.get(parseInt(run.slice(i, i + 4), 16)) ?? "";
    }
    text += "\n";
  }
  return text;
}

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-pdf-")));
const root = path.join(tmp, "workspace");
const outside = path.join(tmp, "outside");
for (const dir of ["reports", "images", "notes"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
fs.mkdirSync(outside);
fs.writeFileSync(path.join(root, "images", "in.png"), png(3, 2));
fs.writeFileSync(path.join(root, "notes", "frame.txt"), "INSIDEFRAMEMARKER\n");
fs.writeFileSync(path.join(outside, "secret.txt"), "OUTSIDESECRETMARKER\n");
fs.writeFileSync(path.join(outside, "out.png"), png(5, 7));
fs.writeFileSync(path.join(outside, "linked.png"), png(7, 5));
fs.symlinkSync(path.join(outside, "linked.png"), path.join(root, "images", "escape.png"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Renders `source` inside `root` and returns the PDF, or skips the test when the renderer is not installed. */
async function render(t: TestContext, source: string): Promise<Buffer | undefined> {
  const out = path.join(tmp, `${path.basename(source)}.pdf`);
  try {
    await renderPdf(source, out, { root });
  } catch (err) {
    if (!isRendererMissing(err)) throw err;
    t.skip("Chrome Headless Shell is not installed (npm run setup:pdf)");
    return undefined;
  }
  return fs.readFileSync(out);
}

test("renderPdf refuses a source outside the root", async () => {
  await assert.rejects(renderPdf(path.join(outside, "page.html"), path.join(tmp, "x.pdf"), { root }), /is outside/);
});

test("renderPdf keeps out-of-root files, symlink escapes and frames out of an HTML report", async (t) => {
  const secret = pathToFileURL(path.join(outside, "secret.txt")).href;
  const source = path.join(root, "reports", "leak.html");
  fs.writeFileSync(
    source,
    `<!doctype html>
<html><head><meta charset="utf-8"></head><body>
<p>Workspace report</p>
<iframe src="${secret}"></iframe>
<object data="${secret}"></object>
<embed src="${secret}">
<iframe src="../notes/frame.txt"></iframe>
<img src="${pathToFileURL(path.join(outside, "out.png")).href}">
<img src="../images/escape.png">
<img src="../images/in.png">
</body></html>
`,
  );
  const pdf = await render(t, source);
  if (!pdf) return;
  const text = pdfText(pdf);
  assert.match(text, /Workspace report/);
  assert.doesNotMatch(text, /OUTSIDESECRETMARKER/);
  assert.doesNotMatch(text, /INSIDEFRAMEMARKER/);
  // Refused images show up as Chrome's broken-image icon, which is fine.
  const images = pdfImageSizes(pdf);
  assert.ok(images.includes("3x2"), `workspace image missing: ${images}`);
  assert.ok(!images.includes("5x7"), "out-of-root image embedded");
  assert.ok(!images.includes("7x5"), "image behind a symlink out of the root embedded");
});

test("renderPdf embeds relative workspace images in Markdown but not absolute paths outside the root", async (t) => {
  const source = path.join(root, "reports", "report.md");
  fs.writeFileSync(source, `# Report\n\n![in](../images/in.png)\n\n![out](${path.join(outside, "out.png")})\n`);
  const pdf = await render(t, source);
  if (!pdf) return;
  assert.match(pdfText(pdf), /Report/);
  const images = pdfImageSizes(pdf);
  assert.ok(images.includes("3x2"), `workspace image missing: ${images}`);
  assert.ok(!images.includes("5x7"), "out-of-root image embedded");
});

test("renderPdf embeds workspace images referenced by relative path", async (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "alfred-pdf-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.mkdirSync(path.join(ws, "images"));
  fs.mkdirSync(path.join(ws, "reports"));
  fs.writeFileSync(path.join(ws, "images", "cover.png"), png(37, 23));
  const source = path.join(ws, "reports", "r.md");
  fs.writeFileSync(source, "# Report\n\n![cover](../images/cover.png)\n");
  const output = path.join(ws, "reports", "r.pdf");
  try {
    await renderPdf(source, output, { root: ws });
  } catch (err) {
    if (isRendererMissing(err)) return t.skip("Chrome Headless Shell is not installed (npm run setup:pdf)");
    throw err;
  }
  const pdf = fs.readFileSync(output).toString("latin1");
  assert.match(pdf, /\/Width 37\b/);
  assert.match(pdf, /\/Height 23\b/);
});
