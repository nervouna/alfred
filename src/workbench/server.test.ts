import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, mock, test } from "node:test";

// store.ts reads these at import time, so set them before loading the modules under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-workbench-")));
const workspace = path.join(tmp, "workspace");
const state = path.join(tmp, "state");
process.env.ALFRED_WORKSPACE = workspace;
process.env.ALFRED_STATE_DIR = state;

const { RunRecorder, writeHeartbeat } = await import("../runs.ts");
const { ErrorResponseSchema, RunDetailSchema, RunListSchema } = await import("../api/schema.ts");
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
