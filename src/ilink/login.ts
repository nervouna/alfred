// QR-code login for an iLink bot.
// Flow ported from Tencent/openclaw-weixin (MIT), src/auth/login-qr.ts. See NOTICE.

import readline from "node:readline/promises";

import qrcode from "qrcode-terminal";

import { describeError, log, mask } from "../log.ts";
import { DEFAULT_BASE_URL, getText, postJson } from "./client.ts";
import type { QrCodeResp, QrStatusResp } from "./types.ts";

const BOT_TYPE = "3";
const QR_POLL_TIMEOUT_MS = 35_000;
const MAX_QR_REFRESHES = 3;
const LOGIN_DEADLINE_MS = 8 * 60_000;

export interface LoginResult {
  botToken: string;
  botId: string;
  baseUrl: string;
  ownerUserId: string;
}

async function fetchQrCode(existingTokens: string[]): Promise<QrCodeResp> {
  const raw = await postJson({
    baseUrl: DEFAULT_BASE_URL,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`,
    body: { local_token_list: existingTokens },
    timeoutMs: 15_000,
    label: "getBotQrcode",
  });
  return JSON.parse(raw) as QrCodeResp;
}

async function pollStatus(baseUrl: string, qrcodeValue: string, verifyCode?: string): Promise<QrStatusResp> {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeValue)}`;
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
  try {
    return JSON.parse(await getText({ baseUrl, endpoint, timeoutMs: QR_POLL_TIMEOUT_MS, label: "qrStatus" }));
  } catch (err) {
    // Long-poll timeouts and gateway hiccups just mean "keep waiting".
    log.debug(`qrStatus poll error, retrying: ${describeError(err)}`);
    return { status: "wait" };
  }
}

function showQr(content: string): void {
  qrcode.generate(content, { small: true });
  console.log(`If the QR code does not render, open this link in WeChat:\n${content}\n`);
}

async function ask(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Run the interactive login. Returns credentials on success, or "already-bound"
 * when the server reports the scanned bot is bound to the token we sent.
 */
export async function login(existingToken?: string): Promise<LoginResult | "already-bound"> {
  const existingTokens = existingToken ? [existingToken] : [];
  let qr = await fetchQrCode(existingTokens);
  console.log("Scan with WeChat to connect Alfred:");
  showQr(qr.qrcode_img_content);

  let pollBaseUrl = DEFAULT_BASE_URL;
  let refreshes = 1;
  let pendingCode: string | undefined;
  let scannedShown = false;
  const deadline = Date.now() + LOGIN_DEADLINE_MS;

  const refresh = async (reason: string) => {
    refreshes++;
    if (refreshes > MAX_QR_REFRESHES) throw new Error(`${reason}; giving up after ${MAX_QR_REFRESHES} QR codes`);
    console.log(`\n${reason}, refreshing QR code (${refreshes}/${MAX_QR_REFRESHES})...`);
    qr = await fetchQrCode(existingTokens);
    pollBaseUrl = DEFAULT_BASE_URL;
    scannedShown = false;
    showQr(qr.qrcode_img_content);
  };

  while (Date.now() < deadline) {
    const status = await pollStatus(pollBaseUrl, qr.qrcode, pendingCode);
    log.debug(`qr status=${status.status}`);
    switch (status.status) {
      case "wait":
        break;
      case "scaned":
        pendingCode = undefined;
        if (!scannedShown) {
          console.log("Scanned. Confirm on your phone...");
          scannedShown = true;
        }
        break;
      case "need_verifycode":
        pendingCode = await ask(
          pendingCode ? "Code did not match, try again: " : "Enter the number shown in WeChat on your phone: ",
        );
        continue;
      case "verify_code_blocked":
        pendingCode = undefined;
        await refresh("Too many wrong codes");
        break;
      case "expired":
        await refresh("QR code expired");
        break;
      case "scaned_but_redirect":
        if (status.redirect_host) {
          pollBaseUrl = `https://${status.redirect_host}`;
          log.info(`login: polling redirected to ${status.redirect_host}`);
        }
        break;
      case "binded_redirect":
        return "already-bound";
      case "confirmed": {
        if (!status.bot_token || !status.ilink_bot_id) throw new Error("login confirmed without bot_token/ilink_bot_id");
        if (!status.ilink_user_id) throw new Error("login confirmed without ilink_user_id; cannot determine the owner");
        log.info(`login: confirmed bot=${status.ilink_bot_id} owner=${mask(status.ilink_user_id)}`);
        return {
          botToken: status.bot_token,
          botId: status.ilink_bot_id,
          baseUrl: status.baseurl || DEFAULT_BASE_URL,
          ownerUserId: status.ilink_user_id,
        };
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("login timed out");
}
