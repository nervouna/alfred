import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import qrcode from "qrcode-terminal";

import { checkMemoryScanSettings } from "./agent/config.ts";
import { resolveInside } from "./agent/guard.ts";
import { createAgentHandler } from "./agent/handler.ts";
import { MEMORY_LOCK_FILE, describeScan, scanTranscripts } from "./agent/memory-scan.ts";
import { MemoryLock } from "./agent/memory.ts";
import { describeEvent, request, streamEvents } from "./api/client.ts";
import { apiSocketPath, startApi } from "./api/server.ts";
import { createBotContext, runBot } from "./bot.ts";
import type { BotContext, MessageHandler } from "./bot.ts";
import { SerialQueue, appOutbound } from "./channels.ts";
import { WeChatChannel, wechatHandler } from "./channels/wechat.ts";
import { echoHandler } from "./echo.ts";
import { sharedEventLog } from "./events.ts";
import { DEFAULT_CDN_BASE_URL, IlinkClient } from "./ilink/client.ts";
import { login } from "./ilink/login.ts";
import { sendMedia, sendText } from "./ilink/send.ts";
import { describeError, log, logToFile, mask } from "./log.ts";
import { BROWSERS_PATH, renderPdf } from "./pdf.ts";
import { LOG_FILE } from "./runs.ts";
import { AccessVerifier } from "./workbench/access.ts";
import { ApnsClient, apnsSettings } from "./workbench/apns.ts";
import { DeviceStore } from "./workbench/devices.ts";
import { buildPairing, pairingSettings } from "./workbench/pairing.ts";
import { describeResult, notify, pushToDevices, startPush } from "./workbench/push.ts";
import { startWorkbench } from "./workbench/server.ts";
import { ContextTokenStore, STATE_DIR, WORKSPACE_DIR, loadAccount, loadCursor, requireAccount, saveAccount } from "./store.ts";

const USAGE = `usage: node src/cli.ts <command>

  login                      scan a QR code with WeChat to bind the bot
  run [--echo]               start the assistant (--echo: PoC echo bot)
  push [--no-context] [--file <path>] [text]
                             send a proactive message and/or file to the owner
  status                     show local account and session state
  setup-pdf                  download the headless Chrome used for PDF rendering
  pdf <source> [output]      render a Markdown or HTML file to PDF
  memory-scan                extract long-term memories from new transcript entries now
  workbench [--dev]          serve the read-only workbench (--dev: no Access check, loopback only)
  apns-test [text]           send a test notification to every device with a push registration
  pair [--name <name>] [--json]
                             pair the app: create a device and show a QR code to scan (--json: print the pairing instead)
  devices                    list the paired devices
  devices revoke <id>        lock a device out
  api send [--file <inbox path>]… <text…>
                             send a message to the running Alfred over its local API socket; each --file attaches a file from the inbox
  api upload <file> [--name <name>]
                             copy a local file into the inbox over the API socket and print where it was saved
  api stop <run id>          stop a run
  api events [--after N] [--follow]
                             print the events after id N (default 0); --follow keeps streaming`;

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

