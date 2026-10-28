import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, mock, test } from "node:test";

import type { IdeaList, Settings, TaskList } from "../api/schema.ts";

// store.ts reads these at import time, so set them before loading the modules under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-workbench-")));
const workspace = path.join(tmp, "workspace");
const state = path.join(tmp, "state");
process.env.ALFRED_WORKSPACE = workspace;
process.env.ALFRED_STATE_DIR = state;

const { RunRecorder, TASKS_FILE, appendRunLog, newRunId, writeHeartbeat } = await import("../runs.ts");
const { EventLog } = await import("../events.ts");
const { DOCUMENTS_FILE, DocumentStore } = await import("../documents/store.ts");
const { VERSIONS_GIT_DIR, Versions } = await import("../documents/versions.ts");
const { IDEAS_FILE } = await import("../ideas/store.ts");
const { SETTINGS_MIRROR_FILE } = await import("../settings/store.ts");
const { DocumentDetailSchema, DocumentListSchema, ErrorResponseSchema, IdeaListSchema, MemoryListSchema, RulesSchema, RunDetailSchema, RunListSchema, SettingsDetailSchema, TaskDetailSchema, TaskListSchema } = await import("../api/schema.ts");
const { AccessVerifier } = await import("./access.ts");
const { DeviceStore } = await import("./devices.ts");
const { REPORT_CSP, createHandler, inlineImages, startWorkbench } = await import("./server.ts");

const SECRET = "SECRET-TOKEN-0123456789";
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const access = new AccessVerifier(
  { teamDomain: "team.cloudflareaccess.com", aud: "aud", ownerEmail: "owner@example.com", serviceClientId: "svc.access" },
  { fetcher: async () => ({ keys: [{ ...publicKey.export({ format: "jwk" }), kty: "RSA", kid: "k" }] }) },
);

