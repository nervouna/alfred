// Where a bot lives in the workspace (#274): Alfred's home is the workspace root, every other bot's is bots/<id>/.

import fs from "node:fs";
import path from "node:path";

/** The top-level folder of the other bots' homes. Alfred's chat reads it and never writes it. */
export const BOTS_DIR = "bots";

/** The folders a bot's home holds, as the root holds the same ones for Alfred. */
const HOME_SUBDIRS = ["inbox", "reports", "notes"];

/** A bot's home, relative to the workspace and spelled with `/`. */
export function botHome(botId: string): string {
  return `${BOTS_DIR}/${botId}`;
}

/** Creates the bot's home and its folders when they are missing; returns whether the home was new. */
export function ensureBotHome(workspace: string, botId: string): boolean {
  const home = path.join(workspace, BOTS_DIR, botId);
  const created = !fs.existsSync(home);
  for (const dir of HOME_SUBDIRS) fs.mkdirSync(path.join(home, dir), { recursive: true });
  return created;
}
