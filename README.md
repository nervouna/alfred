# Alfred

A personal research assistant on WeChat: web research, material collection and file organization, driven by the Claude Agent SDK and reached through the WeChat iLink bot protocol. All traffic is outbound HTTPS. Messages arrive by long-polling, so no inbound port is needed.

## Requirements

- Node.js 24+ (runs TypeScript directly, no build step)
- WeChat with the ClawBot plugin enabled
- `CF_ID` and `CF_SECRET` in the environment for the ristretto LLM gateway; the agent never uses a direct provider key

## Usage

```bash
npm install
npm run setup:pdf  # one-time: download Chrome Headless Shell (~99 MB) for PDF rendering
npm run login   # scan the QR code with WeChat; the scanner becomes the owner
npm start       # run the assistant
npm run status  # local account and session state
npm run push -- "hello"                      # proactive message to the owner
npm run push -- --file report.pdf "caption"  # proactive file
npm run smoke -- --model haiku "prompt"      # run one prompt through the agent locally, no WeChat
npm run memory-scan                          # extract long-term memories from new transcript entries now
node src/cli.ts pdf report.md                # render Markdown or HTML to PDF locally
```

Only messages from the owner are handled; everything else is logged and dropped.

### In WeChat

Send a task as text or voice. Files and images can come first; they are saved to `~/Alfred/inbox/<date>/` and attached to your next text message. The assistant shows "typing…" while it works, posts a progress note every 3 minutes on long tasks, delivers long results as Markdown files, and turns formal reports into PDFs.

| Command | Effect |
| --- | --- |
| `/new` | start a new session (drops the conversation context; `/resume` brings it back) |
| `/resume` | switch back to the previous session for the next task; send it again to switch back |
| `/stop` | stop the current task and clear queued messages |
| `/model [sonnet\|opus\|haiku]` | show or switch the model; default `sonnet` |
| `/memory` | list long-term memories |
| `/status` | model, session age and idle time, when it rotates, spend, current task |
| `/help` | command list |

One task runs at a time; messages sent meanwhile are queued and handed over together when it finishes.

### Sessions and context

- Each user has one active Claude Code session, and every task resumes it, so the agent remembers earlier tasks. The session id is stored in `agent-state.json`; the transcript lives in the isolated config dir.
- Idle rotation: a task that starts more than `ALFRED_SESSION_IDLE_HOURS` (default 4) after the previous task ended gets a new session, and Alfred says so in one line before it runs. This keeps an old transcript from being re-sent, and billed again once the prompt cache has expired, on every task. Stopped and failed tasks count as activity. `0` disables rotation.
- `/new` and idle rotation keep the retired session as the previous one. `/resume` makes it active again for the next task and keeps the session it replaced as the previous one, so a second `/resume` undoes the first. Only one previous session is kept.
- Spend: `sessionCostUsd` is the SDK's running total for the active session (a resumed session continues from the total its transcript saved) and starts at zero in a new session; `totalCostUsd` adds up each task's increment across all sessions.
- Claude Code compacts the transcript on its own when it nears the context window. Alfred adds no compaction logic and does not log when compaction happens.
- The system prompt is rebuilt for every task and carries the current date. No `CLAUDE.md`, settings, plugins or MCP servers are loaded (`settingSources: []`).
- If a session cannot be resumed, Alfred starts a new one and tells the user; the broken session is dropped, not kept for `/resume`. This happens, for example, after the workspace moves, because transcripts are keyed by working directory.
- Two kinds of state are held in memory only and lost on restart: queued messages, and attachments that have not yet gone out with a text message.
- Workspace files and long-term memory (below) survive a new session; the conversation itself does not.

### Long-term memory

Facts about the user, their preferences and their projects live in `~/Alfred/memory/`, one Markdown file per memory, so both the user and the agent can read and edit them:

```markdown
---
name: Prefers English sources
description: User prefers English-language source material for research
type: preference          # user | preference | project | correction
updated: 2026-10-10
---
When researching, prioritize English sources; still reply in Simplified Chinese.
```

- `memory/MEMORY.md` is an index with one line per memory. Alfred regenerates it from the memory files before and after every task, so edit the memory files, not the index.
- The index is injected into the system prompt of every task, marked as data about the user rather than instructions. The agent reads a memory file when it needs the details. The injected index is capped at 200 lines or 8 KB, most recently updated first; past the cap the agent is told to consolidate.
- Memories are written three ways:
  1. **Explicit.** "记住…", "以后…", "别再…": the agent saves or updates a memory right away and confirms it in its reply.
  2. **Agent's judgment.** The system prompt says what to keep (stable preferences, facts about the user, ongoing projects, corrections) and what to skip (one-off task details, anything in workspace files, secrets).
  3. **Background extraction.** A scan reads the transcript entries added since the last scan and asks `haiku` (through the gateway) for memory candidates, which are merged into existing memories. It runs at startup, every `ALFRED_MEMORY_SCAN_MINUTES`, and whenever a session is retired (idle rotation, `/new`, `/resume`, failed resume). It never runs while a task is running or queued: tasks and scans share a lock file, which also covers a manual `npm run memory-scan` from another process. A scan with no new user messages makes no model call. Each scan is capped at `ALFRED_MEMORY_SCAN_BUDGET_USD` and about 60k characters of conversation, and logs its cost; per-file offsets and the running cost are kept in `memory-scan.json`. Transcripts are read in 1 MB chunks and lines over 1 MB (bulky tool results) are skipped unparsed, so memory use does not grow with transcript size. A batch whose extraction fails three times in a row is skipped.