async function cmdRun(args: string[]): Promise<void> {
  logToFile(LOG_FILE);
  const ctx = createBotContext();
  const handler = args.includes("--echo") ? inOrder(echoHandler) : await agentHandler(ctx);
  const controller = new AbortController();
  const stop = (sig: string) => {
    if (controller.signal.aborted) process.exit(1);
    log.info(`${sig} received, stopping (send again to force)`);
    controller.abort();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  await runBot(ctx, handler, controller.signal);
}

/** The assistant: the agent handler, with WeChat and the app as its channels, and the command API in front of the app channel. */
async function agentHandler(ctx: BotContext): Promise<MessageHandler> {
  const wechat = new WeChatChannel(ctx);
  const owner = ctx.account.ownerUserId;
  const agent = createAgentHandler({ owner, channels: { wechat: wechat.outbound(owner), app: appOutbound() } });
  const handler = wechatHandler(wechat, agent);
  const socket = apiSocketPath();
  if (!socket) return handler;

  let closeApi: () => Promise<void>;
  try {
    closeApi = await startApi({ socket, handler: agent, events: sharedEventLog() });
  } catch (err) {
    await agent.shutdown();
    throw err;
  }
  // The API closes first, so no command reaches an agent that is stopping its runs.
  handler.shutdown = async () => {
    try {
      await closeApi();
    } finally {
      await agent.shutdown();
    }
  };
  return handler;
}

/** The PoC echo handler takes messages one at a time, as the bot used to hand them over. */
function inOrder(handler: MessageHandler): MessageHandler {
  const queue = new SerialQueue();
  return (ctx, msg) => queue.run(() => handler(ctx, msg));
}

async function cmdPush(args: string[]): Promise<void> {
  const usage = "usage: push [--no-context] [--file <path>] [text]";
  let noContext = false;
  let filePath: string | undefined;
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--no-context") noContext = true;
    else if (arg === "--file") filePath = args[++i] ?? "";
    else words.push(arg);
  }
  const text = words.join(" ").trim();
  if ((!text && !filePath) || filePath === "") throw new Error(usage);

  const account = requireAccount();
  const entry = new ContextTokenStore().get(account.ownerUserId);
  console.log(entry ? `context token last refreshed ${ageOf(entry.updatedAt)} ago` : "no context token stored");
  const client = new IlinkClient({ baseUrl: account.baseUrl, token: account.botToken });
  const target = { client, to: account.ownerUserId, contextToken: noContext ? undefined : entry?.token };

  if (text) await sendText({ ...target, text });
  if (filePath) {
    const kind = await sendMedia({
      ...target,
      cdnBaseUrl: DEFAULT_CDN_BASE_URL,
      data: fs.readFileSync(filePath),
      fileName: path.basename(filePath),
    });
    console.log(`uploaded ${path.basename(filePath)} as ${kind}`);
  }
  console.log(`sent${noContext ? " without context token" : ""}; the server accepted it (check WeChat to confirm delivery)`);
}

function cmdSetupPdf(): void {
  const bin = path.join(import.meta.dirname, "..", "node_modules", ".bin", "playwright-core");
  console.log(`Installing Chrome Headless Shell into ${BROWSERS_PATH}`);
  const res = spawnSync(bin, ["install", "chromium-headless-shell"], {
    stdio: "inherit",
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: BROWSERS_PATH },
  });
  if (res.status !== 0) throw new Error(`playwright install exited with ${res.status ?? res.signal}`);
}

async function cmdPdf(args: string[]): Promise<void> {
  const [source, output] = args;
  if (!source) throw new Error("usage: pdf <source.md|source.html> [output.pdf]");
  const out = output ?? `${source.slice(0, source.length - path.extname(source).length)}.pdf`;
  const src = path.resolve(source);
  // Local images may come from the whole workspace for workspace files, else only from the source's directory.
  const inWorkspace = fs.existsSync(WORKSPACE_DIR) && resolveInside(WORKSPACE_DIR, src);
  const { bytes } = await renderPdf(src, path.resolve(out), { root: inWorkspace ? WORKSPACE_DIR : path.dirname(src) });
  console.log(`wrote ${out} (${bytes} bytes)`);
}

async function cmdMemoryScan(): Promise<void> {
  checkMemoryScanSettings();
  const lock = new MemoryLock(MEMORY_LOCK_FILE);
  if (!lock.tryAcquire("scan")) {
    const holder = lock.current();
    throw new Error(`memory is busy (${holder ? `${holder.holder} in pid ${holder.pid} since ${holder.since}` : "lock file unreadable"}); try again later`);
  }
  try {
    const report = await scanTranscripts({ workspace: WORKSPACE_DIR });
    console.log(describeScan(report));
    for (const a of report.applied) console.log(`  ${a.action} memory/${a.file}: ${a.name}`);
  } finally {
    lock.release();
  }
}

/** Host and port from ALFRED_WORKBENCH_LISTEN ("host:port", default 127.0.0.1:8787), or undefined for "off". */
function workbenchListen(): { host: string; port: number } | undefined {
  const setting = process.env.ALFRED_WORKBENCH_LISTEN?.trim() || "127.0.0.1:8787";
  if (setting === "off") return undefined;
  const m = /^(.+):(\d+)$/.exec(setting);
  const port = Number(m?.[2]);
  if (!m?.[1] || !(port > 0 && port < 65536)) throw new Error(`ALFRED_WORKBENCH_LISTEN must be host:port or off, got "${setting}"`);
  return { host: m[1], port };
}

