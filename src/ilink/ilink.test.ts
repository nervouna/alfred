import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";

import { aesEcbPaddedSize, decryptAesEcb, encryptAesEcb, parseAesKey } from "./cdn.ts";
import { parseIlinkJson } from "./client.ts";
import { imageExtension, parseMessage } from "./inbound.ts";
import { chunkText, outboundKind } from "./send.ts";
import { MessageItemType } from "./types.ts";

test("parseIlinkJson keeps uint64 ids as strings and leaves other numbers alone", () => {
  const raw = '{"ret":0,"msgs":[{"message_id": 18446744073709551615,"seq":7,"item_list":[{"msg_id":-12,"text_item":{"text":"\\"message_id\\":1"}}]}]}';
  const parsed = parseIlinkJson<{ ret: number; msgs: Array<{ message_id: string; seq: number; item_list: Array<{ msg_id: string; text_item: { text: string } }> }> }>(raw);
  assert.equal(parsed.ret, 0);
  assert.equal(parsed.msgs[0]?.message_id, "18446744073709551615");
  assert.equal(parsed.msgs[0]?.seq, 7);
  assert.equal(parsed.msgs[0]?.item_list[0]?.msg_id, "-12");
  assert.equal(parsed.msgs[0]?.item_list[0]?.text_item.text, '"message_id":1');
});

test("AES-128-ECB round trip and padded size", () => {
  const key = crypto.randomBytes(16);
  for (const size of [0, 1, 15, 16, 17, 1000]) {
    const plain = crypto.randomBytes(size);
    const cipher = encryptAesEcb(plain, key);
    assert.equal(cipher.length, aesEcbPaddedSize(size));
    assert.deepEqual(decryptAesEcb(cipher, key), plain);
  }
});

test("parseAesKey accepts raw and hex-encoded keys", () => {
  const key = crypto.randomBytes(16);
  assert.deepEqual(parseAesKey(key.toString("base64")), key);
  assert.deepEqual(parseAesKey(Buffer.from(key.toString("hex")).toString("base64")), key);
  assert.throws(() => parseAesKey(Buffer.from("short").toString("base64")));
});

test("chunkText respects the limit, prefers newlines, and keeps surrogate pairs intact", () => {
  assert.deepEqual(chunkText("hello", 10), ["hello"]);
  const text = "a".repeat(6) + "\n" + "b".repeat(6);
  assert.deepEqual(chunkText(text, 10), ["aaaaaa\n", "bbbbbb"]);
  const emoji = "😀".repeat(25);
  const chunks = chunkText(emoji, 10);
  assert.equal(chunks.length, 3);
  assert.equal(chunks.join(""), emoji);
  for (const c of chunks) assert.ok(Array.from(c).length <= 10);
});

test("outboundKind routes by extension", () => {
  assert.equal(outboundKind("a.JPG"), "image");
  assert.equal(outboundKind("clip.mp4"), "video");
  assert.equal(outboundKind("report.pdf"), "file");
});

test("imageExtension sniffs common formats", () => {
  assert.equal(imageExtension(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), ".jpg");
  assert.equal(imageExtension(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), ".png");
  assert.equal(imageExtension(Buffer.from("GIF89a")), ".gif");
  assert.equal(imageExtension(Buffer.from("RIFF0000WEBPVP8 ")), ".webp");
  assert.equal(imageExtension(Buffer.from("nope")), ".bin");
});

test("parseMessage extracts text, voice transcript, quotes and media", () => {
  const parsed = parseMessage({
    item_list: [
      { type: MessageItemType.TEXT, text_item: { text: "hi" }, ref_msg: { message_item: { text_item: { text: "earlier" } } } },
      { type: MessageItemType.FILE, file_item: { file_name: "a.pdf", len: "42", md5: "abc" } },
    ],
  });
  assert.equal(parsed.text, "hi");
  assert.equal(parsed.quotedText, "earlier");
  assert.equal(parsed.media[0]?.kind, "file");
  assert.equal(parsed.media[0]?.declaredSize, 42);

  const voice = parseMessage({ item_list: [{ type: MessageItemType.VOICE, voice_item: { text: "语音转写" } }] });
  assert.equal(voice.text, "语音转写");
  assert.equal(voice.media[0]?.kind, "voice");
});
