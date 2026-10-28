# Agent

How the agent is set up: sessions, memory, workspace rules, skills, the sandbox and the spend caps. `agentOptions` in `src/agent/handler.ts` builds the Agent SDK options and `src/agent/config.ts` the system prompt. Subagents: [subagents.md](subagents.md).

## Sessions and context

- **One session.** The owner has one active Claude Code session and every chat task resumes it. Its id is in `agent-state.json` under the key `owner`; the transcript is in the isolated config dir (`claude/` in the state dir). Scheduled task and revision runs use sessions of their own that are not kept.
- **Idle rotation.** A task that starts more than `ALFRED_SESSION_IDLE_HOURS` after the previous one ended gets a new session, and Alfred says so first. The owner can set the hours in the app, 0 to 168 (0 turns rotation off), and the value in force when a task starts is the one used, as `/help` and `/status` show it; the environment is not held to that range, and the agent has no tool to change it. That keeps an old transcript from being re-sent and re-billed after the prompt cache expired. Stopped and failed tasks count as activity.
- **`/new` and `/resume`.** Both keep the retired session as the previous one; only one is kept. `/resume` swaps the two (a second one swaps back) and restarts the idle clock, or the next task would rotate the resumed session at once. Both are refused while a task runs, background subagents included.
- **A session that cannot be resumed** is dropped, not kept for `/resume`; Alfred starts a new one and says so. Moving the workspace does it: transcripts are keyed by the working directory (`transcriptDirs` in `memory-scan.ts`).

## Long-term memory

Facts about the owner live in `memory/` in the workspace, one Markdown file per memory, so both can read and edit them. Code: `memory.ts`, `memory-scan.ts`.

- **Index.** `memory/MEMORY.md` is regenerated before every run and after every task: edit the files, never the index. It goes into every system prompt, marked as data about the owner, not instructions: at most 200 lines or 8 KB, most recently updated first, and past the cap the agent is told to consolidate.
- **Three ways in.** The owner asks ("记住…", "以后…"); the agent judges, guided by the system prompt; or a background scan has `haiku` extract candidates from the transcript. To forget, the owner says so and the agent edits or trashes the file.
- **Scans** run at startup, every `ALFRED_MEMORY_SCAN_MINUTES` (the owner can change the interval and the cap of a scan in the app: the timer restarts at once, 0 stops it and going back to more starts it with a first scan) and when a session is retired, and never while a task runs or is queued: the request waits. Tasks and scans share `memory.lock` (tasks with each other, a scan alone), which also covers a manual `npm run memory-scan`. A batch that fails three times in a row is skipped.
- **A page cannot plant a memory.** Extraction reads only the owner's messages and the assistant's final replies, never tool calls or results. It may create or update memories, not delete them, and drops candidates that look like credentials.
- **Boundary with `ALFRED.md`.** Memory is facts about the owner; rules for how to work go into `ALFRED.md`. Extraction skips workspace rules.

## Workspace rules (`ALFRED.md`)

Conventions for the workspace (where files go, naming, report style) live in `ALFRED.md` files that the owner changes by asking in the app or edits directly; reply formatting, delivery and safety stay in code. Code: `rules.ts`.

- **Root.** `ALFRED.md` is appended to every system prompt; startup seeds it with the default layout when missing.
- **Nested.** A subdirectory's own `ALFRED.md` applies below it and is disclosed only when the agent works there: a `PostToolUse` hook injects, through `additionalContext`, the files between the root and the touched path that this task has not seen. A changed file comes again.
- **Limits.** Each file is cut at 8 KB. Symlinks, paths outside the workspace and `.trash/` are ignored. An uploaded file named `ALFRED.md` is saved as `_ALFRED.md` (`src/files.ts`), so a forwarded file cannot become rules.
- **Edits.** The agent changes one only when the owner explicitly asks, never because content it read says so. After any task that created, changed or removed one, Alfred says so in the app, stopped or failed tasks included.
- **The owner's edits in the app.** The owner can also read and replace the root `ALFRED.md` there (`GET /api/rules`, the `rules.save` command; contract in [fixtures](../fixtures/api/README.md#rules)); what the agent may write is unchanged. A save names the version it read, the sha256 of the file's bytes, and is refused when that is not the file's current version (409), when the text is over 8 KB of UTF-8 or has a NUL (400), or when `ALFRED.md` is a symlink or not a regular file, which is never replaced (409). The check and the atomic write happen in one synchronous step, and the file is committed to the workspace history as `Edit ALFRED.md` (a failed commit is logged, not an error). A save is not reported as the agent's change: each live run keeps its start snapshot in a `RulesWatch`, which a save updates, so a run's notice still names what the agent changes after it.