async function cmdWorkbench(args: string[]): Promise<void> {
  const dev = args.includes("--dev");
  const listen = workbenchListen();
  const socket = process.env.ALFRED_WORKBENCH_SOCKET?.trim() || undefined;
  let access: AccessVerifier | undefined;
  if (listen && !dev) {
    const teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN?.trim();
    const aud = process.env.CF_ACCESS_AUD?.trim();
    const ownerEmail = process.env.ALFRED_WORKBENCH_OWNER_EMAIL?.trim();
    if (!teamDomain || !aud || !ownerEmail) {
      throw new Error(
        "the TCP listener needs CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD and ALFRED_WORKBENCH_OWNER_EMAIL; set ALFRED_WORKBENCH_LISTEN=off to serve the socket only",
      );
    }
    // The app's service token; without its client id, a service token is refused.
    const serviceClientId = process.env.CF_ACCESS_SERVICE_CLIENT_ID?.trim() || undefined;
    access = new AccessVerifier({ teamDomain, aud, ownerEmail, serviceClientId });
  }
  if (listen && dev && !["127.0.0.1", "localhost", "::1"].includes(listen.host)) {
    throw new Error(`--dev serves without an Access check, so it listens on loopback only, not ${listen.host}`);
  }
  const close = await startWorkbench({ workspace: WORKSPACE_DIR, tcp: listen && { ...listen, access }, socket });
  const stopPush = startPush();
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  log.info("workbench stopping");
  await stopPush();
  await close();
}

/** Sends one test notification to every device with a push registration, and prints each device's answer. */
async function cmdApnsTest(args: string[]): Promise<void> {
  const setting = apnsSettings();
  if (!setting.ok) throw new Error(`push is not configured: ${setting.missing.join(", ")} not set`);
  const { key, keyId, teamId, topic } = setting.settings;
  const apns = new ApnsClient({ key, keyId, teamId, topic });
  try {
    const outcomes = await pushToDevices(notify(args.join(" ").trim() || "推送测试"), new DeviceStore(), apns);
    if (!outcomes.length) console.log("no device has a push registration");
    for (const { deviceId, result } of outcomes) {
      console.log(`${deviceId} ${describeResult(result)}`);
      if (result.status !== 200) process.exitCode = 1;
    }
  } finally {
    apns.close();
  }
}

/** Creates a device and shows the pairing the app scans: server, Access service token and the new device's token. */
function cmdPair(args: string[]): void {
  const usage = "usage: pair [--name <name>] [--json]";
  let name = "iPhone";
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = args[i + 1];
    if (arg === "--json") json = true;
    else if (arg === "--name" && value && !value.startsWith("--")) {
      name = value;
      i++;
    } else throw new Error(usage);
  }
  // The settings come first, so a missing variable leaves no device behind.
  const settings = pairingSettings();
  const device = new DeviceStore().createDevice(name);
  const pairing = JSON.stringify(buildPairing(settings, device));
  if (json) {
    console.log(pairing);
    return;
  }
  qrcode.generate(pairing, { small: true });
  console.log(`device ${device.id}  ${name.trim()}\nScan the code with the Alfred app. It holds the device and Access tokens, so keep it to yourself.`);
}

function cmdDevices(args: string[]): void {
  const usage = "usage: devices | devices revoke <id>";
  const store = new DeviceStore();
  const [sub, id, ...extra] = args;
  if (sub === "revoke") {
    if (!id || extra.length) throw new Error(usage);
    const device = store.revokeDevice(id);
    console.log(`revoked ${device.id} (${device.name}) at ${device.revokedAt}; its token stops working on the next request`);
    return;
  }
  if (sub) throw new Error(usage);
  const devices = store.list();
  if (!devices.length) {
    console.log("no devices paired");
    return;
  }
  const rows = [["ID", "NAME", "CREATED", "REVOKED"], ...devices.map((d) => [d.id, d.name, d.createdAt, d.revokedAt ?? "-"])];
  const widths = rows[0]?.map((_, col) => Math.max(...rows.map((row) => (row[col] ?? "").length))) ?? [];
  for (const row of rows) console.log(row.map((cell, col) => cell.padEnd(widths[col] ?? 0)).join("  ").trimEnd());
}