function jwt(patch: Record<string, unknown> = {}): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "RS256", kid: "k" });
  const body = enc({ aud: ["aud"], iss: "https://team.cloudflareaccess.com", email: "owner@example.com", exp: Date.now() / 1000 + 600, ...patch });
  return `${head}.${body}.${crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
}

/** What Access signs for a request that passed a Service Auth policy: the client id, no email. */
function serviceJwt(clientId = "svc.access"): string {
  return jwt({ email: undefined, common_name: clientId, type: "app" });
}

/** The workspace's history, as the store of the versions writes it; the routes read the same git dir. */
const history = new Versions({ workspace, gitDir: VERSIONS_GIT_DIR });

const servers: http.Server[] = [];
let open = ""; // no Access check, as on the Unix socket
let guarded = ""; // Access required, as on the tunnel's TCP listener
let runId = "";
const devicesDir = path.join(tmp, "app");
const devices = new DeviceStore(devicesDir);
let paired = { id: "", token: "" };

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

before(async () => {
  for (const dir of ["reports", "notes", "images", "memory"]) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
  fs.mkdirSync(path.join(tmp, "outside"));
  fs.writeFileSync(path.join(tmp, "outside", "secret.txt"), SECRET);
  fs.symlinkSync(path.join(tmp, "outside"), path.join(workspace, "escape"));
  fs.writeFileSync(path.join(workspace, "notes", "a.md"), "# Note\n\n<script>alert(1)</script> <img src=x onerror=alert(2)>\n\n[x](javascript:alert(3))\n");
  fs.writeFileSync(path.join(workspace, "reports", "r.html"), '<p>chart</p><img src="../images/p.png"><script>fetch("/")</script>');
  fs.writeFileSync(path.join(workspace, "reports", "c.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  fs.writeFileSync(path.join(workspace, "images", "p.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(workspace, "memory", "m.md"), "---\nname: Likes tea\ndescription: d\ntype: preference\nupdated: 2026-10-20\n---\nTea.\n");

  // Secrets the workbench must never show, wherever they sit in the state dir.
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, "account.json"), JSON.stringify({ botToken: SECRET }));
  fs.writeFileSync(path.join(state, "context-tokens.json"), JSON.stringify({ owner: { token: SECRET, updatedAt: Date.now() } }));
  writeHeartbeat({ pid: 1, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), memory: { rssBytes: 1 } });
  const statusFile = path.join(state, "workbench", "status.json");
  fs.writeFileSync(statusFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(statusFile, "utf8")), botToken: SECRET }));

  const run = new RunRecorder({ kind: "task", title: "<b>title</b>", model: "claude-sonnet-5-5" });
  run.step("WebFetch", "https://example.com/<script>");
  run.wrote("reports/r.html", "Write");
  run.finish("done");
  runId = run.id;

  paired = devices.createDevice("test phone");
  open = await serve(createHandler({ workspace, devices }));
  guarded = await serve(createHandler({ workspace, access, devices }));
  await history.init();
});

after(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("the tunnel listener refuses requests without a valid Access token", async () => {
  assert.equal((await fetch(`${guarded}/`)).status, 403);
  assert.equal((await fetch(`${guarded}/`, { headers: { "Cf-Access-Jwt-Assertion": "x.y.z" } })).status, 403);
  assert.equal((await fetch(`${guarded}/files/raw?path=notes/a.md`)).status, 403);
  assert.equal((await fetch(`${guarded}/`, { headers: { "Cf-Access-Jwt-Assertion": jwt() } })).status, 200);
});

test("every endpoint rejects methods other than GET", async () => {
  for (const base of [open, guarded]) {
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]) {
      for (const p of ["/", "/runs", "/files/raw?path=notes/a.md"]) {
        const res = await fetch(`${base}${p}`, { method, headers: { "Cf-Access-Jwt-Assertion": jwt() } });
        assert.equal(res.status, 405, `${method} ${p}`);
      }
    }
  }
});

test("no page shows a secret, and every response carries nosniff and a CSP", async () => {
  const pages = ["/", "/runs", `/runs/${runId}`, "/spend", "/files", "/files?path=notes", "/files/view?path=notes/a.md", "/memory", "/logs", "/sessions"];
  for (const p of pages) {
    const res = await fetch(`${open}${p}`);
    const body = await res.text();
    assert.equal(res.status, 200, p);
    assert.ok(!body.includes(SECRET), `${p} shows a secret`);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff", p);
    assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/, p);
  }
});

test("a run's card names a memory scan and a generation of ideas by their kind, where a task's names its model", async () => {
  const scan = new RunRecorder({ kind: "scan", title: "scan card", model: "claude-haiku-5-5" });
  scan.finish("done");
  const ideas = new RunRecorder({ kind: "ideas", title: "ideas card", model: "claude-sonnet-5-5" });
  ideas.finish("done");
  const task = new RunRecorder({ kind: "task", title: "task card", model: "claude-sonnet-5-5" });
  task.finish("done");
  const meta = async (id: string) => /<div class="meta">([^<]*)/.exec(await (await fetch(`${open}/runs/${id}`)).text())?.[1] ?? "";

  assert.match(await meta(scan.id), /^记忆扫描 · /);
  assert.match(await meta(ideas.id), /^想法 · /);
  assert.doesNotMatch(await meta(task.id), /^(记忆扫描|想法)/);
});

test("values from state and the workspace are escaped", async () => {
  const body = await (await fetch(`${open}/runs/${runId}`)).text();
  assert.ok(body.includes("&lt;b&gt;title&lt;/b&gt;"));
  assert.ok(!body.includes("<b>title</b>"));
  assert.ok(body.includes("https://example.com/&lt;script&gt;"));
});

test("Markdown renders without raw HTML or script links", async () => {
  const body = await (await fetch(`${open}/files/view?path=notes/a.md`)).text();
  assert.ok(body.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!/<img[^>]*onerror/i.test(body));
  assert.ok(!body.includes("javascript:"));
});

test("workspace paths are confined, symlinks included", async () => {
  for (const p of ["../state/account.json", "/etc/passwd", "escape/secret.txt", "notes/../../outside/secret.txt"]) {
    for (const route of ["/files/raw", "/files/view", "/files"]) {
      const res = await fetch(`${open}${route}?path=${encodeURIComponent(p)}`);
      const body = await res.text();
      assert.equal(res.status, 404, `${route} ${p}`);
      assert.ok(!body.includes(SECRET));
    }
  }
});

test("an HTML report renders in a sandboxed frame under the report policy, images inlined", async () => {
  const res = await fetch(`${open}/files/view?path=reports/r.html`);
  const body = await res.text();
  assert.equal(res.headers.get("content-security-policy"), REPORT_CSP);
  assert.match(REPORT_CSP, /default-src 'none'/);
  assert.doesNotMatch(REPORT_CSP, /connect-src|'self'/);
  const frame = /<iframe[^>]*>/.exec(body)?.[0] ?? "";
  assert.match(frame, /sandbox="allow-scripts"/);
  assert.doesNotMatch(frame, /allow-same-origin|allow-top-navigation|allow-popups|allow-forms/);
  assert.ok(!/<script/i.test(body), "the report's script stays inside the escaped srcdoc");
  assert.ok(body.includes("data:image/png;base64,iVBORw=="), "the workspace image is inlined");
});

test("raw HTML and SVG download as attachments and never run on the workbench origin", async () => {
  const htmlRes = await fetch(`${open}/files/raw?path=reports/r.html`);
  assert.equal(htmlRes.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.match(htmlRes.headers.get("content-disposition") ?? "", /^attachment/);
  const svg = await fetch(`${open}/files/raw?path=reports/c.svg`);
  assert.match(svg.headers.get("content-disposition") ?? "", /^attachment/);
  assert.match(svg.headers.get("content-security-policy") ?? "", /sandbox/);
  const png = await fetch(`${open}/files/raw?path=images/p.png`);
  assert.equal(png.headers.get("content-type"), "image/png");
  assert.match(png.headers.get("content-disposition") ?? "", /^inline/);
});

test("inlineImages inlines workspace images only", () => {
  const report = path.join(workspace, "reports", "r.html");
  const out = inlineImages('<img src="../images/p.png"><img src="../../outside/x.png"><img src="https://e.com/x.png">', report, workspace);
  assert.match(out, /src="data:image\/png;base64,/);
  assert.match(out, /src="\.\.\/\.\.\/outside\/x\.png"/);
  assert.match(out, /src="https:\/\/e\.com\/x\.png"/);
});

test("Alfred shows as down after a clean stop or 90 s without a heartbeat", async () => {
  const beat = (patch: object) => writeHeartbeat({ pid: 1, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), memory: { rssBytes: 1 }, ...patch });
  const shown = async () => ((await (await fetch(`${open}/`)).text()).includes(`class="status s-up"`) ? "up" : "down");
  beat({});
  assert.equal(await shown(), "up");
  beat({ stoppedAt: new Date().toISOString() });
  assert.equal(await shown(), "down");
  beat({ updatedAt: new Date(Date.now() - 95_000).toISOString() });
  assert.equal(await shown(), "down");
});

// --- /api/ -----------------------------------------------------------------

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** The /api/ error answers: JSON that parses as an ErrorResponse, with the base headers and no caching. */
async function assertApiError(res: Response, status: number, label: string): Promise<void> {
  assert.equal(res.status, status, label);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/, label);
  assert.equal(res.headers.get("cache-control"), "no-store", label);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff", label);
  assert.equal(res.headers.get("referrer-policy"), "no-referrer", label);
  assert.ok(ErrorResponseSchema.safeParse(await res.json()).success, label);
}

test("GET /api/ping answers 204 for a paired device, on both kinds of listener", async () => {
  const withJwt = { ...bearer(paired.token), "Cf-Access-Jwt-Assertion": jwt() };
  for (const [base, headers] of [[open, bearer(paired.token)], [guarded, withJwt]] as const) {
    const res = await fetch(`${base}/api/ping`, { headers });
    assert.equal(res.status, 204);
    assert.equal(await res.text(), "");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal((await fetch(`${base}/api/ping?x=1`, { headers })).status, 204, "a query string does not matter");
  }
});

test("/api/ answers 401 with a Bearer challenge without a valid device token", async () => {
  const revoked = devices.createDevice("lost phone");
  new DeviceStore(devicesDir).revokeDevice(revoked.id); // as the devices revoke command does, from another process
  const wrong = [
    ["no header", {}],
    ["empty token", { Authorization: "Bearer " }],
    ["no scheme", { Authorization: paired.token }],
    ["another scheme", { Authorization: `Basic ${paired.token}` }],
    ["two tokens", { Authorization: `Bearer ${paired.token} ${paired.token}` }],
    ["a character outside base64url", { Authorization: `Bearer ${paired.token}=` }],
    ["a token nobody holds", bearer("A".repeat(43))],
    ["a truncated token", bearer(paired.token.slice(0, 20))],
    ["a revoked device", bearer(revoked.token)],
  ] as const;
  for (const base of [open, guarded]) {
    for (const [label, headers] of wrong) {
      const res = await fetch(`${base}/api/ping`, { headers: { ...headers, "Cf-Access-Jwt-Assertion": jwt() } });
      assert.equal(res.headers.get("www-authenticate"), "Bearer", label);
      await assertApiError(res, 401, label);
    }
  }
  assert.equal((await fetch(`${open}/api/ping`, { headers: bearer(paired.token) })).status, 204, "the paired device is unaffected");
});

test("a revoke applies to the next request without a restart", async () => {
  const phone = devices.createDevice("phone");
  assert.equal((await fetch(`${open}/api/ping`, { headers: bearer(phone.token) })).status, 204);
  new DeviceStore(devicesDir).revokeDevice(phone.id);
  assert.equal((await fetch(`${open}/api/ping`, { headers: bearer(phone.token) })).status, 401);
});

test("on the tunnel listener /api/ needs the Access token before anything else", async () => {
  const cases = [
    ["no JWT", {}],
    ["a malformed JWT", { "Cf-Access-Jwt-Assertion": "x.y.z" }],
    ["no JWT, with a device token", bearer(paired.token)],
    ["a service token for another client", { "Cf-Access-Jwt-Assertion": serviceJwt("other.access"), ...bearer(paired.token) }],
  ] as const;
  for (const [label, headers] of cases) {
    await assertApiError(await fetch(`${guarded}/api/ping`, { headers }), 403, label);
  }
  // Even a request that would be a 404 is refused first.
  await assertApiError(await fetch(`${guarded}/api/nothing`), 403, "unknown path");
});

test("/api/ accepts the owner's and the service token's Access JWT, and still wants a device token", async () => {
  for (const [who, token] of [["owner", jwt()], ["service token", serviceJwt()]] as const) {
    const headers = { "Cf-Access-Jwt-Assertion": token };
    assert.equal((await fetch(`${guarded}/api/ping`, { headers: { ...headers, ...bearer(paired.token) } })).status, 204, who);
    const res = await fetch(`${guarded}/api/ping`, { headers });
    assert.equal(res.headers.get("www-authenticate"), "Bearer", who);
    await assertApiError(res, 401, who);
  }
});

test("a service-token JWT gets 403 on a page, and the owner's JWT still gets in", async () => {
  for (const p of ["/", "/runs", "/files/raw?path=notes/a.md"]) {
    const res = await fetch(`${guarded}${p}`, { headers: { "Cf-Access-Jwt-Assertion": serviceJwt(), ...bearer(paired.token) } });
    assert.equal(res.status, 403, p);
    assert.match(res.headers.get("content-type") ?? "", /^text\/html/, p);
  }
  assert.equal((await fetch(`${guarded}/`, { headers: { "Cf-Access-Jwt-Assertion": jwt() } })).status, 200);
});

test("pages ignore the device token", async () => {
  assert.equal((await fetch(`${open}/`)).status, 200, "no bearer needed");
  assert.equal((await fetch(`${open}/`, { headers: bearer("A".repeat(43)) })).status, 200, "a bad bearer does not matter either");
});

test("POST works under /api/ and still gives 405 on pages", async () => {
  const headers = { ...bearer(paired.token), "Content-Type": "application/json" };
  // No POST route exists yet: a 404 JSON body, not the 405 a page would give, shows the method got through.
  await assertApiError(await fetch(`${open}/api/nothing`, { method: "POST", headers, body: "{}" }), 404, "POST");
  const tunnel = { ...headers, "Cf-Access-Jwt-Assertion": serviceJwt() };
  await assertApiError(await fetch(`${guarded}/api/nothing`, { method: "POST", headers: tunnel, body: "{}" }), 404, "POST on the tunnel");
  // Without a device token a POST is refused like a GET.
  await assertApiError(await fetch(`${open}/api/nothing`, { method: "POST", body: "{}" }), 401, "POST without a token");
  for (const base of [open, guarded]) {
    for (const p of ["/", "/runs", "/api", "/apix"]) {
      const res = await fetch(`${base}${p}`, { method: "POST", headers: { ...headers, "Cf-Access-Jwt-Assertion": jwt() }, body: "{}" });
      assert.equal(res.status, 405, `POST ${p}`);
      assert.equal(res.headers.get("allow"), "GET", `POST ${p}`);
    }
  }
});

test("under /api/ only GET and POST are allowed", async () => {
  for (const method of ["PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]) {
    const res = await fetch(`${open}/api/ping`, { method, headers: bearer(paired.token) });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get("allow"), "GET, POST", method);
    if (method !== "HEAD") assert.ok(ErrorResponseSchema.safeParse(await res.json()).success, method);
  }
});

test("an unknown /api/ path answers a 404 JSON body", async () => {
  for (const p of ["/api/", "/api/nothing", "/api/ping/", "/api/ping/x", "/api/runs/", "/api/PING"]) {
    await assertApiError(await fetch(`${open}${p}`, { headers: bearer(paired.token) }), 404, p);
  }
  // Without a device token the path is not revealed.
  await assertApiError(await fetch(`${open}/api/nothing`), 401, "unknown path, no token");
});

test("a path that resolves to /api/ is held to the /api/ rules", async () => {
  const raw = (rawPath: string, headers: http.OutgoingHttpHeaders = {}) =>
    new Promise<number | undefined>((resolve, reject) => {
      const url = new URL(open);
      http.get({ host: url.hostname, port: url.port, path: rawPath, headers }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on("error", reject);
    });
  assert.equal(await raw("/runs/../api/ping"), 401);
  assert.equal(await raw("/runs/../api/ping", bearer(paired.token)), 204);
  assert.equal(await raw("/api/../runs"), 200, "and one that leaves /api/ is a page");
});

test("a refused /api/ request is logged with its reason, never with a token", async () => {
  const secretToken = `${"B".repeat(42)}Z`;
  const lines = mock.method(console, "error", () => {});
  try {
    await fetch(`${open}/api/ping`, { headers: bearer(secretToken) });
    await fetch(`${open}/api/ping`);
    await fetch(`${open}/api/ping`, { headers: { Authorization: `Bearer ${secretToken}!` } });
    await fetch(`${guarded}/api/ping`, { headers: bearer(secretToken) });
  } finally {
    lines.mock.restore();
  }
  const logged = lines.mock.calls.map((call) => String(call.arguments[0]));
  assert.equal(logged.length, 4);
  assert.match(logged[0] ?? "", /refused.*\/api\/ping.*not a paired device/);
  assert.match(logged[1] ?? "", /refused.*no Authorization header/);
  assert.match(logged[2] ?? "", /refused.*malformed/);
  assert.match(logged[3] ?? "", /refused.*no Access token/);
  assert.ok(!logged.some((line) => line.includes(secretToken) || line.includes(paired.token)));
});

test("the Unix socket listener needs the device token for /api/ too, and nothing for pages", async () => {
  const socket = path.join(tmp, "w.sock");
  const close = await startWorkbench({ workspace, socket, devices });
  try {
    const get = (p: string, headers: http.OutgoingHttpHeaders = {}) =>
      new Promise<number | undefined>((resolve, reject) => {
        http.get({ socketPath: socket, path: p, headers }, (res) => {
          res.resume();
          resolve(res.statusCode);
        }).on("error", reject);
      });
    assert.equal(await get("/api/ping"), 401);
    assert.equal(await get("/api/ping", bearer("A".repeat(43))), 401);
    assert.equal(await get("/api/ping", bearer(paired.token)), 204);
    assert.equal(await get("/api/nothing", bearer(paired.token)), 404);
    assert.equal(await get("/"), 200);
  } finally {
    await close();
  }
});

// --- /api/runs and /api/files ----------------------------------------------

test("GET /api/runs lists the 100 newest runs, newest first, with only the client's fields", async () => {
  for (let i = 0; i < 101; i++) {
    const run = new RunRecorder({ kind: "task", title: `bulk ${i}`, startedAt: new Date(Date.UTC(2030, 0, 1, 0, 0, i)).toISOString() });
    run.finish("done");
  }
  const res = await fetch(`${open}/api/runs`, { headers: bearer(paired.token) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "no-store");
  const text = await res.text();
  const list = RunListSchema.parse(JSON.parse(text));
  assert.equal(list.runs.length, 100);
  assert.equal(list.runs[0]?.title, "bulk 100");
  const starts = list.runs.map((r) => r.startedAt);
  assert.deepEqual(starts, [...starts].sort().reverse(), "newest first");
  for (const field of ["toolCalls", "updatedAt", "steps"]) assert.ok(!text.includes(`"${field}"`), `${field} is not sent`);
});

test("GET /api/runs/<id> gives the run and its steps, and 404 for an unknown or malformed id", async () => {
  const res = await fetch(`${open}/api/runs/${runId}`, { headers: bearer(paired.token) });
  assert.equal(res.status, 200);
  const detail = RunDetailSchema.parse(await res.json());
  assert.equal(detail.run.id, runId);
  assert.deepEqual(detail.steps.map((s) => s.tool), ["WebFetch"]);
  for (const p of ["abcdef", "ABCDEF", "abc", `${runId}0`]) {
    await assertApiError(await fetch(`${open}/api/runs/${p}`, { headers: bearer(paired.token) }), 404, p);
  }
});

test("GET /api/runs/<id> has no steps for a run whose run file is gone", async () => {
  const run = new RunRecorder({ kind: "task", title: "no file" });
  run.step("WebSearch", "q");
  run.finish("done");
  fs.rmSync(path.join(state, "workbench", "runs", `${run.id}.json`));
  const detail = RunDetailSchema.parse(await (await fetch(`${open}/api/runs/${run.id}`, { headers: bearer(paired.token) })).json());
  assert.equal(detail.run.id, run.id);
  assert.deepEqual(detail.steps, []);
});

test("GET /api/files/<path> serves a workspace file raw, with its type and the sandbox policy", async () => {
  const get = (p: string) => fetch(`${open}/api/files/${p}`, { headers: bearer(paired.token) });
  const md = await get("notes/a.md");
  assert.equal(md.status, 200);
  assert.equal(md.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(md.headers.get("content-security-policy"), "sandbox");
  assert.equal(md.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await md.text(), fs.readFileSync(path.join(workspace, "notes", "a.md"), "utf8"));

  const png = await get("images/p.png");
  assert.equal(png.headers.get("content-type"), "image/png");
  assert.deepEqual([...Buffer.from(await png.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47]);

  const html = await get("reports/r.html");
  assert.equal(html.headers.get("content-type"), "text/plain; charset=utf-8", "HTML is never served as HTML");
  assert.equal(html.headers.get("content-security-policy"), "sandbox");

  const svg = await get("reports/c.svg");
  assert.equal(svg.headers.get("content-type"), "image/svg+xml");
  assert.equal(svg.headers.get("content-security-policy"), "sandbox");
});

const MiB = 1024 * 1024;

test("GET /api/files/<path> inlines a report's workspace images as data: URIs, in .html and .htm alike", async () => {
  const get = (p: string) => fetch(`${open}/api/files/${p}`, { headers: bearer(paired.token) });
  fs.writeFileSync(path.join(workspace, "reports", "h.htm"), '<img src="../images/p.png">');
  const res = await get("reports/r.html");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(res.headers.get("content-security-policy"), "sandbox");
  const png = fs.readFileSync(path.join(workspace, "images", "p.png")).toString("base64");
  const body = await res.text();
  assert.equal(body, `<p>chart</p><img src="data:image/png;base64,${png}"><script>fetch("/")</script>`);
  assert.equal(res.headers.get("content-length"), String(Buffer.byteLength(body)), "Content-Length is the inlined size");
  const htm = await (await get("reports/h.htm")).text();
  assert.equal(htm, `<img src="data:image/png;base64,${png}">`);
});

test("GET /api/files/<path> leaves a report's image alone when it is outside the workspace, reached through a link, or over the per-image cap", async () => {
  const get = (p: string) => fetch(`${open}/api/files/${p}`, { headers: bearer(paired.token) });
  fs.writeFileSync(path.join(tmp, "outside", "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const outside = '<img src="../../outside/pic.png"><img src="../escape/pic.png">';
  fs.writeFileSync(path.join(workspace, "reports", "outside.html"), outside);
  assert.equal(await (await get("reports/outside.html")).text(), outside);

  const big = path.join(workspace, "images", "big.png");
  fs.writeFileSync(big, "");
  fs.truncateSync(big, 8 * MiB + 1);
  const over = '<img src="../images/big.png">';
  fs.writeFileSync(path.join(workspace, "reports", "big.html"), over);
  assert.equal(await (await get("reports/big.html")).text(), over);
});

test("GET /api/files/<path> sends an HTML report over the 4 MiB preview cap as it is", async () => {
  const report = path.join(workspace, "reports", "huge.html");
  fs.writeFileSync(report, '<img src="../images/p.png">');
  fs.truncateSync(report, 4 * MiB + 1);
  const res = await fetch(`${open}/api/files/reports/huge.html`, { headers: bearer(paired.token) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-length"), String(4 * MiB + 1));
  assert.ok((await res.text()).startsWith('<img src="../images/p.png">'));
});

test("GET /api/files/<path> stops inlining an HTML report's images at the 24 MiB total", async () => {
  const get = (p: string) => fetch(`${open}/api/files/${p}`, { headers: bearer(paired.token) });
  const names = ["t1", "t2", "t3", "t4"];
  for (const n of names) {
    const file = path.join(workspace, "images", `${n}.png`);
    fs.writeFileSync(file, "");
    fs.truncateSync(file, 7 * MiB);
  }
  fs.writeFileSync(path.join(workspace, "reports", "total.html"), names.map((n) => `<img src="../images/${n}.png">`).join(""));
  const body = await (await get("reports/total.html")).text();
  assert.equal(body.split("data:image/png;base64,").length - 1, 3, "three 7 MiB images fit under 24 MiB");
  assert.ok(body.endsWith('<img src="../images/t4.png">'), "the fourth is left as it was");
});

test("GET /api/files/<path> serves a non-HTML file byte for byte, even one that names a workspace image", async () => {
  const get = (p: string) => fetch(`${open}/api/files/${p}`, { headers: bearer(paired.token) });
  const refs = '<img src="../images/p.png"> <image href="../images/p.png"/>';
  for (const rel of ["notes/refs.md", "notes/refs.txt", "reports/refs.svg"]) fs.writeFileSync(path.join(workspace, rel), refs);
  for (const rel of ["notes/refs.md", "notes/refs.txt", "reports/refs.svg"]) {
    const res = await get(rel);
    assert.equal(res.status, 200, rel);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), fs.readFileSync(path.join(workspace, rel)), rel);
    assert.equal(res.headers.get("content-length"), String(fs.statSync(path.join(workspace, rel)).size), rel);
  }
});

test("GET /api/files/<path> answers 404 for a missing path, a directory, anything outside the workspace and a .. segment", async () => {
  const paths = [
    "",
    "nope.txt",
    "notes",
    "escape/secret.txt",
    "..%2Fstate%2Faccount.json",
    "notes%2F..%2F..%2Foutside%2Fsecret.txt",
    "%2Fetc%2Fpasswd",
    "notes/../../outside/secret.txt",
    "notes%2F%2e%2e%2F%2e%2e%2Foutside%2Fsecret.txt",
    ".git/config",
    "%00",
    "%E0%A4%A",
  ];
  for (const p of paths) {
    const res = await fetch(`${open}/api/files/${p}`, { headers: bearer(paired.token) });
    const body = await res.text();
    assert.equal(res.status, 404, p);
    assert.ok(ErrorResponseSchema.safeParse(JSON.parse(body)).success, p);
    assert.ok(!body.includes(SECRET), p);
  }
});

test("the run and file routes need a device token, and refuse other methods with 405", async () => {
  const routes = ["/api/runs", `/api/runs/${runId}`, "/api/files/notes/a.md"];
  for (const p of routes) {
    await assertApiError(await fetch(`${open}${p}`), 401, `${p} without a token`);
    await assertApiError(await fetch(`${guarded}${p}`), 403, `${p} on the tunnel without Access`);
    const wrong = await fetch(`${open}${p}`, { method: "POST", headers: bearer(paired.token), body: "{}" });
    assert.equal(wrong.status, 405, `POST ${p}`);
    assert.equal(wrong.headers.get("allow"), "GET", `POST ${p}`);
  }
  const ping = await fetch(`${open}/api/ping`, { method: "POST", headers: bearer(paired.token), body: "{}" });
  assert.equal(ping.headers.get("allow"), "GET", "POST /api/ping");
});

// --- /api/rules -------------------------------------------------------------

const rulesFile = path.join(workspace, "ALFRED.md");
const sha256 = (data: string | Buffer) => crypto.createHash("sha256").update(data).digest("hex");

/** GET /api/rules with the paired device's token, with ALFRED.md as `put` makes it; the file is gone again afterwards. */
async function getRules(put: () => void = () => {}, base = open): Promise<Response> {
  fs.rmSync(rulesFile, { force: true });
  put();
  try {
    return await fetch(`${base}/api/rules`, { headers: bearer(paired.token) });
  } finally {
    // A body that is still to be read is already in the response: the file is not needed for it.
    fs.rmSync(rulesFile, { force: true });
  }
}

test("GET /api/rules gives the root ALFRED.md's text as it is, the sha256 of its bytes and the size cap", async () => {
  const text = "  # 规则\r\n\n- 报告开头先写摘要 😀\n\n";
  const res = await getRules(() => fs.writeFileSync(rulesFile, text));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(RulesSchema.parse(await res.json()), { text, version: sha256(Buffer.from(text)), maxBytes: 8192 });
});

test("GET /api/rules reads a missing file and a symlink as empty text", async () => {
  const empty = { text: "", version: sha256(""), maxBytes: 8192 };
  const missing = await getRules();
  assert.equal(missing.status, 200);
  assert.deepEqual(RulesSchema.parse(await missing.json()), empty);

  const link = await getRules(() => fs.symlinkSync(path.join(workspace, "notes", "a.md"), rulesFile));
  assert.equal(link.status, 200);
  assert.deepEqual(RulesSchema.parse(await link.json()), empty, "the note the link points to is not shown");
});

test("GET /api/rules reads a file of 65536 bytes whole and answers 413 for a longer one", async () => {
  const exact = await getRules(() => fs.writeFileSync(rulesFile, "a".repeat(65_536)));
  assert.equal(exact.status, 200);
  assert.equal(RulesSchema.parse(await exact.json()).text.length, 65_536);

  await assertApiError(await getRules(() => fs.writeFileSync(rulesFile, "a".repeat(65_537))), 413, "over the read cap");
});

test("GET /api/rules needs a device token, and refuses other methods with 405", async () => {
  await assertApiError(await fetch(`${open}/api/rules`), 401, "without a token");
  await assertApiError(await fetch(`${guarded}/api/rules`), 403, "on the tunnel without Access");
  const wrong = await fetch(`${open}/api/rules`, { method: "POST", headers: bearer(paired.token), body: "{}" });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get("allow"), "GET");
  assert.equal(fs.existsSync(rulesFile), false, "a refused request writes nothing");
});

// --- /api/memories ----------------------------------------------------------

const memoryDir = path.join(workspace, "memory");

/** GET /api/memories with the paired device's token, with the memory files `put` writes; they are gone again afterwards. */
async function getMemories(put: (write: (file: string, text: string) => void) => void = () => {}): Promise<Response> {
  const written: string[] = [];
  put((file, text) => {
    fs.writeFileSync(path.join(memoryDir, file), text);
    written.push(file);
  });
  try {
    return await fetch(`${open}/api/memories`, { headers: bearer(paired.token) });
  } finally {
    for (const file of written) fs.rmSync(path.join(memoryDir, file), { force: true });
  }
}

const memoryText = (name: string, updated: string, type = "preference") => `---\nname: "${name}"\ndescription: "About ${name}."\ntype: ${type}\nupdated: ${updated}\n---\n\n${name} body.\n`;

test("GET /api/memories lists the memories most recently updated first, each with the sha256 of its file's bytes as its version", async () => {
  const bytes = new Map<string, string>();
  const res = await getMemories((write) => {
    for (const [file, name, updated, type] of [
      ["newer.md", "Newer", "2026-10-25", "project"],
      ["older.md", "Older", "2026-10-01", "correction"],
      ["memory-20261022-ab12.md", "住在上海", "2026-10-22", "user"],
    ] as const) {
      write(file, memoryText(name, updated, type));
      bytes.set(file, memoryText(name, updated, type));
    }
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "no-store");
  const list = MemoryListSchema.parse(await res.json());
  assert.deepEqual(list.memories.map((m) => m.file), ["newer.md", "memory-20261022-ab12.md", "m.md", "older.md"], "the one in the workspace for the /memory page is between them");
  assert.equal(list.promptCount, 4);
  const [newer, chinese] = list.memories;
  assert.deepEqual(newer, {
    file: "newer.md",
    name: "Newer",
    description: "About Newer.",
    kind: "project",
    updated: "2026-10-25",
    body: "Newer body.",
    version: sha256(bytes.get("newer.md") ?? ""),
  });
  assert.equal(chinese?.name, "住在上海");
  for (const m of list.memories) assert.equal(m.version, sha256(fs.existsSync(path.join(memoryDir, m.file)) ? fs.readFileSync(path.join(memoryDir, m.file)) : bytes.get(m.file) ?? ""), m.file);
});

test("GET /api/memories counts in promptCount the memories that fit the system prompt's index, and lists them all", async () => {
  const res = await getMemories((write) => {
    for (let i = 0; i < 205; i++) write(`bulk-${String(i).padStart(3, "0")}.md`, memoryText(`B${i}`, "2026-10-30"));
  });
  const list = MemoryListSchema.parse(await res.json());
  assert.equal(list.memories.length, 206);
  assert.equal(list.promptCount, 200, "the index holds at most 200 lines");
  assert.ok(list.memories.slice(0, 205).every((m) => m.file.startsWith("bulk-")), "the newest 205 come first");
});

test("GET /api/memories is an empty list when there is no memory folder", async () => {
  const away = `${memoryDir}-away`;
  fs.renameSync(memoryDir, away);
  try {
    const res = await fetch(`${open}/api/memories`, { headers: bearer(paired.token) });
    assert.equal(res.status, 200);
    assert.deepEqual(MemoryListSchema.parse(await res.json()), { memories: [], promptCount: 0 });
  } finally {
    fs.renameSync(away, memoryDir);
  }
});

test("GET /api/memories needs a device token, and refuses other methods with 405", async () => {
  await assertApiError(await fetch(`${open}/api/memories`), 401, "without a token");
  await assertApiError(await fetch(`${guarded}/api/memories`), 403, "on the tunnel without Access");
  const wrong = await fetch(`${open}/api/memories`, { method: "POST", headers: bearer(paired.token), body: "{}" });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get("allow"), "GET");
});

// --- /api/tasks -------------------------------------------------------------

type RunRecord = import("../runs.ts").RunRecord;

const TASK_ID = "p3r8vx";
const taskList = JSON.parse(fs.readFileSync(new URL("../../fixtures/api/responses/task-list.json", import.meta.url), "utf8")) as TaskList;
/** Two tasks of the fixture's task list, which the store would write as tasks.json. */
const twoTasks: TaskList = { timeZone: "Asia/Taipei", tasks: taskList.tasks.filter((task) => task.id === TASK_ID || task.id === "t5w2hf") };

/** A finished run of a task (none for a chat run), as runs.jsonl holds it. */
function taskRun(taskId: string | undefined, title: string, startedAt: number): RunRecord {
  const at = new Date(startedAt).toISOString();
  return { id: newRunId(), kind: "task", taskId, title, status: "done", startedAt: at, endedAt: at, costUsd: 0.1, toolCalls: 0, files: [] };
}

test("GET /api/tasks answers an empty list in the workbench's time zone when there is no tasks file", async () => {
  fs.rmSync(TASKS_FILE, { force: true });
  const res = await fetch(`${open}/api/tasks`, { headers: bearer(paired.token) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(TaskListSchema.parse(await res.json()), { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, tasks: [] });
});

test("GET /api/tasks gives the two tasks of the file, as a TaskList", async () => {
  fs.writeFileSync(TASKS_FILE, JSON.stringify(twoTasks));
  const res = await fetch(`${open}/api/tasks`, { headers: bearer(paired.token) });
  assert.equal(res.status, 200);
  assert.deepEqual(TaskListSchema.parse(await res.json()), twoTasks);
});

test("GET /api/tasks/<id> gives the task and its 50 newest runs of that task only, newest first", async () => {
  fs.writeFileSync(TASKS_FILE, JSON.stringify(twoTasks));
  const other = newRunId();
  for (let i = 0; i < 52; i++) appendRunLog(taskRun(TASK_ID, `run ${i}`, Date.UTC(2031, 0, 1, 0, i)));
  // Newer than all of the task's runs: they must not be listed.
  appendRunLog(taskRun(other, "another task's run", Date.UTC(2031, 1, 1)));
  appendRunLog(taskRun(undefined, "a chat run", Date.UTC(2031, 2, 1)));

  const res = await fetch(`${open}/api/tasks/${TASK_ID}`, { headers: bearer(paired.token) });
  assert.equal(res.status, 200);
  const detail = TaskDetailSchema.parse(await res.json());
  assert.deepEqual(detail.task, twoTasks.tasks.find((task) => task.id === TASK_ID));
  assert.equal(detail.runs.length, 50);
  assert.ok(detail.runs.every((run) => run.taskId === TASK_ID));
  assert.deepEqual(
    detail.runs.map((run) => run.title),
    Array.from({ length: 50 }, (_, i) => `run ${51 - i}`),
  );
});

test("GET /api/tasks/<id> answers 404 with its message for an unknown id and for a malformed one", async () => {
  fs.writeFileSync(TASKS_FILE, JSON.stringify(twoTasks));
  for (const id of ["zzzzzz", "ABCDEF", "abc", `${TASK_ID}0`, "p3r8v"]) {
    const res = await fetch(`${open}/api/tasks/${id}`, { headers: bearer(paired.token) });
    assert.equal(res.status, 404, id);
    assert.deepEqual(await res.json(), { error: "There is no such task." }, id);
  }
});

test("GET /api/tasks and GET /api/tasks/<id> need a device token, and refuse other methods with 405", async () => {
  for (const p of ["/api/tasks", `/api/tasks/${TASK_ID}`]) {
    await assertApiError(await fetch(`${open}${p}`), 401, `${p} without a token`);
    await assertApiError(await fetch(`${guarded}${p}`), 403, `${p} on the tunnel without Access`);
    const wrong = await fetch(`${open}${p}`, { method: "POST", headers: bearer(paired.token), body: "{}" });
    assert.equal(wrong.status, 405, `POST ${p}`);
    assert.equal(wrong.headers.get("allow"), "GET", `POST ${p}`);
  }
});

test("a tasks file that does not fit answers 500 on both routes, and the log names the file", async () => {
  const lines = mock.method(console, "error", () => {});
  try {
    for (const body of ["{ not json", JSON.stringify({ tasks: [] })]) {
      fs.writeFileSync(TASKS_FILE, body);
      await assertApiError(await fetch(`${open}/api/tasks`, { headers: bearer(paired.token) }), 500, `list: ${body}`);
      await assertApiError(await fetch(`${open}/api/tasks/${TASK_ID}`, { headers: bearer(paired.token) }), 500, `detail: ${body}`);
    }
  } finally {
    lines.mock.restore();
    fs.rmSync(TASKS_FILE, { force: true });
  }
  const logged = lines.mock.calls.map((call) => String(call.arguments[0]));
  assert.ok(logged.some((line) => line.includes(TASKS_FILE)), "the log names the file");
});

// --- /api/ideas -------------------------------------------------------------

const ideaList = JSON.parse(fs.readFileSync(new URL("../../fixtures/api/responses/idea-list.json", import.meta.url), "utf8")) as IdeaList;

test("GET /api/ideas answers an empty list when there is no ideas file", async () => {
  fs.rmSync(IDEAS_FILE, { force: true });
  const res = await fetch(`${open}/api/ideas`, { headers: bearer(paired.token) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(IdeaListSchema.parse(await res.json()), { ideas: [] });
});

test("GET /api/ideas gives the ideas of the file in every state, with the generation running, as the file holds them", async () => {
  fs.mkdirSync(path.dirname(IDEAS_FILE), { recursive: true });
  fs.writeFileSync(IDEAS_FILE, JSON.stringify(ideaList));
  const res = await fetch(`${open}/api/ideas`, { headers: bearer(paired.token) });
  assert.equal(res.status, 200);
  const body = IdeaListSchema.parse(await res.json());
  assert.deepEqual(body, ideaList);
  assert.deepEqual(new Set(body.ideas.map((idea) => idea.state)), new Set(["open", "accepted", "rejected", "archived"]));
  assert.equal(body.generatingRunId, "c9t5hq");
  fs.rmSync(IDEAS_FILE, { force: true });
});

test("GET /api/ideas gives the last generation the store wrote, a done one with its note and a failed one without", async () => {
  fs.mkdirSync(path.dirname(IDEAS_FILE), { recursive: true });
  try {
    for (const name of ["idea-list-nothing-new.json", "idea-list-failed.json"]) {
      const list = JSON.parse(fs.readFileSync(new URL(`../../fixtures/api/responses/${name}`, import.meta.url), "utf8")) as IdeaList;
      fs.writeFileSync(IDEAS_FILE, JSON.stringify(list));
      const res = await fetch(`${open}/api/ideas`, { headers: bearer(paired.token) });
      assert.equal(res.status, 200, name);
      assert.deepEqual(IdeaListSchema.parse(await res.json()), list, name);
      assert.ok(list.lastGeneration, name);
    }
  } finally {
    fs.rmSync(IDEAS_FILE, { force: true });
  }
});

test("GET /api/ideas needs a device token, and refuses other methods with 405", async () => {
  await assertApiError(await fetch(`${open}/api/ideas`), 401, "without a token");
  await assertApiError(await fetch(`${guarded}/api/ideas`), 403, "on the tunnel without Access");
  const wrong = await fetch(`${open}/api/ideas`, { method: "POST", headers: bearer(paired.token), body: "{}" });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get("allow"), "GET");
});

test("an ideas file that does not fit answers 500 on the route, and the log names the file", async () => {
  fs.mkdirSync(path.dirname(IDEAS_FILE), { recursive: true });
  const lines = mock.method(console, "error", () => {});
  try {
    for (const body of ["{ not json", JSON.stringify({ ideas: [{ id: "h3v8ct" }] })]) {
      fs.writeFileSync(IDEAS_FILE, body);
      await assertApiError(await fetch(`${open}/api/ideas`, { headers: bearer(paired.token) }), 500, `list: ${body}`);
    }
  } finally {
    lines.mock.restore();
    fs.rmSync(IDEAS_FILE, { force: true });
  }
  const logged = lines.mock.calls.map((call) => String(call.arguments[0]));
  assert.ok(logged.some((line) => line.includes(IDEAS_FILE)), "the log names the file");
});

// --- /api/settings -----------------------------------------------------------

const settingsMirror = JSON.parse(fs.readFileSync(new URL("../../fixtures/api/responses/settings-detail.json", import.meta.url), "utf8")).settings as Settings;

/** The mirror file the settings store writes, from the fixture's settings or `settings`. */
function writeMirror(settings: unknown = settingsMirror): void {
  fs.mkdirSync(path.dirname(SETTINGS_MIRROR_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_MIRROR_FILE, typeof settings === "string" ? settings : JSON.stringify(settings));
}

/** A finished run of `kind` that started `ago` ms ago and cost `costUsd`. */
function spendRun(kind: RunRecord["kind"], costUsd: number, ago = 0): RunRecord {
  const at = new Date(Date.now() - ago).toISOString();
  return { ...taskRun(undefined, `${kind} run`, Date.now() - ago), kind, costUsd, startedAt: at, endedAt: at };
}

async function settingsDetail(): Promise<{ settings: Settings; spentTodayUsd: number }> {
  const res = await fetch(`${open}/api/settings`, { headers: bearer(paired.token) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "no-store");
  return SettingsDetailSchema.parse(await res.json());
}

test("GET /api/settings gives the settings of the mirror as the store wrote them, with today's spend", async () => {
  writeMirror();
  const body = await settingsDetail();
  assert.deepEqual(body.settings, settingsMirror);
  assert.ok(body.spentTodayUsd >= 0);
  assert.equal(body.spentTodayUsd, Math.round(body.spentTodayUsd * 1e9) / 1e9, "a plain number of USD");
});

test("GET /api/settings follows the mirror: a rewritten file is the next answer, with values beyond the write ranges", async () => {
  writeMirror();
  const changed = { ...settingsMirror, dailyBudgetUsd: 150, ideasAt: "06:30", overridden: ["ideasAt"] };
  writeMirror(changed);
  assert.deepEqual((await settingsDetail()).settings, changed);
});

test("GET /api/settings counts the runs that started today in the owner's day, by the overview page's rule: subagents leave out", async () => {
  writeMirror();
  const before = (await settingsDetail()).spentTodayUsd;
  for (const run of [
    spendRun("task", 1.25),
    spendRun("scan", 0.5),
    spendRun("ideas", 0.25),
    spendRun("subagent", 7), // its cost is part of the run that started it
    spendRun("task", 3, 36 * 3_600_000), // yesterday, or the day before
  ]) {
    appendRunLog(run);
  }
  const after = (await settingsDetail()).spentTodayUsd;
  assert.equal(after - before, 2, "1.25 + 0.5 + 0.25");

  // The overview page shows the same sum.
  const page = await (await fetch(`${open}/`)).text();
  assert.ok(page.includes(`今天 $${after.toFixed(2)}`) || page.includes(`今天 $${after.toFixed(3)}`), page.match(/今天[^<]*/)?.[0]);
});

test("GET /api/settings needs a device token, and refuses other methods with 405", async () => {
  writeMirror();
  await assertApiError(await fetch(`${open}/api/settings`), 401, "without a token");
  await assertApiError(await fetch(`${guarded}/api/settings`), 403, "on the tunnel without Access");
  const wrong = await fetch(`${open}/api/settings`, { method: "POST", headers: bearer(paired.token), body: "{}" });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get("allow"), "GET");
});

test("GET /api/settings answers 503 with an error body when there is no mirror, or one that cannot be read or does not fit", async () => {
  const lines = mock.method(console, "error", () => {});
  try {
    fs.rmSync(SETTINGS_MIRROR_FILE, { force: true });
    await assertApiError(await fetch(`${open}/api/settings`, { headers: bearer(paired.token) }), 503, "missing");
    for (const body of ["{ not json", JSON.stringify({ model: "gpt" }), JSON.stringify({ ...settingsMirror, overridden: ["nope"] }), "[]"]) {
      writeMirror(body);
      await assertApiError(await fetch(`${open}/api/settings`, { headers: bearer(paired.token) }), 503, body);
    }
    fs.rmSync(SETTINGS_MIRROR_FILE, { force: true });
    fs.mkdirSync(SETTINGS_MIRROR_FILE); // a directory cannot be read as a file
    await assertApiError(await fetch(`${open}/api/settings`, { headers: bearer(paired.token) }), 503, "unreadable");
  } finally {
    lines.mock.restore();
    fs.rmSync(SETTINGS_MIRROR_FILE, { recursive: true, force: true });
  }
  const logged = lines.mock.calls.map((call) => String(call.arguments[0]));
  assert.ok(logged.some((line) => line.includes(SETTINGS_MIRROR_FILE)), "the log names the file");
});

// --- /api/documents and /api/files at a version -----------------------------

/** Writes `text` to the workspace file at `rel` and commits that file alone; resolves to the commit's id. */
async function commitFile(rel: string, text: string): Promise<string> {
  fs.mkdirSync(path.dirname(path.join(workspace, rel)), { recursive: true });
  fs.writeFileSync(path.join(workspace, rel), text);
  const commit = await history.commit(`Write ${rel}`, { paths: [rel] });
  assert.ok(commit, `${rel} has a change to commit`);
  return commit.version;
}

/** An empty documents file, and a store on it; the events go to a log of their own. */
function newDocumentStore(): InstanceType<typeof DocumentStore> {
  fs.mkdirSync(path.dirname(DOCUMENTS_FILE), { recursive: true });
  fs.rmSync(DOCUMENTS_FILE, { force: true });
  return new DocumentStore({ file: DOCUMENTS_FILE, events: new EventLog(path.join(tmp, "document-events.jsonl")) });
}

/** A finished revision run of a document that started at `startedAt` (ms), as runs.jsonl holds it. */
function revisionRun(documentId: string, title: string, startedAt: number): RunRecord {
  const at = new Date(startedAt).toISOString();
  return { id: newRunId(), kind: "revision", documentId, title, status: "done", startedAt: at, endedAt: at, costUsd: 0.1, toolCalls: 0, files: [] };
}

/** GET /api/files/<path><query> with the paired device's token. */
const getFile = (p: string, query = "") => fetch(`${open}/api/files/${p}${query}`, { headers: bearer(paired.token) });

test("GET /api/documents answers an empty list when there is no documents file", async () => {
  fs.rmSync(DOCUMENTS_FILE, { force: true });
  const res = await fetch(`${open}/api/documents`, { headers: bearer(paired.token) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(DocumentListSchema.parse(await res.json()), { documents: [] });
});

test("GET /api/documents lists the documents, most recently updated first", async () => {
  const store = newDocumentStore();
  const aFirst = await commitFile("docs/a.md", "# A\n\nfirst\n");
  const a = store.deliver({ path: "docs/a.md", version: aFirst, at: new Date("2031-03-01T00:00:00Z"), title: "A", kind: "markdown" });
  const bVersion = await commitFile("docs/b.md", "# B\n");
  const b = store.deliver({ path: "docs/b.md", version: bVersion, at: new Date("2031-03-02T00:00:00Z"), title: "B", kind: "markdown" });
  // A changes after B was delivered: it is the document updated last, though B was made last.
  const aSecond = await commitFile("docs/a.md", "# A\n\nsecond\n");
  store.recordVersion({ paths: ["docs/a.md"], version: aSecond, at: new Date("2031-03-03T00:00:00Z"), reason: "changed" });

  const res = await fetch(`${open}/api/documents`, { headers: bearer(paired.token) });
  assert.equal(res.status, 200);
  const list = DocumentListSchema.parse(await res.json());
  assert.deepEqual(list.documents.map((d) => d.id), [a.id, b.id]);
  assert.equal(list.documents[0]?.version, aSecond);
});

test("GET /api/documents leaves out a trashed document and GET /api/documents/<id> answers 404 for it, until it is restored", async () => {
  const store = newDocumentStore();
  const keepVersion = await commitFile("docs/keep.md", "# Keep\n");
  const keep = store.deliver({ path: "docs/keep.md", version: keepVersion, at: new Date("2031-05-01T00:00:00Z"), title: "Keep", kind: "markdown" });
  const goneVersion = await commitFile("docs/old-draft.md", "# Old draft\n");
  const gone = store.deliver({ path: "docs/old-draft.md", version: goneVersion, at: new Date("2031-05-02T00:00:00Z"), title: "Old draft", kind: "markdown" });
  const [note] = store.submit({
    documentId: gone.id,
    version: goneVersion,
    annotations: [{ target: { kind: "document" }, comment: "再核对" }],
    runId: newRunId(),
    at: new Date("2031-05-02T01:00:00Z"),
  });
  assert.ok(note);

  const ids = async () => DocumentListSchema.parse(await (await fetch(`${open}/api/documents`, { headers: bearer(paired.token) })).json()).documents.map((d) => d.id);
  const detail = (id: string) => fetch(`${open}/api/documents/${id}`, { headers: bearer(paired.token) });
  assert.deepEqual(await ids(), [gone.id, keep.id]);

  store.move("docs/old-draft.md", ".trash/old-draft.md", new Date("2031-05-03T00:00:00Z"));
  assert.deepEqual(await ids(), [keep.id], "the list leaves it out");
  const missing = await detail(gone.id);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "There is no such document." });
  assert.equal((await detail(keep.id)).status, 200, "the others are served");

  store.move(".trash/old-draft.md", "docs/old-draft.md", new Date("2031-05-04T00:00:00Z"));
  assert.deepEqual(await ids(), [gone.id, keep.id], "a restore brings it back");
  const back = DocumentDetailSchema.parse(await (await detail(gone.id)).json());
  assert.equal(back.document.id, gone.id);
  assert.deepEqual(back.versions.map((v) => v.version), [goneVersion]);
  assert.deepEqual(back.annotations.map((a) => a.id), [note.id]);
});

test("GET /api/documents/<id> answers 404 with its message for an unknown id and a malformed one", async () => {
  fs.rmSync(DOCUMENTS_FILE, { force: true });
  for (const id of ["zzzzzz", "ABCDEF", "abc", "k7m2qa0", "k7m2q", ""]) {
    const res = await fetch(`${open}/api/documents/${id}`, { headers: bearer(paired.token) });
    assert.equal(res.status, 404, id);
    assert.deepEqual(await res.json(), { error: "There is no such document." }, id);
  }
});

test("GET /api/documents/<id> gives the document, its versions, its annotations and its revision runs, and no other document's run", async () => {
  const store = newDocumentStore();
  const v1 = await commitFile("docs/plan.md", "# Plan\n\nfirst\n");
  const plan = store.deliver({ path: "docs/plan.md", version: v1, at: new Date("2031-04-01T00:00:00Z"), title: "Plan", kind: "markdown" });
  const otherVersion = await commitFile("docs/other.md", "# Other\n");
  const other = store.deliver({ path: "docs/other.md", version: otherVersion, at: new Date("2031-04-01T00:00:00Z"), title: "Other", kind: "markdown" });

  // The owner annotates the first version; a revision run answers it and makes the second version.
  const revision = new RunRecorder({ kind: "revision", title: "补充结论", documentId: plan.id, startedAt: "2031-04-02T00:00:00.000Z" });
  const [note] = store.submit({
    documentId: plan.id,
    version: v1,
    annotations: [{ target: { kind: "document" }, comment: "开头加一段结论" }],
    runId: revision.id,
    at: new Date("2031-04-02T00:00:00Z"),
  });
  assert.ok(note);
  store.reply(note.id, revision.id, "已在开头加上结论。", new Date("2031-04-02T00:10:00Z"));
  const v2 = await commitFile("docs/plan.md", "# Plan\n\nsecond\n");
  store.recordVersion({ paths: ["docs/plan.md"], version: v2, at: new Date("2031-04-02T00:10:00Z"), reason: "revised", runId: revision.id });
  revision.finish("done");

  const earlier = revisionRun(plan.id, "较早的修改", Date.parse("2031-04-01T12:00:00Z"));
  appendRunLog(earlier);
  const elsewhere = new RunRecorder({ kind: "revision", title: "另一份文档的修改", documentId: other.id, startedAt: "2031-04-03T00:00:00.000Z" });
  elsewhere.finish("done");

  const res = await fetch(`${open}/api/documents/${plan.id}`, { headers: bearer(paired.token) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  const detail = DocumentDetailSchema.parse(await res.json());
  assert.equal(detail.document.id, plan.id);
  assert.equal(detail.document.version, v2);
  assert.deepEqual(detail.versions.map((v) => [v.version, v.reason]), [[v2, "revised"], [v1, "delivered"]]);
  assert.equal(detail.versions[0]?.runId, revision.id);
  assert.deepEqual(detail.annotations.map((a) => [a.id, a.state, a.reply]), [[note.id, "resolved", "已在开头加上结论。"]]);
  assert.deepEqual(detail.runs.map((r) => r.id), [revision.id, earlier.id], "newest first, and the other document's run is left out");
  assert.equal(detail.runs[0]?.documentId, plan.id);
});

test("GET /api/documents/<id> lists at most 50 of its revision runs, newest first, and leaves out one that does not fit", async () => {
  const store = newDocumentStore();
  const version = await commitFile("docs/long.md", "# Long\n");
  const long = store.deliver({ path: "docs/long.md", version, at: new Date("2031-05-01T00:00:00Z"), title: "Long", kind: "markdown" });
  for (let i = 0; i < 52; i++) appendRunLog(revisionRun(long.id, `run ${i}`, Date.UTC(2031, 4, 2, 0, i)));
  // The newest of them, with a status the schema does not have: it is left out and logged.
  appendRunLog({ ...revisionRun(long.id, "不合格的记录", Date.UTC(2031, 4, 3)), status: "bogus" } as unknown as RunRecord);

  const lines = mock.method(console, "error", () => {});
  const res = await fetch(`${open}/api/documents/${long.id}`, { headers: bearer(paired.token) }).finally(() => lines.mock.restore());
  const detail = DocumentDetailSchema.parse(await res.json());
  assert.equal(detail.runs.length, 50);
  assert.deepEqual(detail.runs.map((r) => r.title), Array.from({ length: 50 }, (_, i) => `run ${51 - i}`));
  const logged = lines.mock.calls.map((call) => String(call.arguments[0]));
  assert.ok(logged.some((line) => line.includes(`left out 1 run record(s) of document ${long.id}`)), "the log says what was left out");
});

test("a documents file that does not fit answers 500 on both document routes, and the log names the file", async () => {
  fs.mkdirSync(path.dirname(DOCUMENTS_FILE), { recursive: true });
  const lines = mock.method(console, "error", () => {});
  try {
    for (const body of ["{ not json", JSON.stringify({ documents: [{ document: {}, versions: [] }], annotations: [] })]) {
      fs.writeFileSync(DOCUMENTS_FILE, body);
      await assertApiError(await fetch(`${open}/api/documents`, { headers: bearer(paired.token) }), 500, `list: ${body}`);
      await assertApiError(await fetch(`${open}/api/documents/k7m2qa`, { headers: bearer(paired.token) }), 500, `detail: ${body}`);
    }
  } finally {
    lines.mock.restore();
    fs.rmSync(DOCUMENTS_FILE, { force: true });
  }
  const logged = lines.mock.calls.map((call) => String(call.arguments[0]));
  assert.ok(logged.some((line) => line.includes(DOCUMENTS_FILE)), "the log names the file");
});

test("GET /api/files/<path>?version= gives a file as it was at that commit, while the live file stays as it is", async () => {
  const old = await commitFile("docs/essay.md", "# Essay\n\nold text\n");
  const current = await commitFile("docs/essay.md", "# Essay\n\nnew text\n");
  fs.writeFileSync(path.join(workspace, "docs", "essay.md"), "# Essay\n\ndraft\n"); // not committed
  const res = await getFile("docs/essay.md", `?version=${old}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(res.headers.get("content-security-policy"), "sandbox");
  assert.equal(res.headers.get("content-length"), String(Buffer.byteLength("# Essay\n\nold text\n")));
  assert.equal(await res.text(), "# Essay\n\nold text\n");
  assert.equal(await (await getFile("docs/essay.md", `?version=${current}`)).text(), "# Essay\n\nnew text\n");
  assert.equal(await (await getFile("docs/essay.md")).text(), "# Essay\n\ndraft\n", "without a version, the live file");
});

