// The WeChat channel: Alfred's output goes out through the iLink client and the
// context tokens, and the owner's iLink messages become Inbound ones.

import fs from "node:fs";
import path from "node:path";

import type { FileRef } from "../api/schema.ts";
import { reply } from "../bot.ts";
import type { BotContext, MessageHandler } from "../bot.ts";
import type { Inbound, InboundSource, Outbound } from "../channels.ts";
import { saveInboundMedia } from "../files.ts";
import { parseMessage } from "../ilink/inbound.ts";
import { sendMedia } from "../ilink/send.ts";
import type { WeixinMessage } from "../ilink/types.ts";
import { describeError, log } from "../log.ts";

export class WeChatChannel {
  private readonly ctx: BotContext;

  constructor(ctx: BotContext) {
    this.ctx = ctx;
  }

  /** Output to one WeChat user: replies with the context token of their latest message, and the typing indicator. */
  outbound(to: string): Outbound {
    const { ctx } = this;
    return {
      channel: "wechat",
      text: (text) => reply(ctx, to, text),
      async file(absPath, caption) {
        if (caption) await reply(ctx, to, caption);
        return sendMedia({
          client: ctx.client,
          cdnBaseUrl: ctx.cdnBaseUrl,
          to,
          data: fs.readFileSync(absPath),
          fileName: path.basename(absPath),
          contextToken: ctx.tokens.get(to)?.token,
        });
      },
      typing: () => ctx.typing.start(to),
    };
  }

  /** An iLink message as Inbound: its media is saved into the workspace first, a voice note stays a transcript. */
  async inbound(msg: WeixinMessage): Promise<Inbound> {
    const { text, media, quotedText } = parseMessage(msg);
    const files: FileRef[] = [];
    const failed: string[] = [];
    for (const m of media) {
      if (m.kind === "voice") continue;
      try {
        const file = await saveInboundMedia(m, this.ctx.cdnBaseUrl);
        files.push({ path: file.relPath, kind: m.kind });
      } catch (err) {
        log.error(`saving ${m.kind} failed: ${describeError(err)}`);
        failed.push(`${m.kind} 保存失败：${describeError(err)}`);
      }
    }
    return {
      channel: "wechat",
      text,
      files,
      ...(quotedText ? { quotedText } : {}),
      ...(media.some((m) => m.kind === "voice") ? { voice: true } : {}),
      ...(failed.length ? { failed } : {}),
    };
  }
}

/**
 * The bot's handler for the agent: each message from the owner goes into the
 * intake queue as it arrives, and its media is saved when its turn comes.
 */
export function wechatHandler(
  wechat: WeChatChannel,
  agent: { submit(source: InboundSource): Promise<void>; shutdown(): Promise<void> },
): MessageHandler {
  const handler: MessageHandler = async (_ctx, msg) => agent.submit(() => wechat.inbound(msg));
  handler.shutdown = () => agent.shutdown();
  return handler;
}
