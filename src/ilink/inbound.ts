// Inbound message parsing and media download.
// Key-selection rules ported from Tencent/openclaw-weixin (MIT), src/media/media-download.ts. See NOTICE.

import { downloadMedia, parseAesKey } from "./cdn.ts";
import { MessageItemType } from "./types.ts";
import type { CDNMedia, MessageItem, WeixinMessage } from "./types.ts";

export const MEDIA_MAX_BYTES = 100 * 1024 * 1024;

export type MediaKind = "image" | "voice" | "file" | "video";

export interface InboundMedia {
  kind: MediaKind;
  item: MessageItem;
  /** Original file name, only present for file attachments. */
  fileName?: string;
  /** Declared plaintext size, when the server provides it. */
  declaredSize?: number;
  declaredMd5?: string;
}

export interface ParsedMessage {
  /** Text content, or the voice transcript when the message is a voice note. */
  text: string;
  media: InboundMedia[];
  /** Text of a quoted message, if the user replied to one. */
  quotedText?: string;
}

export function parseMessage(msg: WeixinMessage): ParsedMessage {
  let text = "";
  let quotedText: string | undefined;
  const media: InboundMedia[] = [];
  for (const item of msg.item_list ?? []) {
    switch (item.type) {
      case MessageItemType.TEXT:
        text ||= item.text_item?.text ?? "";
        quotedText ??= item.ref_msg?.message_item?.text_item?.text ?? item.ref_msg?.title;
        break;
      case MessageItemType.IMAGE:
        media.push({ kind: "image", item });
        break;
      case MessageItemType.VOICE:
        text ||= item.voice_item?.text ?? "";
        media.push({ kind: "voice", item });
        break;
      case MessageItemType.FILE: {
        const len = Number(item.file_item?.len);
        media.push({
          kind: "file",
          item,
          fileName: item.file_item?.file_name,
          declaredSize: Number.isFinite(len) ? len : undefined,
          declaredMd5: item.file_item?.md5,
        });
        break;
      }
      case MessageItemType.VIDEO:
        media.push({ kind: "video", item, declaredSize: item.video_item?.video_size });
        break;
    }
  }
  return { text, media, quotedText };
}

function mediaRef(m: InboundMedia): CDNMedia | undefined {
  const it = m.item;
  return { image: it.image_item?.media, voice: it.voice_item?.media, file: it.file_item?.media, video: it.video_item?.media }[
    m.kind
  ];
}

/**
 * Download and decrypt an inbound media item. Images prefer `image_item.aeskey`
 * (hex) and may be stored unencrypted; other kinds require `media.aes_key`.
 */
export async function downloadInboundMedia(m: InboundMedia, cdnBaseUrl: string): Promise<Buffer> {
  const ref = mediaRef(m);
  if (!ref || (!ref.full_url && !ref.encrypt_query_param)) throw new Error(`${m.kind} has no CDN reference`);
  if (m.declaredSize !== undefined && m.declaredSize > MEDIA_MAX_BYTES) {
    throw new Error(`${m.kind} is ${m.declaredSize} bytes, over the ${MEDIA_MAX_BYTES} byte limit`);
  }

  let key: Buffer | undefined;
  if (m.kind === "image") {
    const hex = m.item.image_item?.aeskey;
    key = hex ? Buffer.from(hex, "hex") : ref.aes_key ? parseAesKey(ref.aes_key) : undefined;
  } else {
    if (!ref.aes_key) throw new Error(`${m.kind} has no aes_key`);
    key = parseAesKey(ref.aes_key);
  }
  const data = await downloadMedia(ref, cdnBaseUrl, key);
  if (data.length > MEDIA_MAX_BYTES) throw new Error(`${m.kind} exceeds ${MEDIA_MAX_BYTES} bytes`);
  return data;
}

/** Guess an image extension from magic bytes. */
export function imageExtension(data: Buffer): string {
  if (data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return ".jpg";
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  if (data.subarray(0, 4).toString("ascii") === "GIF8") return ".gif";
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") {
    return ".webp";
  }
  return ".bin";
}
