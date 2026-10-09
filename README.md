# Alfred

A personal research assistant on WeChat: web research, material collection and file organization, driven by the Claude Agent SDK and reached through the WeChat iLink bot protocol. All traffic is outbound HTTPS. Messages arrive by long-polling, so no inbound port is needed.

## Requirements

- Node.js 24+ (runs TypeScript directly, no build step)
- WeChat with the ClawBot plugin enabled
- `CF_ID` and `CF_SECRET` in the environment for the ristretto LLM gateway; the agent never uses a direct provider key
- Optional, for image generation: the [`mmx`](https://www.npmjs.com/package/mmx-cli) CLI with a MiniMax Token Plan key in `~/.config/mmx/config.json` (check with `mmx quota show`)

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
node src/cli.ts pdf report.md                # render Markdown or HTML to PDF locally
```

Only messages from the owner are handled; everything else is logged and dropped.

### In WeChat

Send a task as text or voice. Files and images can come first; they are saved to `~/Alfred/inbox/<date>/` and attached to your next text message. The assistant shows "typing…" while it works, posts a progress note every 3 minutes on long tasks, delivers long results as Markdown files, turns formal reports into PDFs, and generates images on request.

| Command | Effect |
| --- | --- |
| `/new` | start a new session (drops the conversation context) |
| `/stop` | stop the current task and clear queued messages |
| `/model [sonnet\|opus\|haiku]` | show or switch the model; default `sonnet` |
| `/status` | model, session, spend, current task |
| `/help` | command list |

One task runs at a time; messages sent meanwhile are queued and handed over together when it finishes.

### Sessions and context

- Each user has one Claude Code session, and every task resumes it, so the agent remembers earlier tasks until `/new`. The session id is stored in `agent-state.json`; the transcript lives in the isolated config dir.
- Claude Code compacts the transcript on its own when it nears the context window. Alfred adds no compaction logic and does not log when compaction happens.
- The system prompt is rebuilt for every task and carries the current date. No `CLAUDE.md`, settings, plugins or MCP servers are loaded (`settingSources: []`).
- If a session cannot be resumed, Alfred starts a new one and tells the user. This happens, for example, after the workspace moves, because transcripts are keyed by working directory.
- Two kinds of state are held in memory only and lost on restart: queued messages, and attachments that have not yet gone out with a text message.
- There is no long-term memory. Only workspace files survive `/new`.

### Agent sandbox

- Built-in tools: `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebSearch`, `WebFetch`. No shell.
- Custom tools: `send_file` (deliver a workspace file to WeChat; images arrive as image messages; refuses HTML), `move_file` (move or rename inside the workspace; deleting means moving into `.trash/`), `render_pdf` (Markdown or HTML to A4 PDF) and `generate_image` (MiniMax `image-01` through `mmx`).
- PDF rendering uses Playwright's standalone Chrome Headless Shell in `~/.cache/alfred/ms-playwright/`, never the installed Chrome, and loads pages offline, so reports cannot pull or leak anything over the network. Charts must be inline SVG. Workspace images load by relative path, so a report in `reports/` can embed `../images/<date>/cover.jpg`.
- `generate_image` runs `mmx` with `execFile` (no shell) in the Alfred process, not in the agent's Claude Code subprocess. It uses the user's own Token Plan key, not the LLM gateway. Output paths must resolve inside the workspace, and existing files are never overwritten; the default is `images/<date>/<slug>.jpg`. A task may request at most 4 images per call and 8 in total. Failed and timed-out calls count, because MiniMax bills them too, and the tool never retries. `mmx` errors, quota errors included, reach the agent verbatim, and every call is logged.
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
| `$XDG_STATE_HOME/alfred/` (default `~/.local/state/alfred/`, override with `ALFRED_STATE_DIR`) | `account.json` (bot token), `sync.json` (poll cursor), `context-tokens.json`, `agent-state.json` (session, model and spend per user); files are mode 600 |
| `$XDG_STATE_HOME/alfred/claude/` | isolated Claude Code config dir: agent session transcripts used for resume |
| `~/Alfred/` (override with `ALFRED_WORKSPACE`) | `inbox/`, `reports/`, `notes/`, `images/`, `.trash/` |
| `$XDG_CACHE_HOME/alfred/ms-playwright/` (default `~/.cache/…`, override with `PLAYWRIGHT_BROWSERS_PATH`) | Chrome Headless Shell for PDF rendering |

| Variable | Default | Purpose |
| --- | --- | --- |
| `ALFRED_LOG` | `info` | `debug` logs every request (credentials redacted) and the agent's stderr |
| `ALFRED_MAX_BUDGET_USD` | `3` | per-task spend cap |
| `ALFRED_ANTHROPIC_BASE_URL` | `https://ristretto.damao.io/anthropic` | LLM gateway route |
| `ALFRED_MMX_BIN` | `$CLAUDE_CONFIG_DIR/skills/mmx/bin/mmx` (`~/.claude/…` when unset) | `mmx` executable for `generate_image`; if it is missing, the tool returns an error |

## Layout

```
src/ilink/          iLink protocol client: HTTP, QR login, CDN crypto, message shapes
src/bot.ts          long-poll loop, owner filter, per-user intake queue, typing indicator
src/agent/          Agent SDK handler, options, workspace guard, custom tools, image generation, persisted state
src/echo.ts         PoC handler and protocol test commands
src/files.ts        inbound media storage and file helpers
src/pdf.ts          Markdown/HTML to PDF rendering
src/cli.ts          login | run | push | status | setup-pdf | pdf
scripts/agent-smoke.ts  local agent run without WeChat
```

## Development

```bash
npm run check   # type-check
npm test        # unit tests
npm run smoke -- --model haiku "prompt"   # one agent run with production options, WeChat tools stubbed
```

- The smoke script uses the real workspace and agent config dir. Point `ALFRED_WORKSPACE` and `ALFRED_STATE_DIR` at scratch directories to keep test runs out of them.
- Do not start a second `npm start` against the same state dir while the bot is running. Both processes would long-poll the same cursor and take messages from each other.

## Protocol source

There is no public iLink documentation site. The client follows the protocol notes and MIT-licensed reference implementation in [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) (v2.4.9); see `NOTICE`. The server contract may change without notice.

## License

MIT, see `LICENSE`. The iLink client under `src/ilink/` is ported from openclaw-weixin, also MIT; its notice is in `NOTICE`.