/** Prints an HTTP answer as `<status> <body>`; a status of 400 or more is a failure. */
function printAnswer(answer: { status: number; body: string }): void {
  console.log(`${answer.status} ${answer.body}`);
  if (answer.status >= 400) process.exitCode = 1;
}

async function cmdApi(args: string[]): Promise<void> {
  const usage =
    "usage: api send [--file <inbox path>]… <text…> | api upload <file> [--name <name>] | api stop <run id> | api events [--after N] [--follow]";
  const socket = apiSocketPath();
  if (!socket) throw new Error("the API is off (ALFRED_API_SOCKET=off)");
  const [sub, ...rest] = args;
  switch (sub) {
    case "send": {
      const files: { path: string }[] = [];
      const words: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i];
        if (arg !== "--file") words.push(arg ?? "");
        else if (rest[i + 1] !== undefined) files.push({ path: rest[++i] ?? "" });
        else throw new Error(usage);
      }
      const text = words.join(" ");
      if (!text.trim() && files.length === 0) throw new Error(usage);
      const command = { type: "message.send", clientId: `cli-${crypto.randomUUID()}`, text, ...(files.length ? { files } : {}) };
      printAnswer(await request(socket, "POST", "/commands", command));
      break;
    }
    case "upload": {
      const positional: string[] = [];
      let name: string | undefined;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--name" && rest[i + 1] !== undefined) name = rest[++i];
        else positional.push(rest[i] ?? "");
      }
      const [file, ...extra] = positional;
      if (!file || extra.length) throw new Error(usage);
      const data = fs.readFileSync(file);
      const fileName = name ?? path.basename(file);
      printAnswer(await request(socket, "POST", `/uploads?name=${encodeURIComponent(fileName)}`, data));
      break;
    }
    case "stop": {
      const [runId, ...extra] = rest;
      if (!runId || extra.length) throw new Error(usage);
      printAnswer(await request(socket, "POST", "/commands", { type: "run.stop", runId }));
      break;
    }
    case "events": {
      let after = 0;
      let follow = false;
      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i];
        if (arg === "--follow") follow = true;
        else if (arg === "--after" && /^\d+$/.test(rest[i + 1] ?? "")) after = Number(rest[++i]);
        else throw new Error(usage);
      }
      await printEvents(socket, after, follow);
      break;
    }
    default:
      throw new Error(usage);
  }
}

/** Prints the events after `after`, one line each: with `follow`, for as long as the stream lasts; otherwise up to the last event as of now. */
async function printEvents(socket: string, after: number, follow: boolean): Promise<void> {
  let until = Number.POSITIVE_INFINITY;
  if (!follow) {
    const health = await request(socket, "GET", "/health");
    if (health.status !== 200) throw new Error(`GET /health answered ${health.status}: ${health.body}`);
    until = (JSON.parse(health.body) as { lastEventId?: number }).lastEventId ?? 0;
    if (until <= after) return;
  }
  for await (const frame of streamEvents(socket, { after })) {
    console.log(describeEvent(frame));
    if (frame.id >= until) return;
  }
  throw new Error("the event stream ended");
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
      await cmdRun(args);
      break;
    case "push":
      await cmdPush(args);
      break;
    case "status":
      cmdStatus();
      break;
    case "setup-pdf":
      cmdSetupPdf();
      break;
    case "pdf":
      await cmdPdf(args);
      break;
    case "memory-scan":
      await cmdMemoryScan();
      break;
    case "workbench":
      await cmdWorkbench(args);
      break;
    case "apns-test":
      await cmdApnsTest(args);
      break;
    case "pair":
      cmdPair(args);
      break;
    case "devices":
      cmdDevices(args);
      break;
    case "api":
      await cmdApi(args);
      break;
    default:
      console.log(USAGE);
      process.exitCode = command ? 1 : 0;
  }
} catch (err) {
  log.error(describeError(err));
  process.exitCode = 1;
}
