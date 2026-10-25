// The handler the local scripts run: the real agent handler without WeChat. Replies to the owner's
// WeChat go to a fake iLink client that records them and hands each one to a printer; the app
// channel goes to the command API (src/api/server.ts), which the script starts itself.
// handler-smoke.ts and app-dev.ts both build their handler here.

import type { BotContext } from "../src/bot.ts";
import { createAgentHandler } from "../src/agent/handler.ts";
import type { AgentHandler } from "../src/agent/handler.ts";
import { appOutbound } from "../src/channels.ts";
import { WeChatChannel } from "../src/channels/wechat.ts";
import { IlinkApiError } from "../src/ilink/client.ts";

export const OWNER = "owner@im.wechat";

/** The fake WeChat channel. `sent` holds the text of each send that went through; while `refuse` is set, sends fail as after the 24-hour window. */
export interface FakeWeChat {
  channel: WeChatChannel;
  sent: { text: string }[];
  refuse: boolean;
}

/** A WeChat channel over a fake iLink client. `print` gets the text of every send, with `refused` set when WeChat refused it. */
export function fakeWeChat(print: (text: string, refused: boolean) => void): FakeWeChat {
  const sent: { text: string }[] = [];
  const state = { refuse: false };
  const client = {
    async sendMessage(req: { msg: { item_list?: { text_item?: { text?: string } }[] } }) {
      const text = req.msg.item_list?.[0]?.text_item?.text ?? "[media]";
      if (state.refuse) {
        print(text, true);
        throw new IlinkApiError("sendMessage", { ret: -2, errmsg: "prepare failed" });
      }
      sent.push({ text });
      print(text, false);
      return { ret: 0 };
    },
    async getUploadUrl() {
      throw new Error("uploads are not available in the fake WeChat client");
    },
  };
  const ctx = {
    client,
    account: { botToken: "x", botId: "smoke@im.bot", baseUrl: "https://invalid", ownerUserId: OWNER, loggedInAt: new Date().toISOString() },
    cdnBaseUrl: "https://invalid",
    tokens: { get: () => undefined, set: () => {} },
    typing: { start: async () => async () => {} },
    startedAt: Date.now(),
  } as unknown as BotContext;
  return {
    channel: new WeChatChannel(ctx),
    sent,
    get refuse() {
      return state.refuse;
    },
    set refuse(on: boolean) {
      state.refuse = on;
    },
  };
}

/** The agent handler for the owner: WeChat replies go to `wechat`, app replies to the app channel. */
export function createLocalHandler(wechat: WeChatChannel, progressMs?: number): AgentHandler {
  return createAgentHandler({ owner: OWNER, channels: { wechat: wechat.outbound(OWNER), app: appOutbound() }, progressMs });
}
