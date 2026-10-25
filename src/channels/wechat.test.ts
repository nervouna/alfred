import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { BotContext } from "../bot.ts";
import type { WeixinMessage } from "../ilink/types.ts";

// store.ts reads these at import time, so set them before loading the modules under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-wechat-")));
process.env.ALFRED_WORKSPACE = path.join(tmp, "workspace");
process.env.ALFRED_STATE_DIR = path.join(tmp, "state");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const cdn = http.createServer((_req, res) => res.end(PNG));
await new Promise<void>((resolve) => cdn.listen(0, "127.0.0.1", resolve));
const cdnUrl = `http://127.0.0.1:${(cdn.address() as AddressInfo).port}/image`;
after(() => {
  cdn.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const { WeChatChannel, wechatHandler } = await import("./wechat.ts");

interface Sent {
  to?: string;
  text?: string;
  contextToken?: string;
}

/** A bot context on a fake iLink client that records what it is asked to send. */
function fakeContext(opts: { refuse?: boolean } = {}) {
  const sent: Sent[] = [];
  const typing = { started: 0, stopped: 0 };
  const client = {
    async sendMessage(req: { msg: { to_user_id?: string; context_token?: string; item_list?: { text_item?: { text?: string } }[] } }) {
      if (opts.refuse) throw new Error("sendMessage failed: ret=-2");
      sent.push({ to: req.msg.to_user_id, text: req.msg.item_list?.[0]?.text_item?.text, contextToken: req.msg.context_token });
      return { ret: 0 };
    },
    async getUploadUrl() {
      throw new Error("uploads are not available");
    },
  };
  const ctx = {
    client,
    account: { botToken: "x", botId: "b@im.bot", baseUrl: "https://invalid", ownerUserId: "owner@im.wechat", loggedInAt: "" },
    cdnBaseUrl: "https://invalid",
    tokens: { get: () => ({ token: "ctx-token", updatedAt: 0 }), set: () => {} },
    typing: { start: async () => (typing.started++, async () => void typing.stopped++) },
    startedAt: 0,
  } as unknown as BotContext;
  return { ctx, sent, typing };
}

const textMessage = (text: string, extra: Partial<WeixinMessage["item_list"] extends (infer I)[] | undefined ? I : never> = {}): WeixinMessage => ({
  from_user_id: "owner@im.wechat",
  item_list: [{ type: 1, text_item: { text }, ...extra }],
});

test("outbound text goes to the user with the context token, and rejects when WeChat refuses", async () => {
  const { ctx, sent } = fakeContext();
  const out = new WeChatChannel(ctx).outbound("owner@im.wechat");
  assert.equal(out.channel, "wechat");
  await out.text("你好");
  assert.deepEqual(sent, [{ to: "owner@im.wechat", text: "你好", contextToken: "ctx-token" }]);

  const refused = fakeContext({ refuse: true });
  await assert.rejects(new WeChatChannel(refused.ctx).outbound("owner@im.wechat").text("你好"), /ret=-2/);
});

test("outbound typing shows the indicator until it is stopped", async () => {
  const { ctx, typing } = fakeContext();
  const stop = await new WeChatChannel(ctx).outbound("owner@im.wechat").typing();
  assert.deepEqual([typing.started, typing.stopped], [1, 0]);
  await stop();
  assert.deepEqual([typing.started, typing.stopped], [1, 1]);
});

test("outbound file sends the caption first, and a failed upload rejects", async () => {
  const { ctx, sent } = fakeContext();
  const file = path.join(tmp, "report.md");
  fs.writeFileSync(file, "# 报告");
  await assert.rejects(new WeChatChannel(ctx).outbound("owner@im.wechat").file(file, "报告："), /uploads are not available/);
  assert.deepEqual(sent.map((s) => s.text), ["报告："]);
});

test("an iLink text message becomes Inbound with its quote", async () => {
  const { ctx } = fakeContext();
  const inbound = await new WeChatChannel(ctx).inbound(
    textMessage("这个怎么样", { ref_msg: { title: "原来的话" } }),
  );
  assert.deepEqual(inbound, { channel: "wechat", text: "这个怎么样", files: [], quotedText: "原来的话" });
});

test("a voice note is its transcript, flagged as a voice note, and is not saved", async () => {
  const { ctx } = fakeContext();
  const channel = new WeChatChannel(ctx);
  const withText = await channel.inbound({ item_list: [{ type: 3, voice_item: { text: "查一下天气" } }] });
  assert.deepEqual(withText, { channel: "wechat", text: "查一下天气", files: [], voice: true });
  const without = await channel.inbound({ item_list: [{ type: 3, voice_item: {} }] });
  assert.deepEqual(without, { channel: "wechat", text: "", files: [], voice: true });
});

test("an image is saved into the workspace inbox and becomes a file of the message", async () => {
  const { ctx } = fakeContext();
  const inbound = await new WeChatChannel(ctx).inbound({
    item_list: [{ type: 2, image_item: { media: { full_url: cdnUrl } } }, { type: 1, text_item: { text: "看图" } }],
  });
  assert.equal(inbound.text, "看图");
  assert.equal(inbound.files.length, 1);
  const [file] = inbound.files;
  assert.match(file?.path ?? "", /^inbox\/\d{4}-\d{2}-\d{2}\/image-\d{6}\.png$/);
  assert.equal(file?.kind, "image");
  assert.deepEqual(fs.readFileSync(path.join(tmp, "workspace", file?.path ?? "")), PNG);
  assert.equal(inbound.failed, undefined);
});

test("media that cannot be saved is reported in the line the owner gets, and the rest still goes through", async () => {
  const { ctx } = fakeContext();
  const inbound = await new WeChatChannel(ctx).inbound({
    item_list: [{ type: 2, image_item: {} }, { type: 1, text_item: { text: "看图" } }],
  });
  assert.deepEqual(inbound, { channel: "wechat", text: "看图", files: [], failed: ["image 保存失败：image has no CDN reference"] });
});

test("the bot's handler hands a message to the intake queue the moment it arrives, and media is saved when its turn comes", async () => {
  const { ctx } = fakeContext();
  const wechat = new WeChatChannel(ctx);
  const submitted: (() => Promise<unknown>)[] = [];
  let shutdowns = 0;
  const handler = wechatHandler(wechat, {
    submit: async (source) => void submitted.push(source as () => Promise<unknown>),
    shutdown: async () => void shutdowns++,
  });
  const done = handler(ctx, textMessage("你好"));
  assert.equal(submitted.length, 1, "submitted before the handler has awaited anything");
  await done;
  assert.deepEqual(await submitted[0]?.(), { channel: "wechat", text: "你好", files: [] });
  await handler.shutdown?.();
  assert.equal(shutdowns, 1);
});
