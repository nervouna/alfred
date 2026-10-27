// A local Alfred for the app in the simulator: the real agent handler on the app channel, behind the
// command API on <ALFRED_STATE_DIR>/api/alfred.sock, and the workbench on 127.0.0.1 with one paired
// device. It opens the workspace's history and the document store as `run` does, so deliveries become documents and the
// app's revisions and undos run. It prints the pairing to paste into the app, then every event as it happens: [event] for
// stored ones, [live] for message deltas and steps. Ctrl-C or SIGTERM stops everything; it exits 0.
// usage: node scripts/app-dev.ts [--port <port>] [--model <sonnet|opus|haiku>] [--repair] [--seed-documents] [--seed-ideas] [--ideas-at <HH:MM>]
//   --port            the workbench's loopback port (default 8787)
//   --model           the model the owner's messages run on (default haiku)
//   --repair          revoke the simulator's device and pair a new one. A device's token is shown once and
//                     never stored, so a lost one can only be replaced.
//   --seed-documents  before Alfred starts, write two documents for the app's 文档 tab and register them: a Markdown
//                     report with three versions and an HTML report with one. A document that is already there is
//                     left alone, so a stack that is started again keeps what it has.
//   --seed-ideas      before Alfred starts, write three open ideas (one once, two recurring) and one rejected idea into
//                     ideas.json, for the app's ideas. An ideas file that already exists is left alone.
//   --ideas-at        start the daily generation of ideas at this local time (HH:MM). Without it the stack never generates
//                     ideas on its own, so it spends nothing on them; the app's button (idea.generate) works either way and
//                     calls the model (Sonnet, at most $0.20 a generation).
// ALFRED_STATE_DIR and ALFRED_WORKSPACE must name scratch directories, and ALFRED_ANTHROPIC_API_KEY
// must be set. The pairing carries placeholder Access values: this workbench runs without the Access check.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import qrcode from "qrcode-terminal";

import { isModelKey, parseIdeasAt } from "../src/agent/config.ts";
import { describeEvent } from "../src/api/client.ts";
import type { LiveEvent } from "../src/api/schema.ts";
import { startApi } from "../src/api/server.ts";
import { documentCommands } from "../src/documents/commands.ts";
import { startDocuments } from "../src/documents/startup.ts";
import { DocumentStore, documentKind, documentTitle } from "../src/documents/store.ts";
import { VERSIONS_GIT_DIR, Versions } from "../src/documents/versions.ts";
import { isLiveEvent, sharedEventLog } from "../src/events.ts";
import { startArchiving } from "../src/ideas/archive.ts";
import { ideaCommands } from "../src/ideas/commands.ts";
import { startDailyIdeas } from "../src/ideas/schedule.ts";
import { IDEAS_FILE, IdeaStore, type IdeaDraft } from "../src/ideas/store.ts";
import { describeError, log } from "../src/log.ts";
import { newRunId } from "../src/runs.ts";
import { STATE_DIR, WORKSPACE_DIR } from "../src/store.ts";
import { taskCommands } from "../src/tasks/commands.ts";
import { TaskStore } from "../src/tasks/store.ts";
import { DeviceStore } from "../src/workbench/devices.ts";
import { buildPairing } from "../src/workbench/pairing.ts";
import { startWorkbench } from "../src/workbench/server.ts";
import { createLocalHandler } from "./local-stack.ts";

const REQUIRED = ["ALFRED_STATE_DIR", "ALFRED_WORKSPACE", "ALFRED_ANTHROPIC_API_KEY"];
const USAGE = "usage: node scripts/app-dev.ts [--port <port>] [--model <sonnet|opus|haiku>] [--repair] [--seed-documents] [--seed-ideas] [--ideas-at <HH:MM>]";
const DEVICE_NAME = "simulator";
/** Placeholder Access values for the pairing. Nothing checks them: the workbench runs here without the Access check. */
const ACCESS_CLIENT_ID = "app-dev.access";

interface Options {
  port: number;
  model: string;
  repair: boolean;
  seedDocuments: boolean;
  seedIdeas: boolean;
  /** The local time (HH:MM) of the daily generation of ideas; none means the stack never generates them on its own. */
  ideasAt?: string;
}

