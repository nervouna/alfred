# Alfred

A personal research assistant on WeChat: web research, material collection and file organization, driven by the Claude Agent SDK and reached through the WeChat iLink bot protocol. All traffic is outbound HTTPS. Messages arrive by long-polling, so no inbound port is needed.

## Requirements

- Node.js 24+ (runs TypeScript directly, no build step)
- WeChat with the ClawBot plugin enabled
- `CF_ID` and `CF_SECRET` in the environment for the ristretto LLM gateway; the agent never uses a direct provider key

## Usage

```bash
npm install
npm run login   # scan the QR code with WeChat; the scanner becomes the owner
npm start       # run the assistant
npm run status  # local account and session state
npm run push -- "hello"                      # proactive message to the owner
npm run push -- --file report.pdf "caption"  # proactive file
npm run smoke -- --model haiku "prompt"      # run one prompt through the agent locally, no WeChat
```

Only messages from the owner are handled; everything else is logged and dropped.

### In WeChat

Send a task as text or voice. Files and images can come first; they are saved to `workspace/inbox/<date>/` and attached to your next text message. The assistant shows "typing…" while it works, posts a progress note every 3 minutes on long tasks, and delivers long results as Markdown files.

| Command | Effect |
| --- | --- |
| `/new` | start a new session (drops the conversation context) |
| `/stop` | stop the current task and clear queued messages |
| `/model [sonnet\|opus\|haiku]` | show or switch the model; default `sonnet` |
| `/status` | model, session, spend, current task |
| `/help` | command list |

One task runs at a time; messages sent meanwhile are queued and handed over together when it finishes.

### Agent sandbox

- Built-in tools: `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebSearch`, `WebFetch`. No shell.
- Custom tools: `send_file` (deliver a workspace file to WeChat; refuses HTML) and `move_file` (move or rename inside the workspace; deleting means moving into `.trash/`).
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
| `workspace/` (override with `ALFRED_WORKSPACE`) | `inbox/`, `reports/`, `notes/`, `.trash/`; git-ignored |

| Variable | Default | Purpose |
| --- | --- | --- |
| `ALFRED_LOG` | `info` | `debug` logs every request (credentials redacted) and the agent's stderr |
| `ALFRED_MAX_BUDGET_USD` | `3` | per-task spend cap |
| `ALFRED_ANTHROPIC_BASE_URL` | `https://ristretto.damao.io/anthropic` | LLM gateway route |

## Layout

```
src/ilink/          iLink protocol client: HTTP, QR login, CDN crypto, message shapes
src/bot.ts          long-poll loop, owner filter, per-user intake queue, typing indicator
src/agent/          Agent SDK handler, options, workspace guard, custom tools, persisted state
src/echo.ts         PoC handler and protocol test commands
src/files.ts        inbound media storage and file helpers
src/cli.ts          login | run | push | status
scripts/agent-smoke.ts  local agent run without WeChat
```

## Protocol source

There is no public iLink documentation site. The client follows the protocol notes and MIT-licensed reference implementation in [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) (v2.4.9); see `NOTICE`. The server contract may change without notice.
