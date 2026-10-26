// A local Alfred for the app in the simulator: the real agent handler on the app channel, behind the
// command API on <ALFRED_STATE_DIR>/api/alfred.sock, and the workbench on 127.0.0.1 with one paired
// device. It prints the pairing to paste into the app, then every event as it happens: [event] for
// stored ones, [live] for message deltas and steps. Ctrl-C or SIGTERM stops everything; it exits 0.
// usage: node scripts/app-dev.ts [--port <port>] [--model <sonnet|opus|haiku>] [--repair]
//   --port     the workbench's loopback port (default 8787)
//   --model    the model the owner's messages run on (default haiku)
//   --repair   revoke the simulator's device and pair a new one. A device's token is shown once and
//              never stored, so a lost one can only be replaced.
// ALFRED_STATE_DIR and ALFRED_WORKSPACE must name scratch directories, and ALFRED_ANTHROPIC_API_KEY
// must be set. The pairing carries placeholder Access values: this workbench runs without the Access check.

import crypto from "node:crypto";
import path from "node:path";

import qrcode from "qrcode-terminal";

import { isModelKey } from "../src/agent/config.ts";
import { describeEvent } from "../src/api/client.ts";
import type { LiveEvent } from "../src/api/schema.ts";
import { startApi } from "../src/api/server.ts";
import { isLiveEvent, sharedEventLog } from "../src/events.ts";
import { describeError, log } from "../src/log.ts";
import { STATE_DIR, WORKSPACE_DIR } from "../src/store.ts";
import { DeviceStore } from "../src/workbench/devices.ts";
import { buildPairing } from "../src/workbench/pairing.ts";
import { startWorkbench } from "../src/workbench/server.ts";
import { createLocalHandler } from "./local-stack.ts";

const REQUIRED = ["ALFRED_STATE_DIR", "ALFRED_WORKSPACE", "ALFRED_ANTHROPIC_API_KEY"];
const USAGE = "usage: node scripts/app-dev.ts [--port <port>] [--model <sonnet|opus|haiku>] [--repair]";
const DEVICE_NAME = "simulator";
/** Placeholder Access values for the pairing. Nothing checks them: the workbench runs here without the Access check. */
const ACCESS_CLIENT_ID = "app-dev.access";

interface Options {
  port: number;
  model: string;
  repair: boolean;
}

function parseArgs(args: string[]): Options {
  const options: Options = { port: 8787, model: "haiku", repair: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = args[i + 1];
    if (arg === "--repair") {
      options.repair = true;
    } else if (arg === "--port" && value !== undefined && /^\d+$/.test(value)) {
      options.port = Number(value);
      i++;
    } else if (arg === "--model" && value !== undefined) {
      options.model = value;
      i++;
    } else {
      throw new Error(USAGE);
    }
  }
  if (!(options.port >= 1 && options.port <= 65535)) throw new Error(`--port must be 1 to 65535, got ${options.port}`);
  if (!isModelKey(options.model)) throw new Error(`--model must be sonnet, opus or haiku, got "${options.model}"`);
  return options;
}

/** The text on one line, its whitespace collapsed and cut to `max` characters with an ellipsis when it is longer. */
function shorten(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

/** A live event in one line: a piece of the reply as it is written, or a step as the run records it. */
function describeLive(event: LiveEvent): string {
  if (event.type === "message.delta") return `message.delta run=${event.data.runId} ${shorten(event.data.text, 60)}`;
  const { step } = event.data;
  return `run.step run=${event.data.runId} ${step.tool}${step.agent ? ` (${step.agent})` : ""} ${shorten(step.detail, 60)}`;
}

/** Pairs the simulator, or says how to pair it again when it is already paired. The pairing is one `[pairing]` line, and a QR code. */
function pairSimulator(devices: DeviceStore, server: string, repair: boolean): void {
  const paired = devices.list().filter((d) => d.name === DEVICE_NAME && !d.revokedAt);
  const existing = paired[0];
  if (existing && !repair) {
    console.log(
      `[pairing] the simulator is already paired as device ${existing.id}. Its token was shown once and is not stored; run with --repair to revoke it and pair a new one.`,
    );
    return;
  }
  for (const device of paired) devices.revokeDevice(device.id);
  const device = devices.createDevice(DEVICE_NAME);
  const settings = { server, clientId: ACCESS_CLIENT_ID, clientSecret: crypto.randomBytes(24).toString("base64url") };
  const pairing = JSON.stringify(buildPairing(settings, device));
  console.log(`[pairing] ${pairing}`);
  qrcode.generate(pairing, { small: true });
  console.log(`paired device ${device.id} (${DEVICE_NAME}); paste the [pairing] line into the app`);
}

async function main(options: Options): Promise<void> {
  const server = `http://127.0.0.1:${options.port}`;
  // Set here whatever the shell says, so the workbench forwards to this stack's command API and to no other.
  const socket = path.join(STATE_DIR, "api", "alfred.sock");
  process.env.ALFRED_API_SOCKET = socket;

  const stop = new Promise<void>((resolve) => {
    process.once("SIGINT", () => {
      log.info("SIGINT received, stopping");
      resolve();
    });
    process.once("SIGTERM", () => {
      log.info("SIGTERM received, stopping");
      resolve();
    });
  });

  // Each cleanup undoes one setup step; they run in reverse, so the workbench goes first and the handler last.
  const cleanups: (() => Promise<void> | void)[] = [];
  try {
    const handler = createLocalHandler();
    cleanups.push(() => handler.shutdown());
    cleanups.push(await startApi({ socket, handler, events: sharedEventLog() }));
    cleanups.push(
      sharedEventLog().subscribe((event) => {
        if (isLiveEvent(event)) console.log(`[live] ${describeLive(event)}`);
        else console.log(`[event] ${describeEvent({ id: event.id, type: event.type, data: JSON.stringify(event) })}`);
      }),
    );
    const devices = new DeviceStore(path.join(STATE_DIR, "app"));
    cleanups.push(await startWorkbench({ workspace: WORKSPACE_DIR, tcp: { host: "127.0.0.1", port: options.port }, devices }));

    await handler.submit({ text: `/model ${options.model}`, files: [], clientId: "app-dev-model" });
    pairSimulator(devices, server, options.repair);
    log.info(`app-dev is up at ${server} with the command API on ${socket}; Ctrl-C stops it`);
    await stop;
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
    log.info("app-dev stopped");
  }
}

let options: Options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(describeError(err));
  process.exit(2);
}

const missing = REQUIRED.filter((name) => !process.env[name]?.trim());
if (missing.length) {
  console.error(`app-dev needs ${missing.join(", ")} set. Point ALFRED_STATE_DIR and ALFRED_WORKSPACE at new scratch directories of your own.`);
  process.exit(1);
}

try {
  await main(options);
  process.exit(0);
} catch (err) {
  log.error(`app-dev failed: ${describeError(err)}`);
  process.exit(1);
}
