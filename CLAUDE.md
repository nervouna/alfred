# Alfred

Developed with the `orchestrate` skill: issues are specs, implementers deliver one PR per issue, the orchestrator reviews and merges.

`README.md` is the reference for behaviour, configuration, state files and layout (see its Layout, State and files, and Development sections). Read the sections your change touches, and update them when behaviour or configuration changes.

## Build and test

- Node 24 runs the TypeScript directly; there is no build step. Imports carry the `.ts` extension.
- `npm run check` type-checks (`tsc --noEmit`, strict, `noUncheckedIndexedAccess`, `erasableSyntaxOnly`: no enums, no parameter properties, no namespaces).
- `npm test` runs `node --test` over `src/**/*.test.ts`. Tests use `node:test` and `node:assert/strict`. Modules that read `STATE_DIR` at import time are imported after the test sets `ALFRED_STATE_DIR` to a temp dir (see `src/runs.test.ts`).
- CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm run check` and `npm test` on every PR.
- `npm run smoke` and `node scripts/handler-smoke.ts <scenario>` call the real model and cost money. They need `ALFRED_ANTHROPIC_API_KEY`. Point `ALFRED_STATE_DIR` and `ALFRED_WORKSPACE` at scratch directories for them.
- Never run `npm start` against the deployed instance's state: a second Alfred on the same state dir would take over its command socket and run tasks on its sessions. Run locally with scratch `ALFRED_STATE_DIR` and `ALFRED_WORKSPACE` (see `scripts/app-dev.ts`).

## Architecture in brief

- The owner talks to Alfred only through the app. `src/cli.ts run` serves the command API (`src/api/server.ts`), and its messages go through one intake queue (`src/channels.ts`) into `src/agent/handler.ts`, the Agent SDK handler (sessions, live input, stop, background subagents, delivery). A reply is a `message.created` event, which on the app channel is its delivery. The WeChat channel is retired; its old messages stay in the event log, so the contract keeps `channel: "wechat"`.
- `src/events.ts` is the append-only event log (messages, run lifecycle) the client resumes from by id; `src/api/schema.ts` is the client contract, tested against `fixtures/api/` on both the Node and the Swift side; `src/api/server.ts` serves commands and the event stream on a local Unix socket.
- `src/runs.ts` records runs (one execution of the agent) under `$STATE_DIR/workbench/`; `src/workbench/` serves them read-only.
- The workbench's `/api/` is the app's way in: `devices.ts` pairs devices and keeps only the SHA-256 of each token, every `/api/` request needs a device token, and `forward.ts` passes only the command set (checked with `parseCommand`) and the event stream and uploads on to Alfred's socket.
- The workspace (`ALFRED_WORKSPACE`) is the only place the agent may read and write; `src/agent/guard.ts` enforces it per tool call.
- `ios/` (from #27) holds the native client.

## Rules

- No new dependencies unless the issue says so. Prefer `node:` built-ins and what is already in `package.json`.
- Reuse what the Agent SDK provides before writing Alfred code. Hard boundaries: the workspace boundary; nothing the agent can write becomes executable; instructions and memory change only on explicit request; only Alfred talks to the owner; spend caps.
- Match the surrounding code: naming, comment density, and English for code, comments, commits, PRs and docs.
- Commit messages and PR titles are plain imperative sentences ("Add …", "Keep …"), no type prefixes, no attribution lines.
- The repo is public. Never describe an exploit, a sandbox escape, or host details (server names, co-hosted services, secrets) in commits, PRs or issues.
- Deployment (`deploy/`, the `deploy` skill in `.claude/skills/`) is the orchestrator's job, not an implementer's.
