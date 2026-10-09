// WeChat iLink bot protocol types.
// Ported from Tencent/openclaw-weixin (MIT), src/api/types.ts. See NOTICE.

export interface BaseInfo {
  channel_version?: string;
  /** Self-declared client identity (UA-style), used by the server for observability only. */
  bot_agent?: string;
}

export const UploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
} as const;
export type UploadMediaType = (typeof UploadMediaType)[keyof typeof UploadMediaType];

export const MessageType = {
  NONE: 0,
  USER: 1,
  BOT: 2,
} as const;

export const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
  TOOL_CALL_START: 11,
  TOOL_CALL_RESULT: 12,
} as const;

export const MessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const;

export const TypingStatus = {
  TYPING: 1,
  CANCEL: 2,
} as const;

/** CDN media reference. `aes_key` is base64 of either 16 raw bytes or a 32-char hex string. */
export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
}

export interface TextItem {
  text?: string;
}

export interface ImageItem {
  media?: CDNMedia;
  thumb_media?: CDNMedia;
  /** Raw AES-128 key as hex; preferred over media.aes_key for inbound decryption. */
  aeskey?: string;
  url?: string;
  mid_size?: number;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
  hd_size?: number;
}

export interface VoiceItem {
  media?: CDNMedia;
  /** 1=pcm 2=adpcm 3=feature 4=speex 5=amr 6=silk 7=mp3 8=ogg-speex */
  encode_type?: number;
  bits_per_sample?: number;
  sample_rate?: number;
  /** Duration in ms. */
  playtime?: number;
  /** Server-side speech-to-text transcript. */
  text?: string;
}

export interface FileItem {
  media?: CDNMedia;
  file_name?: string;
  md5?: string;
  /** Plaintext size in bytes, as a decimal string. */
  len?: string;
}

export interface VideoItem {
  media?: CDNMedia;
  video_size?: number;
  play_length?: number;
  video_md5?: string;
  thumb_media?: CDNMedia;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
}

export interface RefMessage {
  message_item?: MessageItem;
  title?: string;
  svr_id?: string;
}

export interface MessageItem {
  type?: number;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
  ref_msg?: RefMessage;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
}

export interface WeixinMessage {
  seq?: number;
  /** uint64 on the wire; parsed losslessly as a string. */
  message_id?: string;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  delete_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  run_id?: string;
}

export interface GetUpdatesResp {
  ret?: number;
  /** -14 means the bot token is stale. */
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  /** Server-suggested timeout for the next long-poll. */
  longpolling_timeout_ms?: number;
}

export interface SendMessageReq {
  msg: WeixinMessage;
}

export interface SendMessageResp {
  message_id?: string;
  ret?: number;
  errmsg?: string;
}

export interface GetUploadUrlReq {
  filekey: string;
  media_type: UploadMediaType;
  to_user_id: string;
  rawsize: number;
  rawfilemd5: string;
  /** Ciphertext size after AES-128-ECB + PKCS#7 padding. */
  filesize: number;
  no_need_thumb: boolean;
  /** AES key as hex. */
  aeskey: string;
}

export interface GetUploadUrlResp {
  upload_param?: string;
  thumb_upload_param?: string;
  upload_full_url?: string;
}

export interface GetConfigResp {
  ret?: number;
  errmsg?: string;
  typing_ticket?: string;
}

export interface SimpleResp {
  ret?: number;
  errmsg?: string;
}

export type QrStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "scaned_but_redirect"
  | "need_verifycode"
  | "verify_code_blocked"
  | "binded_redirect";

export interface QrCodeResp {
  qrcode: string;
  qrcode_img_content: string;
}

export interface QrStatusResp {
  status: QrStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  /** WeChat user who scanned the QR code, i.e. the bot owner. */
  ilink_user_id?: string;
  redirect_host?: string;
}
