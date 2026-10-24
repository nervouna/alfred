import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// store.ts reads these at import time, so set them before loading the modules under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-workbench-")));
const workspace = path.join(tmp, "workspace");
const state = path.join(tmp, "state");
process.env.ALFRED_WORKSPACE = workspace;
process.env.ALFRED_STATE_DIR = state;

const { RunRecorder, writeHeartbeat } = await import("../runs.ts");
const { AccessVerifier } = await import("./access.ts");
const { REPORT_CSP, createHandler, inlineImages } = await import("./server.ts");

const SECRET = "SECRET-TOKEN-0123456789";
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const access = new AccessVerifier(
  { teamDomain: "team.cloudflareaccess.com", aud: "aud", ownerEmail: "owner@example.com" },
  { fetcher: async () => ({ keys: [{ ...publicKey.export({ format: "jwk" }), kty: "RSA", kid: "k" }] }) },
);

function jwt(): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "RS256", kid: "k" });
  const body = enc({ aud: ["aud"], iss: "https://team.cloudflareaccess.com", email: "owner@example.com", exp: Date.now() / 1000 + 600 });
  return `${head}.${body}.${crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
}

const servers: http.Server[] = [];
let open = ""; // no Access check, as on the Unix socket
let guarded = ""; // Access required, as on the tunnel's TCP listener
let runId = "";

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

  open = await serve(createHandler({ workspace }));
  guarded = await serve(createHandler({ workspace, access }));
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
