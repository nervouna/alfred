// PoC handler: echoes text, saves inbound media, and exposes commands that
// exercise the parts of the iLink protocol the real assistant will rely on.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { reply } from "./bot.ts";
import type { BotContext, MessageHandler } from "./bot.ts";
import { downloadInboundMedia, imageExtension, parseMessage } from "./ilink/inbound.ts";
import type { InboundMedia } from "./ilink/inbound.ts";
import { sendMedia } from "./ilink/send.ts";
import type { WeixinMessage } from "./ilink/types.ts";
import { describeError, log, mask } from "./log.ts";
import { WORKSPACE_DIR } from "./store.ts";

const MAX_DELAY_S = 24 * 60 * 60;

const HELP = `Alfred echo bot (PoC)
Text is echoed back. Images, files, video and voice are saved to the workspace.

/help  this message
/status  bot and session info
/typing [s]  show "typing…" for s seconds (default 10)
/delay <s>  reply after s seconds, reusing the current context token
/long [n]  send n characters (default 9000) to test chunking
/md  send a Markdown sample
/file  send a generated Markdown file
/sendback  send the last received image/file/video back`;

/** Last saved media per user, for /sendback. */
const lastMedia = new Map<string, { filePath: string; fileName: string }>();

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function localDate(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localTime(d = new Date()): string {
  return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Strip path components and characters that are unsafe in file names. */
export function sanitizeFileName(name: string | undefined, fallback: string): string {
  const base = path.basename((name ?? "").replace(/\\/g, "/"));
  const cleaned = base.replace(/[\x00-\x1f<>:"/\\|?*]/g, "_").trim().slice(0, 200);
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  return cleaned.startsWith(".") ? `_${cleaned}` : cleaned;
}

/** Pick a path in `dir` that does not exist yet. */
function uniquePath(dir: string, fileName: string): string {
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  let candidate = path.join(dir, fileName);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${stem}-${i}${ext}`);
  return candidate;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function humanAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s}s`;
  if (s < 7200) return `${Math.round(s / 60)}min`;
  return `${(s / 3600).toFixed(1)}h`;
}

async function saveMedia(ctx: BotContext, userId: string, m: InboundMedia): Promise<string> {
  const data = await downloadInboundMedia(m, ctx.cdnBaseUrl);
  const time = localTime();
  const fileName =
    m.kind === "file"
      ? sanitizeFileName(m.fileName, `file-${time}.bin`)
      : m.kind === "image"
        ? `image-${time}${imageExtension(data)}`
        : m.kind === "video"
          ? `video-${time}.mp4`
          : `voice-${time}.silk`;
  const dir = path.join(WORKSPACE_DIR, "inbox", localDate());
  fs.mkdirSync(dir, { recursive: true });
  const filePath = uniquePath(dir, fileName);
  fs.writeFileSync(filePath, data);
  if (m.kind !== "voice") lastMedia.set(userId, { filePath, fileName: path.basename(filePath) });

  const md5 = crypto.createHash("md5").update(data).digest("hex");
  const md5Note = m.declaredMd5 ? (m.declaredMd5.toLowerCase() === md5 ? ", md5 ok" : ", md5 MISMATCH") : "";
  log.info(`saved ${m.kind} ${filePath} (${data.length} bytes)`);
  return `${m.kind}: saved ${path.relative(WORKSPACE_DIR, filePath)} (${humanSize(data.length)}${md5Note})`;
}

function markdownSample(): string {
  return [
    "# Heading 1",
    "## Heading 2",
    "##### Heading 5",
    "",
    "**bold** *italic* ~~strike~~ `inline code`",
    "斜体中文：*这是斜体*",
    "",
    "- bullet one",
    "- bullet two",
    "1. numbered",
    "",
    "> blockquote",
    "",
    "| col A | col B |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "```ts",
    "const answer = 42;",
    "```",
    "",
    "[link](https://example.com) ![image](https://example.com/x.png)",
  ].join("\n");
}

function longSample(n: number): string {
  const lines: string[] = [];
  let total = 0;
  for (let i = 1; total < n; i++) {
    const line = `${String(i).padStart(4, "0")} 这是第 ${i} 行，用于测试长消息分片。The quick brown fox.`;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.join("\n").slice(0, n);
}

async function handleCommand(ctx: BotContext, from: string, cmd: string, arg: string): Promise<void> {
  switch (cmd) {
    case "/help":
      return reply(ctx, from, HELP);

    case "/status": {
      const entry = ctx.tokens.get(from);
      return reply(
        ctx,
        from,
        [
          `bot: ${ctx.account.botId}`,
          `owner: ${mask(ctx.account.ownerUserId)}`,
          `logged in: ${ctx.account.loggedInAt}`,
          `uptime: ${humanAge(Date.now() - ctx.startedAt)}`,
          `context token: ${entry ? `${mask(entry.token)}, refreshed ${humanAge(Date.now() - entry.updatedAt)} ago` : "none"}`,
          `workspace: ${WORKSPACE_DIR}`,
        ].join("\n"),
      );
    }

    case "/typing": {
      const seconds = Math.min(Math.max(Number(arg) || 10, 1), 120);
      const stop = await ctx.typing.start(from);
      await new Promise((r) => setTimeout(r, seconds * 1000));
      await stop();
      return reply(ctx, from, `typing indicator ran for ${seconds}s`);
    }

    case "/delay": {
      const seconds = Number(arg);
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_DELAY_S) {
        return reply(ctx, from, `usage: /delay <seconds>, 1..${MAX_DELAY_S}`);
      }
      const askedAt = new Date();
      // Not queued: other messages keep flowing while this waits.
      setTimeout(() => {
        reply(ctx, from, `delayed reply: asked at ${askedAt.toLocaleTimeString()}, waited ${seconds}s`).catch((err) =>
          log.error(`delayed reply after ${seconds}s failed: ${describeError(err)}`),
        );
      }, seconds * 1000);
      return reply(ctx, from, `ok, replying in ${seconds}s`);
    }

    case "/long": {
      const n = Math.min(Math.max(Number(arg) || 9000, 100), 50_000);
      return reply(ctx, from, longSample(n));
    }

    case "/md":
      return reply(ctx, from, markdownSample());

    case "/file": {
      const dir = path.join(WORKSPACE_DIR, "outbox");
      fs.mkdirSync(dir, { recursive: true });
      const fileName = `alfred-test-${localDate()}-${localTime()}.md`;
      const content = `# Alfred file delivery test\n\nGenerated at ${new Date().toISOString()}.\n\n${markdownSample()}\n`;
      fs.writeFileSync(path.join(dir, fileName), content);
      const kind = await sendMedia({
        client: ctx.client,
        cdnBaseUrl: ctx.cdnBaseUrl,
        to: from,
        data: Buffer.from(content),
        fileName,
        contextToken: ctx.tokens.get(from)?.token,
      });
      return reply(ctx, from, `sent ${fileName} as ${kind}; check whether WeChat lets you open it`);
    }

    case "/sendback": {
      const last = lastMedia.get(from);
      if (!last) return reply(ctx, from, "nothing received yet since startup");
      const kind = await sendMedia({
        client: ctx.client,
        cdnBaseUrl: ctx.cdnBaseUrl,
        to: from,
        data: fs.readFileSync(last.filePath),
        fileName: last.fileName,
        contextToken: ctx.tokens.get(from)?.token,
      });
      return reply(ctx, from, `sent back ${last.fileName} as ${kind}`);
    }

    default:
      return reply(ctx, from, `unknown command ${cmd}\n\n${HELP}`);
  }
}

export const echoHandler: MessageHandler = async (ctx: BotContext, msg: WeixinMessage) => {
  const from = msg.from_user_id ?? "";
  const { text, media, quotedText } = parseMessage(msg);
  try {
    const trimmed = text.trim();
    if (trimmed.startsWith("/") && media.length === 0) {
      const [cmd = "", ...rest] = trimmed.split(/\s+/);
      await handleCommand(ctx, from, cmd.toLowerCase(), rest.join(" "));
      return;
    }

    const lines: string[] = [];
    for (const m of media) {
      try {
        lines.push(await saveMedia(ctx, from, m));
      } catch (err) {
        log.error(`saving ${m.kind} failed: ${describeError(err)}`);
        lines.push(`${m.kind}: failed to save (${describeError(err)})`);
      }
    }
    if (text) lines.push(media.some((m) => m.kind === "voice") ? `transcript: ${text}` : `echo: ${text}`);
    if (quotedText) lines.push(`quoting: ${quotedText}`);
    if (lines.length === 0) lines.push(`received an unsupported message (item types ${msg.item_list?.map((i) => i.type).join(",")})`);
    await reply(ctx, from, lines.join("\n"));
  } catch (err) {
    log.error(`echo handler error: ${describeError(err)}`);
    await reply(ctx, from, `error: ${describeError(err)}`).catch(() => {});
  }
};
