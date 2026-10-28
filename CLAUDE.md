# Alfred

Developed with the `orchestrate` skill: issues are specs, implementers deliver one PR per issue, the orchestrator reviews and merges.

`README.md` is the reference for behaviour, configuration, state files and layout (see its Layout, State and files, and Development sections). Read the sections your change touches, and update them when behaviour or configuration changes.

## Build and test

- Node 24 runs the TypeScript directly; there is no build step. Imports carry the `.ts` extension.
- `npm run check` type-checks (`tsc --noEmit`, strict, `noUncheckedIndexedAccess`, `erasableSyntaxOnly`: no enums, no parameter properties, no namespaces).
- `npm test` runs `node --test` over `src/**/*.test.ts`. Tests use `node:test` and `node:assert/strict`. Modules that read `STATE_DIR` at import time are imported after the test sets `ALFRED_STATE_DIR` to a temp dir (see `src/runs.test.ts`).
- To run some test files, pass quoted globs (`node --test "src/agent/*.test.ts" "src/tasks/*.test.ts"`): `node --test` does not take a directory.
- Tests with timers or a fake `runQuery` can pass alone and fail on a busy machine: before calling them stable, rerun them while `yes > /dev/null` runs on every core (`for i in $(seq $(sysctl -n hw.ncpu)); do yes > /dev/null & done`, killed afterwards).
- CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm run check` and `npm test` on every PR.
- `.github/workflows/ios.yml` runs AlfredKit's `swift test` and only builds the app; the app's unit and UI tests run locally (`ios/README.md`, Test). After an app change to a screen other tests pass through, run the whole `AlfredUITests` suite against `node scripts/app-dev.ts --seed-documents`.
- `npm run smoke` and `node scripts/handler-smoke.ts <scenario>` call the real model and cost money. They need `ALFRED_ANTHROPIC_API_KEY`. Point `ALFRED_STATE_DIR` and `ALFRED_WORKSPACE` at scratch directories for them.
- Never run `npm start` against the deployed instance's state: a second Alfred on the same state dir would take over its command socket and run tasks on its sessions. Run locally with scratch `ALFRED_STATE_DIR` and `ALFRED_WORKSPACE` (see `scripts/app-dev.ts`).
- To drive a local stack without the app, POST a command to its socket: `curl --unix-socket <state dir>/api/alfred.sock -H 'Content-Type: application/json' -d '<command>' http://alfred/commands` (shapes in the README's Command API).
- Run `app-dev`, `smoke` and `handler-smoke` with `CLAUDE_CODE_ENTRYPOINT` unset: a Claude Code session passes it down, and the API then refuses the key's requests.
- Run UI tests on a simulator that holds only the test build (`com.example.alfred`): a second Alfred build there adds a second share extension, and `ShareUITests` picks the wrong one. The share tests can fail on a new simulator's first run; rerun before blaming a change.
- `ChatUITests.testPairThenChat` can fail with no `/status` reply when it is the first test against a fresh `app-dev`; it passes on a rerun, so rerun before blaming a change.
- XCUITest calls a control hittable while it sits under the keyboard or in a sheet that is still resizing: tap once its frame holds still, as `tapWhenSettled` in `IdeasUITests` does.
- A row under the glass navigation bar or tab bar also counts as hittable, but the tap lands on the bar: scroll it between the bars first (`scrollBetweenBars` in `TasksUITests` and `IdeasUITests`).
- The server image holds only `src/`, `plugin/` and the npm packages, so a merge that changes only `ios/` needs no redeploy (`deploy/update.sh` reports nothing to restart).
- To time something on the real path from a phone, put temporary `print`s in a Release build (never commit them), install it, and run `xcrun devicectl device process launch --console --terminate-existing --device <name> io.damao.alfred`. A warm start is launching `com.apple.Preferences`, waiting, then launching Alfred again without `--terminate-existing`.
- If another `app-dev` holds port 8787, start yours with `--port <n>`; the pairing it prints carries the port.
- After `simctl install` of a differently built app, the notification prompt can block the chat until it is answered; pair through a short UI test (for example `ChatHeaderUITests/testTheMenuStillOffersUnpairing`), which answers it, before taking screenshots with `xcrun simctl io <udid> screenshot`.
- Check bar and edge-effect changes in the dark appearance (`xcrun simctl ui <udid> appearance dark`): the soft edge fade is invisible on white, and `XCUIDevice.shared.appearance` did not switch it in a UI test.
- A `safeAreaBar`'s scroll edge effect covers everything the bar draws, overflow included: draw content that hangs below a bar (the chat's avatar) as an overlay of the screen, not inside the bar.
- Judge flicker frame by frame, not by eye: record with `xcrun simctl io <udid> recordVideo --codec=h264 <file>` (stop it with SIGINT) and compare frames. An `AVPlayerLayer` with no frame draws nothing on the simulator but black on a phone, so layer transitions need a check on the phone.
- `devicectl` reporting the phone `unavailable` (CoreDevice error 4016 on install) means it is locked or off the network: ask the owner to unlock it, and keep the built `.app` so the install does not wait for another build.

