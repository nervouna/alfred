import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { BotContext } from "../bot.ts";

// store.ts reads these at import time, so set them before loading the modules under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-options-")));
process.env.ALFRED_WORKSPACE = path.join(tmp, "workspace");
process.env.ALFRED_STATE_DIR = path.join(tmp, "state");
process.env.ALFRED_ANTHROPIC_API_KEY = "sk-test";
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { agentOptions, prepareWorkspace } = await import("./handler.ts");
const { extractionOptions } = await import("./memory-scan.ts");

test("tasks and memory scans turn Claude Code's own auto memory off", () => {
  prepareWorkspace();
  const ctx = {} as BotContext;
  const runs = {
    task: agentOptions({ ctx, userId: "owner", model: "sonnet" }),
    scan: extractionOptions(0.1, new AbortController()),
  };
  for (const [kind, options] of Object.entries(runs)) {
    assert.deepEqual(options.settingSources, [], kind);
    assert.deepEqual(options.settings, { autoMemoryEnabled: false }, kind);
  }
});