test("a file deleted since is still read at a version that had it", async () => {
  const had = await commitFile("docs/gone.md", "# Gone\n");
  fs.rmSync(path.join(workspace, "docs", "gone.md"));
  assert.ok(await history.commit("Delete docs/gone.md", { paths: ["docs/gone.md"] }));
  assert.equal(await (await getFile("docs/gone.md", `?version=${had}`)).text(), "# Gone\n");
  await assertApiError(await getFile("docs/gone.md"), 404, "the live file is gone");
});

test("an HTML file at a version has the workspace images inlined, from the live workspace", async () => {
  const old = await commitFile("docs/chart.html", '<p>old</p><img src="../images/p.png">');
  await commitFile("docs/chart.html", "<p>new</p>");
  const png = fs.readFileSync(path.join(workspace, "images", "p.png")).toString("base64");
  const res = await getFile("docs/chart.html", `?version=${old}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8", "HTML is never served as HTML");
  assert.equal(res.headers.get("content-security-policy"), "sandbox");
  const body = await res.text();
  assert.equal(body, `<p>old</p><img src="data:image/png;base64,${png}">`);
  assert.equal(res.headers.get("content-length"), String(Buffer.byteLength(body)));
});

test("an HTML file at a version over the preview cap is sent as it is", async () => {
  const big = '<img src="../images/p.png">' + "x".repeat(4 * MiB + 1);
  const version = await commitFile("docs/huge.html", big);
  fs.writeFileSync(path.join(workspace, "docs", "huge.html"), "<p>small</p>"); // the live file is small and not committed
  const res = await getFile("docs/huge.html", `?version=${version}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-length"), String(Buffer.byteLength(big)));
  assert.equal(await res.text(), big);
});

test("GET /api/files/<path>?version= answers 404 for a version that is not a commit of the history", async () => {
  const later = await commitFile("docs/later.md", "# Later\n");
  const gitOf = (spec: string) => execFileSync("git", ["--git-dir", VERSIONS_GIT_DIR, "rev-parse", spec], { encoding: "utf8" }).trim();
  const cases: [string, string][] = [
    ["a short id", later.slice(0, 39)],
    ["an upper-case id", later.toUpperCase()],
    ["a longer id", `${later}0`],
    ["an empty version", ""],
    ["an id of no commit", "0".repeat(40)],
    ["the id of a blob", gitOf(`${later}:docs/later.md`)],
    ["the id of a tree", gitOf(`${later}^{tree}`)],
  ];
  for (const [label, version] of cases) {
    await assertApiError(await getFile("docs/later.md", `?version=${version}`), 404, label);
  }
});

test("GET /api/files/<path>?version= answers 404 for a path that is not a file in that version", async () => {
  const earlier = await commitFile("docs/earlier.md", "# Earlier\n");
  const later = await commitFile("docs/made-after.md", "# Made after\n");
  await assertApiError(await getFile("docs/made-after.md", `?version=${earlier}`), 404, "a file made after the version");
  await assertApiError(await getFile("docs", `?version=${later}`), 404, "a directory");
  await assertApiError(await getFile("docs/made-after.md", `?version=${later}&version=${earlier}`), 404, "two versions");
});

test("with a version the path rules hold: a .. path, a link out, a .git path, NUL and a bad escape are 404, as without one", async () => {
  const version = await commitFile("docs/rules.md", "# Rules\n");
  const paths = [
    "docs%2F..%2F..%2Foutside%2Fsecret.txt",
    "docs%2F%2e%2e%2F..%2Foutside%2Fsecret.txt",
    "..%2Fstate%2Faccount.json",
    "escape%2Fsecret.txt",
    "%2Fetc%2Fpasswd",
    ".git%2Fconfig",
    "docs%2Frules.md%00",
    "%E0%A4%A",
  ];
  for (const p of paths) {
    for (const query of ["", `?version=${version}`]) {
      const res = await getFile(p, query);
      const body = await res.text();
      assert.equal(res.status, 404, `${p}${query}`);
      assert.ok(ErrorResponseSchema.safeParse(JSON.parse(body)).success, `${p}${query}`);
      assert.ok(!body.includes(SECRET), `${p}${query}`);
    }
  }
});

test("the document routes and a file at a version need a device token, and refuse other methods with 405", async () => {
  const routes = ["/api/documents", "/api/documents/k7m2qa", `/api/files/docs/plan.md?version=${"a".repeat(40)}`];
  for (const p of routes) {
    await assertApiError(await fetch(`${open}${p}`), 401, `${p} without a token`);
    await assertApiError(await fetch(`${guarded}${p}`), 403, `${p} on the tunnel without Access`);
    const wrong = await fetch(`${open}${p}`, { method: "POST", headers: bearer(paired.token), body: "{}" });
    assert.equal(wrong.status, 405, `POST ${p}`);
    assert.equal(wrong.headers.get("allow"), "GET", `POST ${p}`);
  }
});

// --- POST /api/push ---------------------------------------------------------

const registration = { token: "c".repeat(64), environment: "development" };
const pushOf = (id: string) => devices.list().find((d) => d.id === id)?.push;

test("POST /api/push stores the registration on the device, replacing an earlier one, and answers 204", async () => {
  const phone = devices.createDevice("push phone");
  const post = (body: unknown) => fetch(`${open}/api/push`, { method: "POST", headers: bearer(phone.token), body: JSON.stringify(body) });
  const res = await post(registration);
  assert.equal(res.status, 204);
  assert.equal(await res.text(), "");
  assert.deepEqual(pushOf(phone.id), registration);
  assert.equal((await post({ token: "d".repeat(64), environment: "production" })).status, 204);
  assert.deepEqual(pushOf(phone.id), { token: "d".repeat(64), environment: "production" });
  assert.equal((await fetch(`${open}/api/ping`, { headers: bearer(phone.token) })).status, 204, "the token still works");
});

test("POST /api/push answers 400 for a body that is not a registration, and stores nothing", async () => {
  const phone = devices.createDevice("bad push phone");
  const bodies = [
    "",
    "not json",
    "[]",
    JSON.stringify({ token: "C".repeat(64), environment: "development" }), // upper case is not APNs's hex
    JSON.stringify({ token: "ab", environment: "development" }),
    JSON.stringify({ token: "e".repeat(64), environment: "staging" }),
    JSON.stringify({ token: "e".repeat(64), environment: "development", extra: 1 }),
  ];
  for (const body of bodies) {
    await assertApiError(await fetch(`${open}/api/push`, { method: "POST", headers: bearer(phone.token), body }), 400, body || "empty body");
  }
  assert.equal(pushOf(phone.id), undefined);
});

test("POST /api/push needs a paired device, a revoked one is refused, and other methods get 405", async () => {
  const lost = devices.createDevice("lost push phone");
  devices.revokeDevice(lost.id);
  await assertApiError(await fetch(`${open}/api/push`, { method: "POST", body: JSON.stringify(registration) }), 401, "no token");
  await assertApiError(await fetch(`${guarded}/api/push`, { method: "POST", body: JSON.stringify(registration) }), 403, "no Access token");
  await assertApiError(await fetch(`${open}/api/push`, { method: "POST", headers: bearer(lost.token), body: JSON.stringify(registration) }), 401, "revoked");
  assert.equal(pushOf(lost.id), undefined);
  const get = await fetch(`${open}/api/push`, { headers: bearer(paired.token) });
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
});

test("POST /api/push refuses a body over 4096 bytes with 413", async () => {
  const phone = devices.createDevice("big push phone");
  const body = JSON.stringify({ ...registration, padding: "x".repeat(5000) });
  await assertApiError(await fetch(`${open}/api/push`, { method: "POST", headers: bearer(phone.token), body }), 413, "over the limit");
  assert.equal(pushOf(phone.id), undefined);
});

// --- what the workbench shows of a retired channel ---------------------------

test("the overview shows Alfred's heartbeat, and no poll or push window", async () => {
  const body = await (await fetch(`${open}/`)).text();
  assert.ok(body.includes("心跳"));
  assert.ok(body.includes("内存"));
  assert.ok(!body.includes("上次拉取") && !body.includes("推送窗口"));
});

test("a run from an earlier version, with failed sends on its record, loads in the pages and the API and shows nothing about them", async () => {
  const old = {
    id: "w8h5ne",
    kind: "task",
    title: "旧的报告",
    status: "done",
    startedAt: "2026-10-20T01:00:00.000Z",
    endedAt: "2026-10-20T01:05:00.000Z",
    costUsd: 0.1,
    toolCalls: 1,
    files: [{ path: "reports/r.html", tool: "Write" }],
    undelivered: [{ kind: "file", path: "reports/r.pdf", at: "2026-10-20T01:05:00.000Z", error: "sendMessage failed: ret=-2" }],
  };
  const runsDir = path.join(state, "workbench", "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(path.join(runsDir, `${old.id}.json`), JSON.stringify({ ...old, updatedAt: old.endedAt, steps: [] }));

  for (const page of [`/runs/${old.id}`, "/runs", "/"]) {
    const res = await fetch(`${open}${page}`);
    const body = await res.text();
    assert.equal(res.status, 200, page);
    assert.ok(!body.includes("未送达"), `${page} says something about failed sends`);
    if (page === `/runs/${old.id}`) assert.ok(body.includes("旧的报告") && body.includes("reports/r.html"), `${page} shows the old run and its file`);
  }
  const detail = RunDetailSchema.parse(await (await fetch(`${open}/api/runs/${old.id}`, { headers: bearer(paired.token) })).json());
  assert.equal(detail.run.title, "旧的报告");
  assert.ok(!("undelivered" in detail.run), "the client's view leaves it out");
});
