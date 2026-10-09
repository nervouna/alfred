import { log, mask } from "./log.ts";
import { DEFAULT_CDN_BASE_URL, IlinkApiError, IlinkClient, STALE_TOKEN_ERRCODE } from "./ilink/client.ts";
import { sendText } from "./ilink/send.ts";
import { MessageType, TypingStatus } from "./ilink/types.ts";
import type { WeixinMessage } from "./ilink/types.ts";
import { ContextTokenStore, WORKSPACE_DIR, loadCursor, requireAccount, saveCursor } from "./store.ts";
import type { Account } from "./store.ts";

const MAX_CONSECUTIVE_FAILURES = 3;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
/** The reference client pauses an hour after a stale-token error. */
const STALE_TOKEN_PAUSE_MS = 60 * 60_000;
const TYPING_KEEPALIVE_MS = 5_000;
const TYPING_TICKET_TTL_MS = 12 * 60 * 60_000;
const SHUTDOWN_DRAIN_MS = 10_000;

export interface BotContext {
  client: IlinkClient;
  account: Account;
  cdnBaseUrl: string;
  tokens: ContextTokenStore;
  typing: Typing;
  startedAt: number;
}

export type MessageHandler = (ctx: BotContext, msg: WeixinMessage) => Promise<void>;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/** Reply to a user with the context token from their latest message. */
export async function reply(ctx: BotContext, to: string, text: string): Promise<void> {
  await sendText({ client: ctx.client, to, text, contextToken: ctx.tokens.get(to)?.token });
}

/** "Typing…" indicator. The ticket comes from getconfig and is cached per user. */
export class Typing {
  private readonly client: IlinkClient;
  private readonly tokens: ContextTokenStore;
  private readonly tickets = new Map<string, { ticket: string; fetchedAt: number }>();

  constructor(client: IlinkClient, tokens: ContextTokenStore) {
    this.client = client;
    this.tokens = tokens;
  }

  private async ticket(userId: string): Promise<string | undefined> {
    const cached = this.tickets.get(userId);
    if (cached && Date.now() - cached.fetchedAt < TYPING_TICKET_TTL_MS) return cached.ticket;
    try {
      const resp = await this.client.getConfig(userId, this.tokens.get(userId)?.token);
      if (resp.ret === 0 && resp.typing_ticket) {
        this.tickets.set(userId, { ticket: resp.typing_ticket, fetchedAt: Date.now() });
        return resp.typing_ticket;
      }
      log.warn(`getConfig returned no typing ticket: ret=${resp.ret} errmsg=${resp.errmsg ?? ""}`);
    } catch (err) {
      log.warn(`getConfig failed: ${String(err)}`);
    }
    return undefined;
  }

  /** Show the indicator until the returned function is called. Never throws. */
  async start(userId: string): Promise<() => Promise<void>> {
    const ticket = await this.ticket(userId);
    if (!ticket) return async () => {};
    const send = (status: number) =>
      this.client.sendTyping(userId, ticket, status).catch((err) => log.warn(`sendTyping failed: ${String(err)}`));
    await send(TypingStatus.TYPING);
    const timer = setInterval(() => void send(TypingStatus.TYPING), TYPING_KEEPALIVE_MS);
    return async () => {
      clearInterval(timer);
      await send(TypingStatus.CANCEL);
    };
  }
}

/** Long-poll loop. Messages from the owner are handled sequentially per user. */
export async function runBot(handler: MessageHandler, signal: AbortSignal): Promise<void> {
  const account = requireAccount();
  const client = new IlinkClient({ baseUrl: account.baseUrl, token: account.botToken });
  const tokens = new ContextTokenStore();
  const ctx: BotContext = {
    client,
    account,
    cdnBaseUrl: DEFAULT_CDN_BASE_URL,
    tokens,
    typing: new Typing(client, tokens),
    startedAt: Date.now(),
  };
  const queues = new Map<string, Promise<void>>();

  const dispatch = (msg: WeixinMessage) => {
    const from = msg.from_user_id ?? "";
    const types = msg.item_list?.map((i) => i.type).join(",") ?? "none";
    if (msg.message_type === MessageType.BOT) return;
    if (msg.group_id) {
      log.info(`ignoring group message from ${mask(from)}`);
      return;
    }
    if (from !== account.ownerUserId) {
      log.warn(`ignoring message from non-owner ${mask(from)} types=${types}`);
      return;
    }
    log.info(`inbound message types=${types} id=${msg.message_id ?? "?"}`);
    if (msg.context_token) tokens.set(from, msg.context_token);
    const next = (queues.get(from) ?? Promise.resolve())
      .then(() => handler(ctx, msg))
      .catch((err) => log.error(`handler failed: ${err instanceof Error ? err.stack : String(err)}`));
    queues.set(from, next);
  };

  try {
    const resp = await client.notifyStart();
    if (resp.ret) log.warn(`notifyStart ret=${resp.ret} errmsg=${resp.errmsg ?? ""}`);
  } catch (err) {
    log.warn(`notifyStart failed: ${String(err)}`);
  }
  log.info(`Alfred running: bot=${account.botId} owner=${mask(account.ownerUserId)} workspace=${WORKSPACE_DIR}`);

  let cursor = loadCursor();
  let holdMs: number | undefined;
  let failures = 0;
  while (!signal.aborted) {
    try {
      const resp = await client.getUpdates(cursor, holdMs, signal);
      if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) holdMs = resp.longpolling_timeout_ms;
      if ((resp.ret ?? 0) !== 0 || (resp.errcode ?? 0) !== 0) {
        if (resp.ret === STALE_TOKEN_ERRCODE || resp.errcode === STALE_TOKEN_ERRCODE) {
          log.error("Bot token is stale (errcode -14). Pausing for 1h; run `npm run login` if it persists.");
          failures = 0;
          await sleep(STALE_TOKEN_PAUSE_MS, signal);
          continue;
        }
        throw new IlinkApiError("getUpdates", resp);
      }
      failures = 0;
      if (resp.get_updates_buf) {
        cursor = resp.get_updates_buf;
        saveCursor(cursor);
      }
      for (const msg of resp.msgs ?? []) dispatch(msg);
    } catch (err) {
      if (signal.aborted) break;
      failures++;
      const backoff = failures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS;
      log.error(`getUpdates error (${failures}/${MAX_CONSECUTIVE_FAILURES}): ${String(err)}; retry in ${backoff / 1000}s`);
      if (failures >= MAX_CONSECUTIVE_FAILURES) failures = 0;
      await sleep(backoff, signal);
    }
  }

  log.info("Shutting down...");
  await Promise.race([Promise.allSettled(queues.values()), sleep(SHUTDOWN_DRAIN_MS)]);
  try {
    await client.notifyStop();
  } catch (err) {
    log.warn(`notifyStop failed: ${String(err)}`);
  }
}
