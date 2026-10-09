// WeChat CDN media transfer (AES-128-ECB encrypted).
// Ported from Tencent/openclaw-weixin (MIT), src/cdn/*. See NOTICE.

import crypto from "node:crypto";

import { log } from "../log.ts";
import type { IlinkClient } from "./client.ts";
import type { CDNMedia, UploadMediaType } from "./types.ts";

const UPLOAD_MAX_ATTEMPTS = 3;
const DOWNLOAD_TIMEOUT_MS = 120_000;

export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Ciphertext size with PKCS#7 padding (always adds 1..16 bytes). */
export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

/**
 * Decode CDNMedia.aes_key. Seen in the wild as base64 of 16 raw bytes (images)
 * or base64 of a 32-char hex string (files, voice, video).
 */
export function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) return decoded;
  const ascii = decoded.toString("ascii");
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(ascii)) return Buffer.from(ascii, "hex");
  throw new Error(`aes_key must decode to 16 bytes or 32 hex chars, got ${decoded.length} bytes`);
}

function downloadUrl(media: CDNMedia, cdnBaseUrl: string): string {
  if (media.full_url) return media.full_url;
  if (!media.encrypt_query_param) throw new Error("CDN media has neither full_url nor encrypt_query_param");
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
}

/**
 * Download one CDN object. `key` decrypts it; pass undefined for objects the
 * server stores in plaintext (some images).
 */
export async function downloadMedia(media: CDNMedia, cdnBaseUrl: string, key: Buffer | undefined): Promise<Buffer> {
  const res = await fetch(downloadUrl(media, cdnBaseUrl), { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`CDN download HTTP ${res.status} ${res.statusText}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  return key ? decryptAesEcb(bytes, key) : bytes;
}

export interface UploadedMedia {
  /** Goes into CDNMedia.encrypt_query_param of the outbound item. */
  downloadParam: string;
  /** AES key as hex; outbound CDNMedia.aes_key is base64 of this hex string. */
  aesKeyHex: string;
  plainSize: number;
  cipherSize: number;
}

/** Encrypt and upload a buffer, returning the reference to embed in sendMessage. */
export async function uploadMedia(params: {
  client: IlinkClient;
  cdnBaseUrl: string;
  data: Buffer;
  mediaType: UploadMediaType;
  toUserId: string;
}): Promise<UploadedMedia> {
  const { client, cdnBaseUrl, data, mediaType, toUserId } = params;
  const filekey = crypto.randomBytes(16).toString("hex");
  const key = crypto.randomBytes(16);
  const cipherSize = aesEcbPaddedSize(data.length);

  const urlResp = await client.getUploadUrl({
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize: data.length,
    rawfilemd5: crypto.createHash("md5").update(data).digest("hex"),
    filesize: cipherSize,
    no_need_thumb: true,
    aeskey: key.toString("hex"),
  });

  const fullUrl = urlResp.upload_full_url?.trim();
  let uploadUrl: string;
  if (fullUrl) {
    uploadUrl = fullUrl;
  } else if (urlResp.upload_param) {
    uploadUrl =
      `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(urlResp.upload_param)}` +
      `&filekey=${encodeURIComponent(filekey)}`;
  } else {
    throw new Error("getUploadUrl returned neither upload_full_url nor upload_param");
  }

  const ciphertext = encryptAesEcb(data, key);
  let lastError: unknown;
  for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
      });
      const errMsg = res.headers.get("x-error-message");
      if (res.status >= 400 && res.status < 500) {
        // Client errors are not retryable.
        throw Object.assign(new Error(`CDN upload HTTP ${res.status}: ${errMsg ?? (await res.text())}`), {
          fatal: true,
        });
      }
      if (res.status !== 200) throw new Error(`CDN upload HTTP ${res.status}: ${errMsg ?? ""}`);
      const downloadParam = res.headers.get("x-encrypted-param");
      if (!downloadParam) throw new Error("CDN upload response missing x-encrypted-param");
      return { downloadParam, aesKeyHex: key.toString("hex"), plainSize: data.length, cipherSize };
    } catch (err) {
      if ((err as { fatal?: boolean }).fatal) throw err;
      lastError = err;
      log.warn(`CDN upload attempt ${attempt}/${UPLOAD_MAX_ATTEMPTS} failed: ${String(err)}`);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("CDN upload failed");
}