function parseArgs(args: string[]): Options {
  const options: Options = { port: 8787, model: "haiku", repair: false, seedDocuments: false, seedIdeas: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = args[i + 1];
    if (arg === "--repair") {
      options.repair = true;
    } else if (arg === "--seed-documents") {
      options.seedDocuments = true;
    } else if (arg === "--seed-ideas") {
      options.seedIdeas = true;
    } else if (arg === "--ideas-at" && value !== undefined) {
      let time: string | undefined;
      try {
        time = parseIdeasAt(value);
      } catch {
        // Reported below, in this flag's own words.
      }
      if (time === undefined) throw new Error(`--ideas-at must be a 24-hour time as HH:MM, got "${value}"`);
      options.ideasAt = time;
      i++;
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

/** The Markdown report the seed writes, in three versions: a first one, one that changes a paragraph and adds one, and one that changes a heading. */
const REPORT_PATH = "reports/weekly.md";
const REPORT_VERSIONS: [string, string, string] = [
  `# 咖啡市场周报

## 摘要

本周豆价基本持平，进口量略有下降。

## 价格

- 阿拉比卡：每磅 2.40 美元
- 罗布斯塔：每磅 1.10 美元

## 展望

预计下周价格保持稳定。
`,
  `# 咖啡市场周报

## 摘要

本周豆价小幅上涨，进口量明显下降。

## 价格

- 阿拉比卡：每磅 2.40 美元
- 罗布斯塔：每磅 1.10 美元

## 展望

预计下周价格保持稳定。

主要风险是产区天气。
`,
  `# 咖啡市场周报

## 摘要

本周豆价小幅上涨，进口量明显下降。

## 价格

- 阿拉比卡：每磅 2.40 美元
- 罗布斯塔：每磅 1.10 美元

## 下周展望

预计下周价格保持稳定。

主要风险是产区天气。
`,
];

/** The HTML report the seed writes, in one version. It loads nothing: the app's web view blocks every load. */
const PAGE_PATH = "reports/overview.html";
const PAGE_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>价格总览</title>
<style>body { font-family: -apple-system, sans-serif; margin: 24px; } .bar { background: #8b1a2b; height: 16px; margin: 6px 0; }</style>
</head>
<body>
<h1>价格总览</h1>
<p>阿拉比卡</p><div class="bar" style="width: 80%"></div>
<p>罗布斯塔</p><div class="bar" style="width: 40%"></div>
</body>
</html>
`;

/** Writes `content` to a workspace path and commits that path alone. Resolves to the version, which is the commit's id. */
async function commitFile(versions: Versions, rel: string, content: string, message: string): Promise<string> {
  const file = path.join(WORKSPACE_DIR, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  const commit = await versions.commit(message, { paths: [rel] });
  if (!commit) throw new Error(`${message}: committing ${rel} made no commit`);
  return commit.version;
}

/**
 * Writes the two seed documents, commits each version with `Versions` and registers them with `DocumentStore`, so the
 * app's 文档 tab has something to show without a model run. The report is delivered, then revised, then changed by a
 * run of its own; the page is delivered once. A document that is already registered is left as it is. The times are
 * minutes back from now, so the report is the most recently updated and the page comes after it.
 */
async function seedDocuments(): Promise<void> {
  const versions = new Versions({ workspace: WORKSPACE_DIR, gitDir: VERSIONS_GIT_DIR });
  await versions.init();
  const store = new DocumentStore();
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

  if (store.byPath(REPORT_PATH)) {
    log.info(`app-dev: ${REPORT_PATH} is already a document, so it is not seeded again`);
  } else {
    const [first, second, third] = REPORT_VERSIONS;
    const delivered = await commitFile(versions, REPORT_PATH, first, "Seed the weekly report");
    store.deliver({
      path: REPORT_PATH,
      version: delivered,
      at: ago(180),
      runId: newRunId(),
      title: documentTitle(REPORT_PATH, first),
      kind: documentKind(REPORT_PATH),
    });
    const revised = await commitFile(versions, REPORT_PATH, second, "Seed the weekly report: a revision");
    store.recordVersion({ paths: [REPORT_PATH], version: revised, at: ago(120), reason: "revised", runId: newRunId() });
    const changed = await commitFile(versions, REPORT_PATH, third, "Seed the weekly report: a change");
    store.recordVersion({ paths: [REPORT_PATH], version: changed, at: ago(30), reason: "changed", runId: newRunId() });
    log.info(`app-dev: seeded ${REPORT_PATH} with 3 versions`);
  }

  if (store.byPath(PAGE_PATH)) {
    log.info(`app-dev: ${PAGE_PATH} is already a document, so it is not seeded again`);
  } else {
    const delivered = await commitFile(versions, PAGE_PATH, PAGE_HTML, "Seed the overview page");
    store.deliver({
      path: PAGE_PATH,
      version: delivered,
      at: ago(60),
      runId: newRunId(),
      title: documentTitle(PAGE_PATH, PAGE_HTML),
      kind: documentKind(PAGE_PATH),
    });
    log.info(`app-dev: seeded ${PAGE_PATH}`);
  }
}

/** The seed ideas: three open ones (a once idea and two recurring ones), then one that is rejected, which is the last. */
const SEED_IDEAS: IdeaDraft[] = [
  {
    title: "对比三家 VPS 的带宽配额",
    why: "上一份价格报告没有写带宽，你在对话里问过这件事。",
    brief: "查 Hetzner、Vultr 和 DigitalOcean 官网的带宽与流量政策，整理成一张表，附上来源链接。",
    kind: "once",
    model: "sonnet",
    estimateUsd: 0.35,
  },
  {
    title: "每周追踪 VPS 价格变化",
    why: "这周你两次问到价格，每周看一次能及时发现调价。",
    brief: "每周一看一次三家供应商的定价页，只报告和上周相比的变化。",
    kind: "recurring",
    schedule: { kind: "weekly", days: [1], time: "09:00" },
    model: "sonnet",
    estimateUsd: 0.2,
  },
  {
    title: "每天检查供应商状态页",
    why: "供应商的维护公告常在报告之后才出现，你之前因此漏掉过一次变化。",
    brief: "每天早上打开三家供应商的状态页，只报告新出现的故障或维护公告。",
    kind: "recurring",
    schedule: { kind: "daily", time: "08:00" },
    model: "haiku",
    estimateUsd: 0.1,
  },
  {
    title: "把报告译成英文",
    why: "你的报告大多是中文，英文版可能对合作方有用。",
    brief: "把 VPS 价格报告译成英文，保留表格和来源链接。",
    kind: "once",
    model: "haiku",
    estimateUsd: 0.12,
  },
];

/**
 * Writes the seed ideas through the idea store, all of one made-up generation run: the last one is rejected as "not
 * now", with a note. Only when there is no ideas file yet, as seedDocuments leaves the documents that exist.
 */
function seedIdeas(): void {
  if (fs.existsSync(IDEAS_FILE)) {
    log.info(`app-dev: ${IDEAS_FILE} exists, so the ideas are not seeded again`);
    return;
  }
  const store = new IdeaStore();
  const added = store.add(SEED_IDEAS, newRunId());
  const declined = added.at(-1);
  if (!declined) throw new Error("the seed ideas were not added");
  store.reject(declined.id, { reason: "not-now", note: "等这周的报告定稿再说。" });
  log.info(`app-dev: seeded ${added.length} ideas into ${IDEAS_FILE}`);
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
    if (options.seedDocuments) await seedDocuments();
    if (options.seedIdeas) seedIdeas();
    // Wired as `run` wires them: the one history and document store (opened after the seed, so it finds the seeded
    // documents and imports nothing), the one task store behind the handler, which runs the tasks, the one idea store,
    // and the commands of both stores.
    const documents = await startDocuments();
    const tasks = new TaskStore();
    const ideas = new IdeaStore();
    const handler = createLocalHandler({ tasks, documents, ideas });
    cleanups.push(() => handler.shutdown());
    // Pushed before the API's cleanup, so it runs after the API closes, as archiving stops after the API in `run`.
    cleanups.push(startArchiving(ideas));
    // Only with --ideas-at: the stack does not spend on ideas on its own. The app's button works without it.
    cleanups.push(startDailyIdeas({ at: options.ideasAt, ideas, generate: () => handler.generateIdeas() }));
    // Without documents the API answers every document command 503, as in `run`.
    cleanups.push(
      await startApi({
        socket,
        handler,
        events: sharedEventLog(),
        tasks: taskCommands(tasks, handler),
        ideas: ideaCommands(ideas, tasks, { generate: () => handler.generateIdeas() }),
        ...(documents ? { documents: documentCommands(handler, documents) } : {}),
      }),
    );
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
