import { runBot } from "./bot.ts";
import { echoHandler } from "./echo.ts";
import { IlinkClient } from "./ilink/client.ts";
import { login } from "./ilink/login.ts";
import { sendText } from "./ilink/send.ts";
import { log, mask } from "./log.ts";
import { ContextTokenStore, STATE_DIR, WORKSPACE_DIR, loadAccount, loadCursor, requireAccount, saveAccount } from "./store.ts";

const USAGE = `usage: node src/cli.ts <command>

  login                      scan a QR code with WeChat to bind the bot
  run                        start the echo bot
  push [--no-context] <text> send a proactive message to the owner
  status                     show local account and session state`;

function ageOf(epochMs: number): string {
  return `${((Date.now() - epochMs) / 3_600_000).toFixed(2)}h`;
}

async function cmdLogin(): Promise<void> {
  const existing = loadAccount();
  const result = await login(existing?.botToken);
  if (result === "already-bound") {
    console.log(existing ? "This bot is already bound; keeping existing credentials." : "Server says the bot is already bound, but no local credentials exist.");
    return;
  }
  saveAccount({ ...result, loggedInAt: new Date().toISOString() });
  console.log(`Logged in as bot ${result.botId}. Credentials saved to ${STATE_DIR}. Next: npm start`);
}

async function cmdRun(): Promise<void> {
  const controller = new AbortController();
  const stop = (sig: string) => {
    if (controller.signal.aborted) process.exit(1);
    log.info(`${sig} received, stopping (send again to force)`);
    controller.abort();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  await runBot(echoHandler, controller.signal);
}

async function cmdPush(args: string[]): Promise<void> {
  const noContext = args.includes("--no-context");
  const text = args.filter((a) => a !== "--no-context").join(" ").trim();
  if (!text) throw new Error("usage: push [--no-context] <text>");
  const account = requireAccount();
  const entry = new ContextTokenStore().get(account.ownerUserId);
  console.log(entry ? `context token last refreshed ${ageOf(entry.updatedAt)} ago` : "no context token stored");
  const client = new IlinkClient({ baseUrl: account.baseUrl, token: account.botToken });
  await sendText({
    client,
    to: account.ownerUserId,
    text,
    contextToken: noContext ? undefined : entry?.token,
  });
  console.log(`sent${noContext ? " without context token" : ""}; the server accepted it (check WeChat to confirm delivery)`);
}

function cmdStatus(): void {
  const account = loadAccount();
  console.log(`state dir: ${STATE_DIR}\nworkspace: ${WORKSPACE_DIR}`);
  if (!account) {
    console.log("not logged in");
    return;
  }
  const entry = new ContextTokenStore().get(account.ownerUserId);
  console.log(
    [
      `bot: ${account.botId}`,
      `owner: ${mask(account.ownerUserId)}`,
      `base url: ${account.baseUrl}`,
      `logged in: ${account.loggedInAt} (${ageOf(Date.parse(account.loggedInAt))} ago)`,
      `context token: ${entry ? `refreshed ${ageOf(entry.updatedAt)} ago` : "none"}`,
      `cursor: ${loadCursor().length} bytes`,
    ].join("\n"),
  );
}

const [command, ...args] = process.argv.slice(2);
try {
  switch (command) {
    case "login":
      await cmdLogin();
      break;
    case "run":
      await cmdRun();
      break;
    case "push":
      await cmdPush(args);
      break;
    case "status":
      cmdStatus();
      break;
    default:
      console.log(USAGE);
      process.exitCode = command ? 1 : 0;
  }
} catch (err) {
  log.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
