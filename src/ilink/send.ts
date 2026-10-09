// Outbound message builders.
// Message shapes ported from Tencent/openclaw-weixin (MIT), src/messaging/send.ts. See NOTICE.

import crypto from "node:crypto";
import path from "node:path";

import { uploadMedia } from "./cdn.ts";
import type { IlinkClient } from "./client.ts";
import { MessageItemType, MessageState, MessageType, UploadMediaType } from "./types.ts";
import type { MessageItem } from "./types.ts";

/** Per-message text limit used by the reference client. */
export const TEXT_CHUNK_LIMIT = 4000;

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v"]);

function clientId(): string {
  return `alfred:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * Split text into chunks of at most `limit` code points, preferring to break
 * after a newline in the second half of a chunk.
 */
export function chunkText(text: string, limit = TEXT_CHUNK_LIMIT): string[] {
  const chars = Array.from(text);
  if (chars.length <= limit) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = Math.min(start + limit, chars.length);
    if (end < chars.length) {
      const newline = chars.lastIndexOf("\n", end - 1);
      if (newline >= start + limit / 2) end = newline + 1;
    }
    chunks.push(chars.slice(start, end).join(""));
    start = end;
  }
  return chunks;
}

/** Send one item as its own message; the protocol expects a single item per request. */
export async function sendItem(params: {
  client: IlinkClient;
  to: string;
  item: MessageItem;
  contextToken: string | undefined;
}): Promise<string | undefined> {
  const resp = await params.client.sendMessage({
    msg: {
      from_user_id: "",
      to_user_id: params.to,
      client_id: clientId(),
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: [params.item],
      context_token: params.contextToken,
    },
  });
  return resp.message_id;
}

export async function sendText(params: {
  client: IlinkClient;
  to: string;
  text: string;
  contextToken: string | undefined;
}): Promise<void> {
  for (const chunk of chunkText(params.text)) {
    await sendItem({ ...params, item: { type: MessageItemType.TEXT, text_item: { text: chunk } } });
  }
}

export type OutboundKind = "image" | "video" | "file";

export function outboundKind(fileName: string): OutboundKind {
  const ext = path.extname(fileName).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  return "file";
}

/** Upload `data` and send it as an image, video or file attachment based on `fileName`. */
export async function sendMedia(params: {
  client: IlinkClient;
  cdnBaseUrl: string;
  to: string;
  data: Buffer;
  fileName: string;
  contextToken: string | undefined;
}): Promise<OutboundKind> {
  const { client, cdnBaseUrl, to, data, fileName, contextToken } = params;
  const kind = outboundKind(fileName);
  const mediaType = { image: UploadMediaType.IMAGE, video: UploadMediaType.VIDEO, file: UploadMediaType.FILE }[kind];
  const uploaded = await uploadMedia({ client, cdnBaseUrl, data, mediaType, toUserId: to });
  const media = {
    encrypt_query_param: uploaded.downloadParam,
    aes_key: Buffer.from(uploaded.aesKeyHex).toString("base64"),
    encrypt_type: 1,
  };

  let item: MessageItem;
  if (kind === "image") {
    item = { type: MessageItemType.IMAGE, image_item: { media, mid_size: uploaded.cipherSize } };
  } else if (kind === "video") {
    item = { type: MessageItemType.VIDEO, video_item: { media, video_size: uploaded.cipherSize } };
  } else {
    item = {
      type: MessageItemType.FILE,
      file_item: { media, file_name: fileName, len: String(uploaded.plainSize) },
    };
  }
  await sendItem({ client, to, item, contextToken });
  return kind;
}
