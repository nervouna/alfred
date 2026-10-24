// Skills reach the agent through two local plugins, loaded the way the Agent
// SDK ships them (no loader of Alfred's own):
// - `alfred`, the baked skills: plugin/ in the repo, copied into the image and
//   changed through a PR like code.
// - `workspace`, the owner's skills: skills/ in the workspace. Its plugin root
//   lies outside the workspace and holds only a manifest and a `skills` symlink,
//   so the agent can add skills but never hooks, MCP servers or agent types.

import fs from "node:fs";
import path from "node:path";

import type { SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";

import { STATE_DIR } from "../store.ts";

export const BAKED_PLUGIN_DIR = path.resolve(import.meta.dirname, "../../plugin");
export const WORKSPACE_PLUGIN_DIR = path.join(STATE_DIR, "workspace-plugin");
/** The workspace directory the owner's skills live in. */
export const SKILLS_DIR = "skills";

const WORKSPACE_MANIFEST = `${JSON.stringify(
  { name: "workspace", description: "The owner's skills, kept in skills/ in Alfred's workspace." },
  null,
  2,
)}\n`;

/**
 * Create the workspace plugin's root: its manifest and the `skills` symlink to
 * `<workspace>/skills`. Running it again changes nothing. A `skills` entry that
 * is not a symlink fails startup rather than being deleted.
 */
export function prepareWorkspacePlugin(workspace: string, pluginDir = WORKSPACE_PLUGIN_DIR): void {
  const manifestFile = path.join(pluginDir, ".claude-plugin", "plugin.json");
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  let manifest: string | undefined;
  try {
    manifest = fs.readFileSync(manifestFile, "utf8");
  } catch {
    // Absent: written below.
  }
  if (manifest !== WORKSPACE_MANIFEST) fs.writeFileSync(manifestFile, WORKSPACE_MANIFEST);

  const link = path.join(pluginDir, SKILLS_DIR);
  const target = path.join(workspace, SKILLS_DIR);
  const stat = fs.lstatSync(link, { throwIfNoEntry: false });
  if (stat && !stat.isSymbolicLink()) throw new Error(`${link} must be a symlink to ${target}`);
  if (stat && fs.readlinkSync(link) === target) return;
  if (stat) fs.unlinkSync(link);
  fs.symlinkSync(target, link);
}

/** The SDK's `plugins` option: baked skills, then the owner's, whose plugin never reads MCP servers. */
export function skillPlugins(pluginDir = WORKSPACE_PLUGIN_DIR): SdkPluginConfig[] {
  return [
    { type: "local", path: BAKED_PLUGIN_DIR },
    { type: "local", path: pluginDir, skipMcpDiscovery: true },
  ];
}
