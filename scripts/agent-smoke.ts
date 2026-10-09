// Runs one prompt through the production agent options without WeChat.
// usage: node scripts/agent-smoke.ts [--model sonnet|opus|haiku] [--resume <session>]
//          [--steer-after <seconds> <follow-up>] <prompt>
// The prompt goes through the same streaming input as in production; --steer-after
// pushes a follow-up into it mid-run, the way a WeChat message sent during a task does.
// The alfred tools are wired to a stub, so send_file fails instead of messaging anyone.

import { query } from "@anthropic-ai/claude-agent-sdk";

import { agentOptions } from "../src/agent/handler.ts";
import { DEFAULT_MODEL, isModelKey } from "../src/agent/config.ts";
import { TaskInput, answeredBy } from "../src/agent/input.ts";
import type { BotContext } from "../src/bot.ts";

const USAGE = "usage: node scripts/agent-smoke.ts [--model m] [--resume id] [--steer-after seconds text] <prompt>";

const args = process.argv.slice(2);
let model = DEFAULT_MODEL;
let resume: string | undefined;
let steer: { afterMs: number; text: string } | undefined;
const words: string[] = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i] ?? "";
  if (arg === "--model" && isModelKey(args[i + 1] ?? "")) model = args[++i] as typeof model;
  else if (arg === "--resume") resume = args[++i];
  else if (arg === "--steer-after") {
    const seconds = Number(args[++i]);
    const text = args[++i];
    if (!(seconds >= 0) || !text) throw new Error(USAGE);
    steer = { afterMs: seconds * 1000, text };
  } else words.push(arg);
}
const prompt = words.join(" ");
if (!prompt) throw new Error(USAGE);

const stub = new Proxy({}, { get: () => { throw new Error("WeChat is not available in the smoke test"); } });
const ctx = stub as BotContext;

const startedAt = Date.now();
const elapsed = () => `+${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
const input = new TaskInput(prompt);
const steerTimer = steer && setTimeout(() => {
  if (input.push(steer.text)) console.log(`[steer] ${elapsed()} pushed: ${steer.text}`);
  else console.log(`[steer] ${elapsed()} not pushed: the task already finished`);
}, steer.afterMs);

let results = 0;
try {
  for await (const m of query({ prompt: input, options: agentOptions({ ctx, userId: "smoke", model, resume }) })) {
    if (m.type === "system" && m.subtype === "init") {
      if (results === 0) console.log(`[init] ${elapsed()} session=${m.session_id} model=${m.model} tools=${m.tools.join(",")}`);
    } else if (m.type === "assistant") {
      for (const block of m.message.content) {
        if (block.type === "tool_use") console.log(`[tool] ${elapsed()} ${block.name} ${JSON.stringify(block.input).slice(0, 160)}`);
      }
    } else if (m.type === "result") {
      results++;
      const answered = answeredBy(m).length;
      input.settle(answeredBy(m));
      console.log(
        `[result] ${elapsed()} subtype=${m.subtype} turns=${m.num_turns} cost=$${m.total_cost_usd.toFixed(4)} ` +
          `answered=${answered} pending=${input.pending} denials=${m.permission_denials.length}`,
      );
      if (m.subtype === "success") console.log(m.result);
      else console.log(m.errors.join("\n"));
    }
  }
} catch (err) {
  // After an error result the CLI exits non-zero once its input closes; the handler treats that as done too.
  if (!(results > 0 && input.pending === 0)) throw err;
} finally {
  clearTimeout(steerTimer);
  input.close();
}