- Extraction reads only the user's messages and the assistant's final replies, never tool calls or tool results (fetched pages, file contents), so a malicious page cannot plant a memory. The extractor may create or update memories but not delete them, and candidates that look like credentials are dropped.
- To correct or forget a memory, say so in chat. The agent edits the file, or moves it into `.trash/memory/`.
- Workspace rules (file layout, naming, report style) are not memories. Until they get their own file, a rule the user asks for is saved as a `correction` memory.

### Agent sandbox

- Built-in tools: `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebSearch`, `WebFetch`. No shell.
- Custom tools: `send_file` (deliver a workspace file to WeChat; refuses HTML), `move_file` (move or rename inside the workspace; deleting means moving into `.trash/`) and `render_pdf` (Markdown or HTML to A4 PDF).
- PDF rendering uses Playwright's standalone Chrome Headless Shell in `~/.cache/alfred/ms-playwright/`, never the installed Chrome, and loads pages offline, so reports cannot pull or leak anything over the network. Charts must be inline SVG.
- A `PreToolUse` hook confines every file path to the workspace, following symlinks. Permission mode is `dontAsk`, so anything not listed is denied.
- The Claude Code subprocess gets a scrubbed environment and its own config dir, so it never loads the user's Claude Code settings, plugins or MCP servers.
- Each task stops at 60 turns or `ALFRED_MAX_BUDGET_USD` (default $3).
- Residual risk: `WebFetch` can reach any URL, so a malicious page could try to make the agent leak workspace content through a request. Keep secrets out of the workspace.

### PoC echo bot

`npm start -- --echo` runs the protocol test bot instead (`/typing`, `/delay`, `/long`, `/md`, `/file`, `/sendback`).

Verified WeChat behavior (2026-10-10):

- Inbound text, voice (with server-side transcript), image, file and video all work; media decrypts correctly.
- Bot-sent Markdown and PDF files open and render in WeChat. HTML files do not: WeChat refuses to open them.
- In-message Markdown renders, except images.
- Outbound voice messages are accepted by the server but never shown, so audio must go out as a file.
- Still open: whether a proactive push works after 24h without user messages.

## State and files

| Path | Content |
| --- | --- |
| `$XDG_STATE_HOME/alfred/` (default `~/.local/state/alfred/`, override with `ALFRED_STATE_DIR`) | `account.json` (bot token), `sync.json` (poll cursor), `context-tokens.json`, `agent-state.json` (active and previous session, model and spend per user), `memory-scan.json` (transcript offsets and extraction spend), `memory.lock` (held while a task or memory scan runs); files are mode 600 |
| `$XDG_STATE_HOME/alfred/claude/` | isolated Claude Code config dir: agent session transcripts used for resume |
| `~/Alfred/` (override with `ALFRED_WORKSPACE`) | `inbox/`, `reports/`, `notes/`, `memory/`, `.trash/` |
| `$XDG_CACHE_HOME/alfred/ms-playwright/` (default `~/.cache/…`, override with `PLAYWRIGHT_BROWSERS_PATH`) | Chrome Headless Shell for PDF rendering |

| Variable | Default | Purpose |
| --- | --- | --- |
| `ALFRED_LOG` | `info` | `debug` logs every request (credentials redacted) and the agent's stderr |
| `ALFRED_MAX_BUDGET_USD` | `3` | per-task spend cap |
| `ALFRED_SESSION_IDLE_HOURS` | `4` | idle hours after which the next task starts a new session; `0` disables rotation |
| `ALFRED_ANTHROPIC_BASE_URL` | `https://ristretto.damao.io/anthropic` | LLM gateway route |
| `ALFRED_MEMORY_SCAN_MINUTES` | `60` | interval between background memory scans; `0` turns automatic scans off (`npm run memory-scan` still works) |
| `ALFRED_MEMORY_SCAN_BUDGET_USD` | `0.1` | spend cap for one memory scan |

## Layout

```
src/ilink/          iLink protocol client: HTTP, QR login, CDN crypto, message shapes
src/bot.ts          long-poll loop, owner filter, per-user intake queue, typing indicator
src/agent/          Agent SDK handler, options, workspace guard, custom tools, session lifecycle, long-term memory, persisted state
src/echo.ts         PoC handler and protocol test commands
src/files.ts        inbound media storage and file helpers
src/pdf.ts          Markdown/HTML to PDF rendering
src/cli.ts          login | run | push | status | setup-pdf | pdf | memory-scan
scripts/agent-smoke.ts  local agent run without WeChat
```

## Development

```bash
npm run check   # type-check
npm test        # unit tests
npm run smoke -- --model haiku "prompt"   # one agent run with production options, WeChat tools stubbed
```

- The smoke script uses the real workspace and agent config dir. Point `ALFRED_WORKSPACE` and `ALFRED_STATE_DIR` at scratch directories to keep test runs out of them. The same applies to `npm run memory-scan`, which reads transcripts from `$ALFRED_STATE_DIR/claude/projects/` and writes into `$ALFRED_WORKSPACE/memory/`.
- Do not start a second `npm start` against the same state dir while the bot is running. Both processes would long-poll the same cursor and take messages from each other.

## Protocol source

There is no public iLink documentation site. The client follows the protocol notes and MIT-licensed reference implementation in [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) (v2.4.9); see `NOTICE`. The server contract may change without notice.

## License

MIT, see `LICENSE`. The iLink client under `src/ilink/` is ported from openclaw-weixin, also MIT; its notice is in `NOTICE`.
