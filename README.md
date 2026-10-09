# Alfred

A personal research assistant on WeChat, built on the WeChat iLink bot protocol and (next) the Claude Agent SDK. All traffic is outbound HTTPS: messages arrive by long-polling, so no inbound port is needed.

The current milestone is an **echo bot PoC** that validates the iLink side: QR login, receiving and sending, media transfer, typing indicator, long-message chunking and proactive push.

## Requirements

- Node.js 24+ (runs TypeScript directly, no build step)
- WeChat with the ClawBot plugin enabled

## Usage

```bash
npm install
npm run login   # scan the QR code with WeChat; the scanner becomes the owner
npm start       # run the echo bot
npm run status  # local account and session state
npm run push -- "hello"               # proactive message to the owner
npm run push -- --no-context "hello"  # same, without a context token
```

Send `/help` to the bot in WeChat for the test commands:

| Command | Verifies |
| --- | --- |
| any text / voice | receive, reply, voice transcript |
| image, file, video | CDN download + AES decrypt, saved to `workspace/inbox/<date>/` |
| `/typing [s]` | typing indicator keepalive |
| `/delay <s>` | late replies reusing an older context token |
| `/long [n]` | 4000-character chunking |
| `/md` | which Markdown WeChat renders |
| `/file` | file delivery (can WeChat open a bot-sent file?) |
| `/sendback` | re-upload of the last received image/file/video |

Only messages from the owner are handled; everything else is logged and dropped.

## State and files

| Path | Content |
| --- | --- |
| `$XDG_STATE_HOME/alfred/` (default `~/.local/state/alfred/`) | `account.json` (bot token), `sync.json` (poll cursor), `context-tokens.json`; files are mode 600 |
| `workspace/` (override with `ALFRED_WORKSPACE`) | received and generated files; git-ignored |

Set `ALFRED_LOG=debug` to log every request (credentials redacted).

## Layout

```
src/ilink/   iLink protocol client: HTTP, QR login, CDN crypto, message shapes
src/bot.ts   long-poll loop, owner filter, per-user queue, typing indicator
src/echo.ts  PoC handler and test commands
src/cli.ts   login | run | push | status
```

## Protocol source

There is no public iLink documentation site. The client follows the protocol notes and MIT-licensed reference implementation in [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) (v2.4.9); see `NOTICE`. The server contract may change without notice.
