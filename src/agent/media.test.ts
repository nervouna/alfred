// save_media and the offering of media tools, against a local fake media origin (node:http, a random port) and fake
// affogato configuration: no network beyond localhost, no model.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";

import { appOutbound } from "../channels.ts";
import type { Outbound } from "../channels.ts";

// store.ts reads these at import time, so set them before loading the modules under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-media-test-")));
const workspace = path.join(tmp, "workspace");
fs.mkdirSync(workspace);
Object.assign(process.env, {
  ALFRED_WORKSPACE: workspace,
  ALFRED_STATE_DIR: path.join(tmp, "state"),
  ALFRED_ANTHROPIC_API_KEY: "sk-test",
  ALFRED_WORKBENCH: "",
  ALFRED_WORKBENCH_URL: "",
  ALFRED_AFFOGATO_TEST_AUTH: "Bearer test-token",
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { saveMedia, MEDIA_MAX_BYTES } = await import("./media.ts");
const { EXTERNAL_SERVERS_FILE, InvalidExternalServers, checkExternalTool, loadExternalServers, mediaOffer, parseExternalServers, subagentExternalTools, underMediaOrigin } =
  await import("./external.ts");
const { agentOptions, prepareWorkspace } = await import("./handler.ts");
const { alfredToolDefinitions } = await import("./tools.ts");
const { subagentDefinitions } = await import("./config.ts");
const { localDate } = await import("../files.ts");
const { RunRecorder } = await import("../runs.ts");
const { checkToolInput } = await import("./guard.ts");

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

// The fake media origin and a second server standing for a host outside the configured origins.
let origin: string;
let outside: string;
let outsideRequests = 0;
const servers: http.Server[] = [];

function listen(handler: http.RequestListener): Promise<string> {
  return new Promise((resolve) => {
    const server = http.createServer(handler).listen(0, "127.0.0.1", () => {
      servers.push(server);
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

before(async () => {
  outside = await listen((_req, res) => {
    outsideRequests++;
    res.writeHead(200, { "content-type": "image/png" }).end(PNG);
  });
  origin = await listen((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (type: string, body: Buffer | string) => res.writeHead(200, { "content-type": type, "content-length": Buffer.byteLength(body) }).end(body);
    switch (url.pathname) {
      case "/media/image/cat.png":
        return send("image/png", PNG);
      case "/media/video/clip.mp4":
        return send("video/mp4", "not really a video");
      case "/media/audio/speech.mp3":
        return send("audio/mpeg; charset=binary", "not really audio");
      case "/media/note.txt":
        return send("text/plain", "hello");
      case "/media/to-outside":
        return void res.writeHead(302, { location: `${outside}/secret.png` }).end();
      case "/media/to-sibling":
        return void res.writeHead(302, { location: "/media-evil/x.png" }).end();
      case "/media/to-inside":
        return void res.writeHead(302, { location: "/media/image/cat.png" }).end();
      case "/media/loop":
        return void res.writeHead(302, { location: "/media/loop" }).end();
      case "/media/declared-big":
        return send("video/mp4", Buffer.alloc(3000));
      case "/media/streamed-big": {
        // No content-length: the size is known only by counting what arrives.
        res.writeHead(200, { "content-type": "video/mp4" });
        res.write(Buffer.alloc(2000));
        setTimeout(() => res.end(Buffer.alloc(2000)), 20);
        return;
      }
      case "/media/missing":
        return void res.writeHead(404).end("no");
      case "/media-evil/x.png":
        return send("image/png", PNG);
      default:
        return void res.writeHead(404).end();
    }
  });
});

after(async () => {
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace);
  fs.rmSync(EXTERNAL_SERVERS_FILE, { force: true });
  outsideRequests = 0;
});

const prefix = () => [`${origin}/media/`];
const save = (url: string, output?: string, extra: { maxBytes?: number; origins?: string[] } = {}) =>
  saveMedia(url, output, { root: workspace, origins: extra.origins ?? prefix(), maxBytes: extra.maxBytes });
/** Every file under the workspace, relative. */
const tree = () => (fs.readdirSync(workspace, { recursive: true, withFileTypes: true }) as fs.Dirent[]).filter((e) => e.isFile()).map((e) => path.relative(workspace, path.join(e.parentPath, e.name)));
const leftovers = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("alfred-media-") && !n.startsWith("alfred-media-test-"));

test("a file goes under images/, video/ or audio/ by its content type, with a name from the URL", async () => {
  const day = localDate();
  assert.equal((await save(`${origin}/media/image/cat.png`)).file, `images/${day}/cat.png`);
  assert.equal((await save(`${origin}/media/video/clip.mp4`)).file, `video/${day}/clip.mp4`);
  const audio = await save(`${origin}/media/audio/speech.mp3`);
  assert.equal(audio.file, `audio/${day}/speech.mp3`);
  assert.equal(audio.contentType, "audio/mpeg");
  assert.deepEqual(fs.readFileSync(path.join(workspace, `images/${day}/cat.png`)), PNG);
  assert.deepEqual(leftovers(), [], "no temporary file is left");
});

test("a URL outside the configured prefixes is refused without a request: another path, a sibling of the prefix, another host or scheme, credentials", async () => {
  const refused: string[] = [
    `${origin}/other/x.png`,
    `${origin}/media-evil/x.png`,
    `${origin}/media`,
    `${origin}/media/../media-evil/x.png`,
    `${outside}/secret.png`,
    `https://127.0.0.1:${new URL(origin).port}/media/image/cat.png`,
    `http://user:pw@127.0.0.1:${new URL(origin).port}/media/image/cat.png`,
    "file:///etc/passwd",
    "not a url",
  ];
  for (const url of refused) await assert.rejects(save(url), /not under a media origin|not a URL/, url);
  assert.equal(outsideRequests, 0);
  assert.deepEqual(tree(), []);
});

test("a redirect out of the prefixes is refused before the other host is asked, and so is one to a sibling path", async () => {
  await assert.rejects(save(`${origin}/media/to-outside`), /redirects to .*\/secret\.png, which is not under a media origin/);
  assert.equal(outsideRequests, 0, "the outside host received no request");
  await assert.rejects(save(`${origin}/media/to-sibling`), /redirects to .*media-evil.*not under a media origin/);
  assert.deepEqual(tree(), []);
});

test("a redirect inside the prefixes is followed, and a loop is stopped", async () => {
  assert.equal((await save(`${origin}/media/to-inside`)).file, `images/${localDate()}/cat.png`);
  await assert.rejects(save(`${origin}/media/loop`), /redirects more than 5 times/);
});

test("a file over the limit is refused by its declared size and by the bytes that arrive, and leaves nothing behind", async () => {
  await assert.rejects(save(`${origin}/media/declared-big`, undefined, { maxBytes: 1000 }), /larger than the .* limit/);
  await assert.rejects(save(`${origin}/media/streamed-big`, "video/long.mp4", { maxBytes: 1000 }), /larger than the .* limit/);
  assert.deepEqual(tree(), []);
  assert.ok(!fs.existsSync(path.join(workspace, "video")), "not even the directory");
  assert.deepEqual(leftovers(), []);
  assert.equal(MEDIA_MAX_BYTES, 100 * 1024 * 1024);
  // Under the limit the same bytes are saved.
  assert.equal((await save(`${origin}/media/declared-big`, undefined, { maxBytes: 5000 })).bytes, 3000);
});

test("an existing file is never overwritten: an output path that is taken is refused, a default name gets a number", async () => {
  fs.mkdirSync(path.join(workspace, "notes"));
  fs.writeFileSync(path.join(workspace, "notes", "cat.png"), "mine");
  await assert.rejects(save(`${origin}/media/image/cat.png`, "notes/cat.png"), /already exists/);
  assert.equal(fs.readFileSync(path.join(workspace, "notes", "cat.png"), "utf8"), "mine");
  const day = localDate();
  assert.equal((await save(`${origin}/media/image/cat.png`)).file, `images/${day}/cat.png`);
  assert.equal((await save(`${origin}/media/image/cat.png`)).file, `images/${day}/cat-2.png`);
  assert.equal((await save(`${origin}/media/image/cat.png`, "notes/cover.png")).file, "notes/cover.png");
});

test("an output outside the workspace, a page that is not found and a type that is not media are refused", async () => {
  await assert.rejects(save(`${origin}/media/image/cat.png`, "../escape.png"), /outside the workspace/);
  await assert.rejects(save(`${origin}/media/missing`), /answered 404/);
  await assert.rejects(save(`${origin}/media/note.txt`), /only images, video and audio/);
  await assert.rejects(save(`${origin}/media/note.txt`, "notes/n.txt"), /only images, video and audio/);
  assert.deepEqual(tree(), []);
});

test("the guard treats save_media's output as a write path and refuses .git", () => {
  assert.match(checkToolInput(workspace, "mcp__alfred__save_media", { url: "x", output: ".git/x.png" }) ?? "", /\.git/);
  assert.equal(checkToolInput(workspace, "mcp__alfred__save_media", { url: "x" }), undefined);
  assert.match(
    checkToolInput(workspace, "mcp__alfred__save_media", { url: "x", output: "memory/x.png" }, { readOnly: { dirs: ["memory"], names: [] } }) ?? "",
    /read-only/,
  );
});

interface Result {
  content: { type: string; text: string }[];
  isError?: boolean;
}
type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<Result>;

test("the tool records the saved file on the run, and deliver accepts it", async () => {
  const sent: string[] = [];
  const out: Outbound = {
    channel: "app",
    async text() {},
    async file(absPath) {
      sent.push(absPath);
      return "file";
    },
  };
  const run = new RunRecorder({ kind: "task", title: "图片" });
  const defs = alfredToolDefinitions(out, undefined, run, undefined, false, false, { mediaOrigins: prefix(), generateImage: false });
  const call = (name: string, args: Record<string, unknown>) => (defs.find((d) => d.name === name)!.handler as unknown as Handler)(args, { signal: new AbortController().signal });
  const saved = await call("save_media", { url: `${origin}/media/image/cat.png` });
  assert.notEqual(saved.isError, true, saved.content[0]?.text);
  const rel = `images/${localDate()}/cat.png`;
  assert.deepEqual(run.record.files, [{ path: rel, tool: "save_media" }]);
  const delivered = await call("deliver", { path: rel });
  assert.notEqual(delivered.isError, true, delivered.content[0]?.text);
  assert.deepEqual(sent, [path.join(workspace, rel)]);
  const refused = await call("save_media", { url: `${outside}/secret.png` });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0]!.text, /not under a media origin/);
});

test("save_media is registered only with media origins, and the mmx image tool only when asked for", () => {
  const names = (media?: Parameters<typeof alfredToolDefinitions>[6]) => alfredToolDefinitions(appOutbound(), undefined, undefined, undefined, false, false, media).map((d) => d.name);
  assert.deepEqual(names(), ["deliver", "move_file", "render_pdf", "generate_image"]);
  assert.deepEqual(names({ mediaOrigins: [] }), ["deliver", "move_file", "render_pdf", "generate_image"]);
  assert.deepEqual(names({ mediaOrigins: prefix(), generateImage: false }), ["deliver", "move_file", "render_pdf", "save_media"]);
});

// Configuration and offering.

const affogato = {
  type: "http",
  url: "https://affogato.example/mcp",
  headers: { Authorization: "env:ALFRED_AFFOGATO_TEST_AUTH" },
  tools: ["generate_image", "edit_image", "generate_video", "get_video", "generate_speech", "list_voices", "server_info"],
  mediaOrigins: ["https://affogato.example/media/"],
  spend: { generate_video: { priceUsd: 1, maxPerRun: 1 } },
  timeoutMs: 660000,
};

function writeFile(content: unknown): void {
  fs.mkdirSync(path.dirname(EXTERNAL_SERVERS_FILE), { recursive: true });
  fs.writeFileSync(EXTERNAL_SERVERS_FILE, JSON.stringify(content));
}

/** The tools of Alfred's in-process MCP server in these options, by name. */
function alfredTools(options: ReturnType<typeof agentOptions>): string[] {
  const server = options.mcpServers?.alfred as unknown as { instance: { _registeredTools: Record<string, unknown> } };
  return Object.keys(server.instance._registeredTools);
}

test("mediaOrigins is checked like the other fields: https URLs without credentials, query or fragment, kept as directory prefixes", () => {
  const cases: Array<[unknown, RegExp]> = [
    [["http://affogato.example/media/"], /mediaOrigins entry http:\/\/affogato\.example\/media\/ must be https/],
    [["https://u:p@affogato.example/media/"], /must not hold credentials/],
    [["https://affogato.example/media/?x=1"], /must not hold a query or fragment/],
    [["https://affogato.example/media/#a"], /must not hold a query or fragment/],
    [["not a url"], /mediaOrigins must be a list of URLs/],
    [[7], /mediaOrigins must be a list of URLs/],
    ["https://affogato.example/media/", /mediaOrigins must be a list of URLs/],
    [[], /mediaOrigins must be a list of URLs/],
  ];
  for (const [mediaOrigins, message] of cases) {
    writeFile({ affogato: { ...affogato, mediaOrigins } });
    assert.throws(() => loadExternalServers(undefined, { ALFRED_AFFOGATO_TEST_AUTH: "x" }), (err) => err instanceof InvalidExternalServers && message.test(err.message), String(mediaOrigins));
  }
  const [server] = parseExternalServers({ a: { ...affogato, mediaOrigins: ["https://affogato.example/media", "https://affogato.example/media/", "https://cdn.example:8443"] } }, { ALFRED_AFFOGATO_TEST_AUTH: "x" });
  assert.deepEqual(server?.mediaOrigins, ["https://affogato.example/media/", "https://cdn.example:8443/"]);
  assert.deepEqual(parseExternalServers({ a: { type: "http", url: "https://a.example/", tools: ["t"] } })[0]?.mediaOrigins, []);
});

test("a URL is under a prefix by its parsed parts, not by its text", () => {
  const prefixes = ["https://affogato.example/media/"];
  const under = (u: string) => underMediaOrigin(new URL(u), prefixes);
  assert.ok(under("https://affogato.example/media/image/a.png"));
  assert.ok(under("https://AFFOGATO.example/media/a.png?sig=1"));
  for (const u of [
    "https://affogato.example.evil/media/a.png",
    "https://affogato.example@evil.example/media/a.png",
    "https://affogato.example:8443/media/a.png",
    "http://affogato.example/media/a.png",
    "https://affogato.example/media-evil/a.png",
    "https://affogato.example/media",
    "https://affogato.example/media/../secret",
    "https://affogato.example/%2e%2e/x",
  ]) {
    assert.ok(!under(u), u);
  }
});

test("when a configured server offers generate_image, the run has one image tool: affogato's, and not Alfred's mmx tool", () => {
  prepareWorkspace();
  const without = agentOptions({ out: appOutbound(), model: "sonnet" });
  assert.ok(alfredTools(without).includes("generate_image"));
  assert.ok(without.allowedTools?.includes("mcp__alfred__generate_image"));
  assert.ok(!alfredTools(without).includes("save_media"));
  assert.ok(!without.allowedTools?.includes("mcp__alfred__save_media"));

  writeFile({ affogato });
  const chat = agentOptions({ out: appOutbound(), model: "sonnet" });
  assert.ok(!alfredTools(chat).includes("generate_image"));
  assert.ok(!chat.allowedTools?.includes("mcp__alfred__generate_image"));
  assert.ok(chat.allowedTools?.includes("mcp__affogato__generate_image"));
  assert.ok(alfredTools(chat).includes("save_media"));
  assert.ok(chat.allowedTools?.includes("mcp__alfred__save_media"));
  assert.equal(chat.agents?.writer?.tools?.includes("mcp__alfred__generate_image"), false);

  // A server without generate_image leaves the mmx tool in place, and a server's list is what counts per run: this run's.
  writeFile({ affogato: { ...affogato, tools: ["generate_speech", "get_video"], spend: {} } });
  const speech = agentOptions({ out: appOutbound(), model: "sonnet" });
  assert.ok(alfredTools(speech).includes("generate_image"));
  assert.ok(speech.allowedTools?.includes("mcp__alfred__generate_image"));
  assert.ok(alfredTools(speech).includes("save_media"));

  writeFile({ affogato: { ...affogato, unattended: ["generate_speech"] } });
  const task = agentOptions({ out: appOutbound(), model: "sonnet", task: { budgetUsd: 1 } });
  assert.ok(alfredTools(task).includes("generate_image"), "an unattended run not offered affogato's image tool keeps mmx");
  assert.ok(alfredTools(task).includes("save_media"), "it is offered a speech tool, so it saves");
  writeFile({ affogato: { ...affogato, unattended: ["generate_image"] } });
  const imaging = agentOptions({ out: appOutbound(), model: "sonnet", task: { budgetUsd: 1 } });
  assert.ok(!alfredTools(imaging).includes("generate_image"));
});

test("a run offered no media tool has no save_media: a server without mediaOrigins, unattended runs the file does not name", () => {
  prepareWorkspace();
  writeFile({ affogato: { ...affogato, mediaOrigins: undefined } });
  assert.ok(!alfredTools(agentOptions({ out: appOutbound(), model: "sonnet" })).includes("save_media"));
  writeFile({ affogato });
  for (const run of [{ task: { budgetUsd: 1 } }, { revision: { budgetUsd: 1 } }]) {
    const options = agentOptions({ out: appOutbound(), model: "sonnet", ...run });
    assert.ok(!alfredTools(options).includes("save_media"), JSON.stringify(run));
    assert.ok(!options.allowedTools?.includes("mcp__alfred__save_media"));
    assert.ok(alfredTools(options).includes("generate_image"), "mmx stays where affogato is not offered");
    assert.doesNotMatch(String(options.systemPrompt), /^# Media$/m);
  }
});

test("subagents get media tools only when the file names them, and save_media only with one", async () => {
  const bare = parseExternalServers({ affogato }, { ALFRED_AFFOGATO_TEST_AUTH: "x" });
  assert.equal(mediaOffer(bare, false).subagents, false);
  assert.deepEqual(subagentExternalTools(bare, false), []);
  assert.match(checkExternalTool(bare, "mcp__alfred__save_media", true, false) ?? "", /save_media is not offered to subagents/);
  assert.match(checkExternalTool(bare, "mcp__affogato__generate_speech", true, false) ?? "", /not offered to subagents/);
  assert.equal(checkExternalTool(bare, "mcp__alfred__save_media", false, false), undefined, "the main thread is not the question");

  const named = parseExternalServers({ affogato: { ...affogato, subagents: ["generate_speech"] } }, { ALFRED_AFFOGATO_TEST_AUTH: "x" });
  assert.equal(mediaOffer(named, false).subagents, true);
  assert.deepEqual(subagentExternalTools(named, false), ["mcp__affogato__generate_speech", "mcp__alfred__save_media"]);
  assert.equal(checkExternalTool(named, "mcp__alfred__save_media", true, false), undefined);
  assert.equal(checkExternalTool(named, "mcp__affogato__generate_speech", true, false), undefined);
  // An unattended run's subagents need the tool in both lists.
  assert.deepEqual(subagentExternalTools(named, true), []);
  assert.match(checkExternalTool(named, "mcp__alfred__save_media", true, true) ?? "", /not offered to subagents/);
  const both = parseExternalServers({ affogato: { ...affogato, unattended: ["generate_speech"], subagents: ["generate_speech"] } }, { ALFRED_AFFOGATO_TEST_AUTH: "x" });
  assert.deepEqual(subagentExternalTools(both, true), ["mcp__affogato__generate_speech", "mcp__alfred__save_media"]);

  // The hook says the same to a subagent, whatever its type.
  const { externalToolGuard } = await import("./external.ts");
  const hook = externalToolGuard(bare, { unattended: false }).hooks[0]!;
  const input = { hook_event_name: "PreToolUse", tool_name: "mcp__alfred__save_media", tool_input: { url: "x" }, tool_use_id: "t", session_id: "s", transcript_path: "", cwd: "", agent_id: "a1", agent_type: "general-purpose" };
  const denied = (await hook(input as never, "t", { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string } };
  assert.equal(denied.hookSpecificOutput?.permissionDecision, "deny");
  const main = await hook({ ...input, agent_id: undefined } as never, "t", { signal: new AbortController().signal });
  assert.deepEqual(main, {});

  // The role definitions list what the file names, and nothing of the media tools otherwise.
  writeFile({ affogato: { ...affogato, subagents: ["generate_speech"] } });
  prepareWorkspace();
  const options = agentOptions({ out: appOutbound(), model: "sonnet" });
  for (const role of Object.values(options.agents ?? {})) {
    assert.ok(role.tools?.includes("mcp__affogato__generate_speech"));
    assert.ok(role.tools?.includes("mcp__alfred__save_media"));
    assert.ok(!role.tools?.includes("mcp__affogato__generate_video"));
  }
  assert.ok(!Object.values(subagentDefinitions()).some((role) => role.tools?.some((t) => t.includes("save_media") || t.startsWith("mcp__affogato"))));
  writeFile({ affogato });
  for (const role of Object.values(agentOptions({ out: appOutbound(), model: "sonnet" }).agents ?? {})) {
    assert.ok(!role.tools?.some((t) => t.includes("save_media") || t.startsWith("mcp__affogato")));
  }
});

test("the system prompt has the media lines only when media tools are offered", () => {
  prepareWorkspace();
  const plain = String(agentOptions({ out: appOutbound(), model: "sonnet" }).systemPrompt);
  assert.doesNotMatch(plain, /save_media|get_video/);
  writeFile({ affogato });
  const prompt = String(agentOptions({ out: appOutbound(), model: "sonnet" }).systemPrompt);
  const section = /^# Media\n([\s\S]*?)(?:\n\n|(?![\s\S]))/m.exec(prompt)?.[1] ?? "";
  assert.match(section, /Save a result with save_media before you read or deliver it/);
  assert.match(section, /task id[\s\S]*get_video[\s\S]*never start the video again/);
  assert.match(section, /billed, even when it fails/);
});
