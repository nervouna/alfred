# Alfred

Developed with the `orchestrate` skill: issues are specs, implementers deliver one PR per issue, the orchestrator reviews and merges.

`README.md` is the entry point (running, configuration, state, layout). Before touching an area, read its design note in `docs/`; update a note only when a decision or an invariant changes, never to restate the code, its tests or `src/api/schema.ts`. Work under `ios/` has its own `README.md` and `CLAUDE.md`.

## Build and test

- Node 24 runs the TypeScript directly, no build step; imports carry `.ts`. `npm run check` type-checks under `erasableSyntaxOnly` (no enums, parameter properties or namespaces); `npm test` runs every `src/**/*.test.ts`.
- To run some test files, pass quoted globs (`node --test "src/agent/*.test.ts"`): `node --test` does not take a directory. Modules that read `STATE_DIR` at import are imported after the test sets `ALFRED_STATE_DIR` (see `src/runs.test.ts`).
- A worktree may lack `node_modules`: look first (`ls -d node_modules`), since an app-made one can hold a real one and `ln -s` would link inside it. Otherwise symlink the main checkout's, and delete the link before committing (`.gitignore` ignores only the directory).
- Tests with timers or a fake `runQuery` can pass alone and fail on a busy machine: before calling them stable, rerun them with `yes > /dev/null` on every core (`for i in $(seq $(sysctl -n hw.ncpu)); do yes > /dev/null & done`, killed afterwards). Not during a UI test: with every core loaded one sent two messages in 500 s; use a few `nice -n 10 yes`, or none.
- Never run Alfred (`npm start`, `app-dev`, `smoke`, `handler-smoke`) on the deployed instance's state or workspace: point `ALFRED_STATE_DIR` and `ALFRED_WORKSPACE` at scratch dirs, and unset `CLAUDE_CODE_ENTRYPOINT`, which a Claude Code session passes down and which makes the API refuse the key.
- To drive a local stack without the app: `curl --unix-socket <state dir>/api/alfred.sock -H 'Content-Type: application/json' -d '<command>' http://alfred/commands`.

## Invariants

- Every cold launch of the app replays the event log from event 0: change what an event kind means only if the events already logged still replay to the right state.
- A chat run is kind `task` with no `taskId`; owner-facing texts call it 运行 and keep 任务 for scheduled tasks.
- A setting's value is read through its accessor at each use: a value cached at startup ignores the owner's override.

## Rules

- No new dependencies unless the issue says so; prefer `node:` built-ins and what `package.json` has. Reuse what the Agent SDK provides before writing Alfred code.
- Hard boundaries: the workspace (`src/agent/guard.ts`); nothing the agent can write becomes executable; instructions and memory change only on explicit request; only Alfred talks to the owner; spend caps.
- Commit messages and PR titles are plain imperative sentences ("Add …"), no type prefixes.
- The repo is public: never describe an exploit, a sandbox escape, or host details in commits, PRs or issues.
- Deployment (the `deploy` skill) is the orchestrator's, not an implementer's. PRs merge with `gh pr merge --merge` (squash is off) once `check`, `alfredkit` and `app` pass: no check is required, so auto-merge cannot be set while they run; afterwards remove that PR's worktree and local branch, and only those of PRs you dispatched.
