# Alfred

Developed with the `orchestrate` skill: issues are specs, implementers deliver one PR per issue, the orchestrator reviews and merges.

`README.md` is the reference for behaviour, configuration, state files and layout (see its Layout, State and files, and Development sections). Read the sections your change touches, and update them when behaviour or configuration changes.

## Build and test

- Node 24 runs the TypeScript directly; there is no build step. Imports carry the `.ts` extension.
- `npm run check` type-checks (`tsc --noEmit`, strict, `noUncheckedIndexedAccess`, `erasableSyntaxOnly`: no enums, no parameter properties, no namespaces).
- `npm test` runs `node --test` over `src/**/*.test.ts`. Tests use `node:test` and `node:assert/strict`. Modules that read `STATE_DIR` at import time are imported after the test sets `ALFRED_STATE_DIR` to a temp dir (see `src/runs.test.ts`).
- CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm run check` and `npm test` on every PR.
- `npm run smoke` and `node scripts/handler-smoke.ts <scenario>` call the real model and cost money. They need `ALFRED_ANTHROPIC_API_KEY`. Point `ALFRED_STATE_DIR` and `ALFRED_WORKSPACE` at scratch directories for them.
- Never run `npm start` (the WeChat bot): only the deployed instance may long-poll the bot account.

## Architecture in brief

- The owner talks to Alfred over channels (`src/channels.ts`): WeChat (`src/channels/wechat.ts`, fed by `src/bot.ts`'s long-poll loop) and the app. Both go through one intake queue into `src/agent/handler.ts`, the Agent SDK handler (sessions, live input, stop, background subagents, delivery); a reply goes back to the channel its message came from.
- `src/events.ts` is the append-only event log (messages, run lifecycle) the client resumes from by id; `src/api/schema.ts` is the client contract, tested against `fixtures/api/` on both the Node and the Swift side; `src/api/server.ts` serves commands and the event stream on a local Unix socket.
- `src/runs.ts` records runs (one execution of the agent) under `$STATE_DIR/workbench/`; `src/workbench/` serves them read-only.
- The workspace (`ALFRED_WORKSPACE`) is the only place the agent may read and write; `src/agent/guard.ts` enforces it per tool call.
- `ios/` (from #27) holds the native client.

## Rules

- No new dependencies unless the issue says so. Prefer `node:` built-ins and what is already in `package.json`.
- Reuse what the Agent SDK provides before writing Alfred code. Hard boundaries: the workspace boundary; nothing the agent can write becomes executable; instructions and memory change only on explicit request; only Alfred talks to the owner; spend caps.
- Match the surrounding code: naming, comment density, and English for code, comments, commits, PRs and docs.
- Commit messages and PR titles are plain imperative sentences ("Add …", "Keep …"), no type prefixes, no attribution lines.
- The repo is public. Never describe an exploit, a sandbox escape, or host details (server names, co-hosted services, secrets) in commits, PRs or issues.
- Deployment (`deploy/`, the `deploy` skill in `.claude/skills/`) is the orchestrator's job, not an implementer's.
