import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
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

/** Solid grey RGB PNG; an odd size tells it apart from Chrome's 14x16 broken-image icon. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)]);
  const pixels = zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk("IHDR", header), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]);
}

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
    await renderPdf(source, output);
  } catch (err) {
    if (isRendererMissing(err)) return t.skip("Chrome Headless Shell is not installed (npm run setup:pdf)");
    throw err;
  }
  const pdf = fs.readFileSync(output).toString("latin1");
  assert.match(pdf, /\/Width 37\b/);
  assert.match(pdf, /\/Height 23\b/);
});
