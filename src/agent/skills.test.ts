import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { parseMemory } from "./memory.ts";
import { BAKED_PLUGIN_DIR, prepareWorkspacePlugin, skillPlugins } from "./skills.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-skills-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Cap on a baked skill's body: it is loaded whole on every invocation and preload. */
const SKILL_BODY_MAX_BYTES = 16 * 1024;
const DESCRIPTION_MAX_CHARS = 300;

/** Every entry under `dir`, symlinks reported but not followed. */
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? [full, ...walk(full)] : [full];
  });
}

test("prepareWorkspacePlugin creates the manifest and the skills symlink once, and nothing else points into the workspace", () => {
  const workspace = path.join(tmp, "workspace");
  const pluginDir = path.join(tmp, "state", "workspace-plugin");
  fs.mkdirSync(path.join(workspace, "skills"), { recursive: true });

  prepareWorkspacePlugin(workspace, pluginDir);
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.name, "workspace");
  assert.equal(fs.readlinkSync(path.join(pluginDir, "skills")), path.join(workspace, "skills"));
  const links = walk(pluginDir).filter((p) => fs.lstatSync(p).isSymbolicLink());
  assert.deepEqual(links, [path.join(pluginDir, "skills")], "the skills symlink is the only link");
  for (const p of walk(pluginDir).filter((p) => fs.lstatSync(p).isFile())) {
    assert.ok(!fs.realpathSync(p).startsWith(workspace + path.sep), `${p} resolves into the workspace`);
  }

  const stamp = (p: string) => fs.lstatSync(p).mtimeMs;
  const before = [stamp(path.join(pluginDir, ".claude-plugin", "plugin.json")), stamp(path.join(pluginDir, "skills"))];
  prepareWorkspacePlugin(workspace, pluginDir);
  assert.deepEqual([stamp(path.join(pluginDir, ".claude-plugin", "plugin.json")), stamp(path.join(pluginDir, "skills"))], before);
});

test("prepareWorkspacePlugin repoints a stale symlink and refuses to replace a real directory", () => {
  const workspace = path.join(tmp, "ws2");
  const pluginDir = path.join(tmp, "plugin2");
  fs.mkdirSync(path.join(pluginDir), { recursive: true });
  fs.symlinkSync(path.join(tmp, "elsewhere"), path.join(pluginDir, "skills"));
  prepareWorkspacePlugin(workspace, pluginDir);
  assert.equal(fs.readlinkSync(path.join(pluginDir, "skills")), path.join(workspace, "skills"));

  const pluginDir3 = path.join(tmp, "plugin3");
  fs.mkdirSync(path.join(pluginDir3, "skills"), { recursive: true });
  assert.throws(() => prepareWorkspacePlugin(workspace, pluginDir3), /must be a symlink/);
  assert.ok(fs.statSync(path.join(pluginDir3, "skills")).isDirectory(), "the directory is left alone");
});

test("only the workspace plugin skips MCP discovery", () => {
  const [baked, workspace] = skillPlugins("/state/workspace-plugin");
  assert.deepEqual(baked, { type: "local", path: BAKED_PLUGIN_DIR });
  assert.deepEqual(workspace, { type: "local", path: "/state/workspace-plugin", skipMcpDiscovery: true });
});

test("every baked skill has a matching name, a short description and a body under the cap", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(BAKED_PLUGIN_DIR, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.name, "alfred");
  const dirs = fs.readdirSync(path.join(BAKED_PLUGIN_DIR, "skills"), { withFileTypes: true }).filter((e) => e.isDirectory());
  assert.ok(dirs.length >= 3);
  for (const dir of dirs) {
    const file = path.join(BAKED_PLUGIN_DIR, "skills", dir.name, "SKILL.md");
    const skill = parseMemory("SKILL.md", fs.readFileSync(file, "utf8"));
    assert.equal(skill.name, dir.name, `${dir.name}: name`);
    assert.ok(skill.description, `${dir.name}: description`);
    assert.ok(skill.description.length < DESCRIPTION_MAX_CHARS, `${dir.name}: description is ${skill.description.length} chars`);
    const bytes = Buffer.byteLength(skill.body);
    assert.ok(bytes < SKILL_BODY_MAX_BYTES, `${dir.name}: body is ${bytes} bytes`);
  }
});