## Architecture in brief

- The owner talks to Alfred only through the app. `src/cli.ts run` serves the command API (`src/api/server.ts`), and its messages go through one intake queue (`src/channels.ts`) into `src/agent/handler.ts`, the Agent SDK handler (sessions, live input, stop, background subagents, delivery). A reply is a `message.created` event, which on the app channel is its delivery. The WeChat channel is retired; its old messages stay in the event log, so the contract keeps `channel: "wechat"`.
- `src/events.ts` is the append-only event log (messages, run lifecycle) the client resumes from by id; `src/api/schema.ts` is the client contract, tested against `fixtures/api/` on both the Node and the Swift side; `src/api/server.ts` serves commands and the event stream on a local Unix socket.
- `src/runs.ts` records runs (one execution of the agent) under `$STATE_DIR/workbench/`; `src/workbench/` serves them read-only.
- Run kind `task` covers both a chat run and a scheduled task's run; only the latter has a `taskId`, so "the chat's run" means kind `task` with no `taskId` (#119). Owner-facing texts call a chat run 运行 and keep 任务 for scheduled tasks.
- `agentEnv()` (`src/agent/config.ts`) drops every inherited `CLAUDE*` and `ANTHROPIC_*` variable, so a Claude Code CLI setting meant for the agent (such as `ENABLE_PROMPT_CACHING_1H` or `CLAUDE_CODE_AUTO_COMPACT_WINDOW`) must be set there.
- The workbench's `/api/` is the app's way in: `devices.ts` pairs devices and keeps only the SHA-256 of each token, every `/api/` request needs a device token, and `forward.ts` passes only the command set (checked with `parseCommand`) and the event stream and uploads on to Alfred's socket.
- The workspace (`ALFRED_WORKSPACE`) is the only place the agent may read and write; `src/agent/guard.ts` enforces it per tool call.
- `src/documents/` keeps delivered files as documents: `versions.ts` commits the workspace to a git dir outside it (`$STATE_DIR/workbench/versions.git`), `store.ts` keeps `documents.json` (versions, annotations), and `commands.ts` runs revise and undo in one lane. The guard refuses any `.git` path segment.
- `ios/` (from #27) holds the native client.
- A streaming endpoint must write a byte right after its headers (the event stream sends `: ping` on open). Cloudflare holds response headers until the first body byte, and the app counts the stream as connected on the headers. A cold start resumes from event 0 and gets the backlog at once; a warm start has none, so without the opening ping it waited a whole heartbeat.

## Rules

- No new dependencies unless the issue says so. Prefer `node:` built-ins and what is already in `package.json`.
- Reuse what the Agent SDK provides before writing Alfred code. Hard boundaries: the workspace boundary; nothing the agent can write becomes executable; instructions and memory change only on explicit request; only Alfred talks to the owner; spend caps.
- Match the surrounding code: naming, comment density, and English for code, comments, commits, PRs and docs.
- Commit messages and PR titles are plain imperative sentences ("Add …", "Keep …"), no type prefixes, no attribution lines.
- The repo is public. Never describe an exploit, a sandbox escape, or host details (server names, co-hosted services, secrets) in commits, PRs or issues.
- Deployment (`deploy/`, the `deploy` skill in `.claude/skills/`) is the orchestrator's job, not an implementer's.
