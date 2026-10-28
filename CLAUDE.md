# Alfred

Developed with the `orchestrate` skill: issues are specs, implementers deliver one PR per issue, the orchestrator reviews and merges.

`README.md` is the entry point: how to run Alfred, the configuration and state tables, the layout. `docs/` holds the design notes by topic (`api`, `workbench`, `agent`, `subagents`, `tasks`, `documents`, `ideas`): decisions and invariants the code does not show. Behaviour that the code, its tests and `src/api/schema.ts` already state needs no doc. Read the doc for the area you touch, and update it only when a decision or an invariant changes. Work under `ios/` has its own `README.md` and `CLAUDE.md`.

## Build and test

- Node 24 runs the TypeScript directly; there is no build step. Imports carry the `.ts` extension.
- `npm run check` type-checks (`tsc --noEmit`); `erasableSyntaxOnly` means no enums, parameter properties or namespaces.
- `npm test` runs `node --test` over `src/**/*.test.ts`. Tests use `node:test` and `node:assert/strict`. Modules that read `STATE_DIR` at import time are imported after the test sets `ALFRED_STATE_DIR` to a temp dir (see `src/runs.test.ts`).
- To run some test files, pass quoted globs (`node --test "src/agent/*.test.ts" "src/tasks/*.test.ts"`): `node --test` does not take a directory.
- A fresh worktree has no `node_modules`: symlink the main checkout's (`ln -s <checkout>/node_modules node_modules`) to run `check` and `test`, and delete the link before committing, since `.gitignore` ignores only the directory.
- Tests with timers or a fake `runQuery` can pass alone and fail on a busy machine: before calling them stable, rerun them while `yes > /dev/null` runs on every core (`for i in $(seq $(sysctl -n hw.ncpu)); do yes > /dev/null & done`, killed afterwards).
- `npm run smoke` and `node scripts/handler-smoke.ts <scenario>` call the real model and cost money. They need `ALFRED_ANTHROPIC_API_KEY`. Point `ALFRED_STATE_DIR` and `ALFRED_WORKSPACE` at scratch directories for them.
- Never run `npm start` against the deployed instance's state: a second Alfred on the same state dir would take over its command socket and run tasks on its sessions. Run locally with scratch `ALFRED_STATE_DIR` and `ALFRED_WORKSPACE` (see `scripts/app-dev.ts`).
- To drive a local stack without the app, POST a command to its socket: `curl --unix-socket <state dir>/api/alfred.sock -H 'Content-Type: application/json' -d '<command>' http://alfred/commands` (shapes in the README's Command API).
- Run `app-dev`, `smoke` and `handler-smoke` with `CLAUDE_CODE_ENTRYPOINT` unset: a Claude Code session passes it down, and the API then refuses the key's requests.

## Architecture in brief

- The owner talks to Alfred only through the app. `src/cli.ts run` serves the command API (`src/api/server.ts`), and its messages go through one intake queue (`src/channels.ts`) into `src/agent/handler.ts`, the Agent SDK handler (sessions, live input, stop, background subagents, delivery). A reply is a `message.created` event, which on the app channel is its delivery. The WeChat channel is retired; its old messages stay in the event log, so the contract keeps `channel: "wechat"`.
- `src/events.ts` is the append-only event log (messages, run lifecycle) the client resumes from by id; `src/api/schema.ts` is the client contract, tested against `fixtures/api/` on both the Node and the Swift side; `src/api/server.ts` serves commands and the event stream on a local Unix socket.
- The app keeps its event cursor in memory, so every cold launch replays the whole log from event 0: change what an event kind means only if the events already logged still replay to the right state (a deletion was once logged as a `document.updated` under `.trash/`, which the catalog still reads as a removal).
- Run kind `task` covers both a chat run and a scheduled task's run; only the latter has a `taskId`, so "the chat's run" means kind `task` with no `taskId` (#119). Owner-facing texts call a chat run 运行 and keep 任务 for scheduled tasks.
- `agentEnv()` (`src/agent/config.ts`) drops every inherited `CLAUDE*` and `ANTHROPIC_*` variable, so a Claude Code CLI setting meant for the agent (such as `ENABLE_PROMPT_CACHING_1H` or `CLAUDE_CODE_AUTO_COMPACT_WINDOW`) must be set there.
- The workbench's `/api/` is the app's way in: `devices.ts` pairs devices and keeps only the SHA-256 of each token, every `/api/` request needs a device token, and `forward.ts` passes only the command set (checked with `parseCommand`) and the event stream and uploads on to Alfred's socket.
- The workspace (`ALFRED_WORKSPACE`) is the only place the agent may read and write; `src/agent/guard.ts` enforces it per tool call, and refuses any `.git` path segment.
- Delivered files are documents (`src/documents/`): `versions.ts` commits the workspace to a git dir outside it (`$STATE_DIR/workbench/versions.git`), and `commands.ts` runs revise and undo in one lane.
- A streaming endpoint must write a byte right after its headers (the event stream sends `: ping` on open). Cloudflare holds response headers until the first body byte, and the app counts the stream as connected on the headers. A cold start resumes from event 0 and gets the backlog at once; a warm start has none, so without the opening ping it waited a whole heartbeat.

## Rules

- No new dependencies unless the issue says so. Prefer `node:` built-ins and what is already in `package.json`.
- Reuse what the Agent SDK provides before writing Alfred code. Hard boundaries: the workspace boundary; nothing the agent can write becomes executable; instructions and memory change only on explicit request; only Alfred talks to the owner; spend caps.
- Match the surrounding code: naming, comment density, and English for code, comments, commits, PRs and docs.
- Commit messages and PR titles are plain imperative sentences ("Add …", "Keep …"), no type prefixes, no attribution lines.
- The repo is public. Never describe an exploit, a sandbox escape, or host details (server names, co-hosted services, secrets) in commits, PRs or issues.
- Deployment (`deploy/`, the `deploy` skill in `.claude/skills/`) is the orchestrator's job, not an implementer's.
- After a PR is merged, remove its implementer's worktree and local branch (`git worktree remove <path>`, after deleting any untracked logs in it, then `git branch -d <branch>` once your main has the merge); GitHub deletes the remote branch on merge. PRs merge with a merge commit (`gh pr merge --merge`): the repo has squash merging off. Touch only the ones of PRs you dispatched; other sessions' worktrees under `.claude/worktrees/` may be in use.