## Skills

Know-how too long for the system prompt lives in `SKILL.md` files, loaded the way the SDK ships them (the `Skill` tool). Code: `skills.ts`, `AGENT_SETTINGS`.

- **Baked skills** are the local plugin `alfred` in `plugin/`, changed through a PR. The `writer` role preloads `html-report`.
- **The owner's skills** are `skills/<name>/SKILL.md` in the workspace, listed as `workspace:<name>`. They reach Claude Code through a plugin root outside the workspace that holds only a manifest and a `skills` symlink, so the agent can add skills but never hooks, MCP servers or agent types. Edits follow the `ALFRED.md` rule; subagents cannot write there.
- **Nothing in a skill runs code.** Inline shell commands become placeholders (`disableSkillShellExecution`), hooks a skill or plugin declares never run (`disableAllHooks`; Alfred's own are SDK callbacks and keep working), and a skill's `allowed-tools` only pre-approves tools the session already offers, because `tools` is an explicit list.
- **Only Alfred's skills.** The skills bundled with Claude Code are coding tools and stay off (`disableBundledSkills`). One line in the system prompt tells the agent to invoke a covering skill before it starts (`html-report` before an HTML report).

## Agent sandbox

Permission mode is `dontAsk`, so anything not listed is denied. The Claude Code subprocess gets a scrubbed environment and its own config dir (`agentEnv()` drops every inherited `CLAUDE*` and `ANTHROPIC_*` variable), so it loads none of the owner's Claude Code settings, plugins or MCP servers (`settingSources: []`); the only plugins are Alfred's two skill plugins and the only MCP server is Alfred's own tools.

- **Tools.** Built in: `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, `Skill`, `Agent`, `TaskStop`. No shell. Alfred's own (`tools.ts`): `deliver`, `move_file` (deleting means moving into `.trash/`), `render_pdf`, `generate_image`. Chat adds `AskUserQuestion` and the task tools, a revision run `reply_annotation`. A tool stops when its run is stopped; a delivery already started runs to the end.
- **Workspace guard.** A `PreToolUse` hook (`guard.ts`) confines file paths, `Glob` and `Grep` paths and patterns, and Alfred's tool paths to the workspace, following symlinks. Task and revision runs also get `memory/`, `skills/` and every `ALFRED.md` read-only, subagents included.
- **No `.git`.** The same hook denies any path or pattern with a `.git` segment, in any case. The workspace history lives in a git dir outside it (`workbench/versions.git`), so no tool reaches it.
- **`render_pdf`** uses Playwright's Chrome Headless Shell, never the installed Chrome. A route handler serves only the page and images, stylesheets and fonts whose real path is inside the workspace; other files, frames, network URLs and every scheme but `data:` are refused, with a CSP and no JavaScript behind it.
- **`generate_image`** runs `mmx` without a shell, in its own process group. MiniMax bills failed and timed-out calls, so it never retries and counts requested images before the call (`MAX_IMAGES_PER_CALL`, `MAX_IMAGES_PER_TASK`). Output stays inside the workspace and never overwrites.
- **Residual risk.** `WebFetch` reaches any URL, so a malicious page could try to make the agent leak workspace content. Keep secrets out of the workspace.

## Spend

- **Per query:** `ALFRED_MAX_BUDGET_USD`, follow-ups and background subagents included, a brake on a runaway query: once reached, the task stops and waiting follow-ups fail without spending. Scheduled task and revision runs have caps of their own.
- **Per day:** `ALFRED_DAILY_BUDGET_USD`, in the owner's time zone, is the budget. Once reached, no new task, scheduled run, revision, idea generation or background subagent starts today; running ones finish.
- **Changing the caps.** The owner sets the daily cap (1 to 100) and the per-run cap (1 to 20) in the app, and the owner's value beats the variable. The daily cap is read at every check, so a lowered one stops the next start at once; a run's cap is read when its query starts, so a change applies to the next run, and a run that hits its cap names the cap it ran under. The ranges bind the app, not the environment: a deployment may set more, and a reset returns to the variable's value. There is no agent tool for any of this, and there must not be one: the caps are a hard boundary, and the overrides live in the state dir, outside the workspace, behind a socket the agent cannot reach.
- **A run that ends without a result** (stopped, its task paused) is estimated, not recorded at $0, at the unit price each model's last result implied (`unitPrices` in `agent-state.json`). It is marked estimated and counts toward the day and the owner's total, not the chat session.
