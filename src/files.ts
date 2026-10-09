import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { downloadInboundMedia, imageExtension } from "./ilink/inbound.ts";
import type { InboundMedia } from "./ilink/inbound.ts";
import { log } from "./log.ts";
import { WORKSPACE_DIR } from "./store.ts";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function localDate(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function localTime(d = new Date()): string {
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
export function uniquePath(dir: string, fileName: string): string {
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  let candidate = path.join(dir, fileName);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${stem}-${i}${ext}`);
  return candidate;
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function humanAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s}s`;
  if (s < 7200) return `${Math.round(s / 60)}min`;
  return `${(s / 3600).toFixed(1)}h`;
}

export interface SavedMedia {
  filePath: string;
  /** Path relative to the workspace, as shown to the user and the agent. */
  relPath: string;
  size: number;
  /** Undefined when the server declared no md5. */
  md5Ok?: boolean;
}

/** Download an inbound media item into workspace/inbox/<date>/. */
export async function saveInboundMedia(m: InboundMedia, cdnBaseUrl: string): Promise<SavedMedia> {
  const data = await downloadInboundMedia(m, cdnBaseUrl);
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
  log.info(`saved ${m.kind} ${filePath} (${data.length} bytes)`);

  const md5 = crypto.createHash("md5").update(data).digest("hex");
  return {
    filePath,
    relPath: path.relative(WORKSPACE_DIR, filePath),
    size: data.length,
    md5Ok: m.declaredMd5 ? m.declaredMd5.toLowerCase() === md5 : undefined,
  };
}
