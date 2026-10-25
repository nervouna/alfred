# Alfred

A personal research assistant on WeChat: web research, material collection and file organization, driven by the Claude Agent SDK and reached through the WeChat iLink bot protocol. All traffic is outbound HTTPS. Messages arrive by long-polling, so no inbound port is needed.

## Requirements

- Node.js 24+ (runs TypeScript directly, no build step)
- WeChat with the ClawBot plugin enabled
- An Anthropic API key in `ALFRED_ANTHROPIC_API_KEY`. Give Alfred a key of its own, in a Console workspace with a spend limit, so a leaked key costs at most that limit and can be revoked without touching anything else
- Optional, for image generation: the [`mmx`](https://www.npmjs.com/package/mmx-cli) CLI with a MiniMax Token Plan key in its config file, `~/.mmx/config.json` or `$MMX_CONFIG_DIR/config.json` (check with `mmx quota show`)

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
node src/cli.ts pdf report.md                # render Markdown or HTML to PDF locally; local images load from the workspace, or only from the source's directory for files outside it
```

Only messages from the owner are handled; everything else is logged and dropped.

### Run at login (macOS)

A LaunchAgent can start Alfred at login and restart it if it crashes. launchd does not read your shell profile, so the plist has to set `PATH`, the mmx location and the API key itself. To keep the key out of the plist, Node reads it from an env file (mode 600) via `--env-file`. That file holds `ALFRED_ANTHROPIC_API_KEY=…`, with or without `export`.

Save as `~/Library/LaunchAgents/<label>.plist`, replacing the paths:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>local.alfred</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/opt/node@24/bin/node</string>
    <string>--env-file=/path/to/alfred.env</string>
    <string>src/cli.ts</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/path/to/alfred</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/opt/node@24/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>ALFRED_MMX_BIN</key>
    <string>/path/to/mmx</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>/Users/you/.local/state/alfred/alfred.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/you/.local/state/alfred/alfred.log</string>
</dict>
</plist>
```

- `PATH` must contain Node's `bin` directory; the mmx wrapper runs `npx`. Point `ALFRED_MMX_BIN` at the mmx executable, or leave it out if you don't use image generation.
- A crash restarts Alfred after 30 s. A clean exit (SIGTERM, `launchctl bootout`) does not.
- Stop any `npm start` instance first: two processes on the same state dir take messages from each other.
- The agent starts after you log in, not at boot.

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.alfred.plist   # install and start
launchctl kickstart -k gui/$(id -u)/local.alfred                             # restart, e.g. after git pull
launchctl bootout gui/$(id -u)/local.alfred                                  # stop and unload
launchctl print gui/$(id -u)/local.alfred | grep -E 'state|pid'              # status
```

### Run in a container (Linux)

`Containerfile` builds an image with Node 24, Chrome Headless Shell, CJK fonts and the `mmx` CLI. `deploy/alfred.container` runs it as a rootless podman Quadlet: the state dir and workspace are bind mounts under `~/data/`, the API key and the mmx config are podman secrets, and logs go to the journal. Use a dedicated, unprivileged user with lingering enabled (`loginctl enable-linger <user>`), and run everything below as that user:

```bash
git clone https://github.com/nervouna/alfred ~/alfred && cd ~/alfred
podman build -t localhost/alfred:latest .
mkdir -p ~/data/state ~/data/workspace
read -rs KEY && printf %s "$KEY" | podman secret create alfred_anthropic_api_key - && unset KEY   # paste the key, Enter
podman secret create alfred_mmx_config /path/to/mmx/config.json
podman run --rm -it --userns=keep-id:uid=1000,gid=1000 -v ~/data/state:/data/state localhost/alfred:latest node src/cli.ts login
install -Dm644 deploy/alfred.container ~/.config/containers/systemd/alfred.container
systemctl --user daemon-reload && systemctl --user start alfred
```

- Keep the installed `alfred.container` identical to the repo's: `deploy/update.sh` compares the two on every update and stops when they differ. Settings for your host go in a Quadlet drop-in, which podman merges into the unit:

  ```bash
  mkdir -p ~/.config/containers/systemd/alfred.container.d
  cat > ~/.config/containers/systemd/alfred.container.d/host.conf <<'EOF'
  [Container]
  # Your time zone: a drop-in's TZ replaces the Quadlet's default.
  Environment=TZ=Europe/Berlin
  EOF
  systemctl --user daemon-reload
  ```

  Restart Alfred afterwards (`deploy/update.sh --restart`) so the container gets the new settings.
- Without `generate_image`, create the mmx secret from an empty config (`echo '{}' | podman secret create alfred_mmx_config -`) rather than removing the `Secret=` line; `generate_image` then returns the mmx error.
- The container restarts 30 s after any exit and starts at boot.
- `journalctl --user` needs a persistent journal. If `/var/log/journal` does not exist, create it as root, run `systemd-tmpfiles --create --prefix /var/log/journal`, restart `systemd-journald` and run `journalctl --rotate`. Until then, root can read the logs with `journalctl CONTAINER_NAME=alfred`.
- Podman stores secrets unencrypted, readable only by that user. They stay out of the image, the unit file and the repo.
- An env secret keeps its bytes as they are, so create the key without a trailing newline, as above.

```bash
journalctl --user -u alfred -f                                                             # logs
cd ~/alfred && git pull && podman build -t localhost/alfred:latest . && systemctl --user restart alfred   # update
```

### Workbench

A read-only web page for following Alfred's work: one card per run with live progress and the files it wrote, the workspace with Markdown, image and PDF preview, HTML reports, spend, session transcripts, memory and logs. You still talk to Alfred only in WeChat. The workbench never sends anything to Alfred, and Alfred never reads from it.

- **Runs.** Every task (and every memory scan that called the model) is a run with a short id such as `k7m2qa`.
  - The id shows on its card, with a button that copies it, in the 3-minute progress notes, in `/status` and in the logs.
  - A reply from a run that wrote files ends with the id, or with a link to the card when `ALFRED_WORKBENCH_URL` is set.
  - Paste an id into a WeChat message ("把 k7m2qa 的报告改成英文") and the run's title, status and file list are added to the prompt.
- **HTML reports** open in a sandboxed frame. Inline scripts, styles and SVG run, so charts draw, but the frame has an opaque origin and a policy that blocks every request, so a report can neither read the workbench nor send anything out. Workspace images are inlined as `data:` URIs. With `ALFRED_WORKBENCH=on` (or a URL), the agent is told that HTML reports can be read here and need a PDF only when you want one.
- **Delivery is best effort.** A reply or `send_file` that WeChat refuses (for example `ret=-2` once the 24-hour push window has closed) is sent once, logged, and marked on the run's card as not delivered; nothing is retried or queued. Your next WeChat message first gets one line naming those runs.
- **Read-only.** Every endpoint answers only `GET`. The workbench reads `$ALFRED_STATE_DIR/workbench/` (`runs.jsonl` for good, `runs/<id>.json` with the step timeline for 30 days, `status.json` as the heartbeat, `alfred.log`), the transcripts under `claude/projects/`, and the workspace. All output is escaped, Markdown renders without raw HTML, paths are confined to the workspace, and HTML and SVG files download instead of opening outside the report viewer.
- **Two listeners.** TCP (`ALFRED_WORKBENCH_LISTEN`, default `127.0.0.1:8787`) is for a Cloudflare tunnel. Every request there needs a valid `Cf-Access-Jwt-Assertion`: an RS256 signature from the team's keys, the application's AUD tag, the team's issuer, a token that has not expired, and the owner's email. A Unix socket (`ALFRED_WORKBENCH_SOCKET`, created 0600) needs no token, for an SSH tunnel: `ssh -N -L 8787:/home/<user>/data/workbench-socket/workbench.sock <host>`, then open `http://localhost:8787`.
- `node src/cli.ts workbench --dev` serves on loopback without the Access check, for local testing.

On the host, the workbench and a dedicated `cloudflared` run in their own pod (`deploy/workbench.pod`, `workbench.container`, `workbench-tunnel.container`). They use the Alfred image, so `deploy/update.sh` restarts the workbench after an update. In the Cloudflare dashboard, create a remotely managed tunnel whose public hostname points at `http://localhost:8787`, and an Access application on that hostname that allows only your email. Then:

```bash
mkdir -p ~/data/state/workbench ~/data/state/claude/projects ~/data/workbench-socket ~/.config/alfred
read -rs TOKEN && printf %s "$TOKEN" | podman secret create workbench_tunnel_token - && unset TOKEN   # the tunnel token
cat > ~/.config/alfred/workbench.env <<'ENV'
CF_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com
CF_ACCESS_AUD=<the Access application's AUD tag>
ALFRED_WORKBENCH_OWNER_EMAIL=<your email>
ENV
install -m644 deploy/workbench.pod deploy/workbench.container deploy/workbench-tunnel.container ~/.config/containers/systemd/
systemctl --user daemon-reload && systemctl --user start workbench-pod
```

- The workbench container mounts only what it shows, read-only: `account.json`, the context tokens and the rest of the state dir are not mounted. Its root filesystem is read-only too, and the socket directory is its one writable path.
- Once the workbench is up, set `Environment=ALFRED_WORKBENCH=on` for Alfred in a drop-in such as `~/.config/containers/systemd/alfred.container.d/workbench.conf` (under `[Container]`, as above), not in `alfred.container` itself, then `systemctl --user daemon-reload` and `deploy/update.sh --restart`. Add `Environment=ALFRED_WORKBENCH_URL=https://<hostname>` there when WeChat opens the link and gets through the Access sign-in; leave it unset if it does not, and replies carry the run id only.

### In WeChat

Send a task as text or voice. Files and images can come first; they are saved to `~/Alfred/inbox/<date>/` and attached to your next text message. The assistant shows "typing…" while it works, posts a progress note every 3 minutes on long tasks, delivers long results as Markdown files, turns formal reports into PDFs, and generates images on request.

| Command | Effect |
| --- | --- |
| `/new` | start a new session (drops the conversation context; `/resume` brings it back) |
| `/resume` | switch back to the previous session for the next task; send it again to switch back |
| `/stop [run id]` | interrupt the turn the agent is on (below); with a run id, stop only that background subagent or take it out of the queue |
| `/model [sonnet\|opus\|haiku]` | show or switch the model; default `sonnet`. During a task the switch applies from its next turn (subagent roles keep their default models) |
| `/memory` | list long-term memories |
| `/status` | model, session age and idle time, when it rotates, spend today against the daily cap, current task, background and queued subagents, pending follow-ups |
| `/help` | command list |

One task runs at a time, and you can steer it while it runs ("别查 X 了，重点看 Y"):

- A message sent during a task is acknowledged (`收到，会在当前步骤结束后转给 Alfred。`) and handed to the running agent at the next step boundary, once the current model call and its tool calls finish. A tool call in flight is not interrupted. Files sent mid-task travel with the next text message, as before.
- If the agent is still working through tool calls, the follow-up joins the current turn and one reply answers both. If it was already writing its final answer, the follow-up runs as its own turn right after, and each turn gets its own reply, sent as soon as it ends.
- The typing indicator shows while the agent works on a turn, and a turn that runs longer than 3 minutes gets a progress note every 3 minutes (with the run id, see Workbench). While foreground subagents run, the note and `/status` list them with their role, brief title and age. Background subagents show their progress on their workbench cards instead.
- Once every message has been answered and no background subagent is running or queued, the task ends. A message that arrives after that is queued and starts the next task, which resumes the same session.
- `/stop` interrupts the turn the agent is on (`Query.interrupt()`) and does not abort the task. The turn ends without a reply: neither its text nor an error line. Alfred answers `已停止当前任务。`, and when background subagents are still running or queued, `已停止当前任务。后台运行 <id>、<id> 仍在继续，发 /stop <id> 停止。` Follow-ups already handed to the task and messages queued behind it are kept and answered afterwards. The task ends as stopped when the interrupted turn was its last, with nothing left to answer and no background subagent running; otherwise it goes on and ends as usual. If the turn has not ended 10 seconds after the interrupt, the task is aborted instead (logged), which also drops its subagents and the follow-ups it has not answered.

### Channels

The handler serves the owner over named channels: `wechat` and `app`. The app channel's only client so far is the command API below, which calls the handler's `submit` and `stopRun` (see `src/channels.ts`); the handler treats the app like WeChat.

- One intake queue takes the owner's messages in arrival order, whatever their channel, with the same steer, queue and command rules as above: an app message during a run that WeChat started steers that run. App messages belong to the owner and share the session, state and timeline of WeChat ones.
- A run answers on the channel of the message that started it: the final reply, files from `send_file` and background subagent reports (for messages queued behind a task, the channel of the first one queued). A command's reply and the notices a message triggers (acknowledgements, lost or undelivered runs, the daily cap, changed rules) go to that message's channel. Progress notes and the typing indicator exist on WeChat only.
- Every message in either direction is recorded in the event log as `message.created`, except progress notes: channel, direction, text, files, the run it started, steered or came from, and for an app message its client id. A WeChat send that fails is recorded with its `error`. On the app channel the event is the delivery, so a reply shows in the app whichever channel it went out on. The timeline starts when this version first runs; older WeChat history is not backfilled.
- The notes a message triggers (lost runs, undelivered results, media that could not be saved) are recorded after that message, so in the log the owner's `message.created` comes first. WeChat receives the same notes as before.
- A run also publishes live events, which are told to whoever is following the stream and never stored (see Command API): the main agent's reply text as it is written (`message.delta`) and each step the run records (`run.step`). Nothing of this reaches WeChat, which still gets the reply when its turn ends.

### Command API

A process on the same host can send the owner's commands to Alfred and follow its events over a Unix socket. `node src/cli.ts run` serves it (not with `--echo`) and closes it at shutdown before the handler stops its runs. There is no TCP listener.

- **Socket.** `ALFRED_API_SOCKET`, by default `$STATE_DIR/api/alfred.sock`; `off` disables the API. The socket is mode 0600, and a directory created for it is 0700 (one that exists is left as it is). A socket file left by a crash is removed at start.
- **`POST /commands`** takes `Content-Type: application/json` and a body of at most 65,536 bytes, which gets 413 as soon as the limit is crossed. A wrong content type, invalid JSON or a command `parseCommand` (`src/api/schema.ts`) rejects gets 400 `{"error": "…"}`, and nothing reaches the handler.
  - `{"type": "message.send", "clientId": "…", "text": "…"}` submits the message on the app channel and answers 202 `{"accepted": true}`. A client id among the last 1000 accepted gets 200 `{"accepted": false, "duplicate": true}` and is not submitted again. Those ids are kept in memory: a restart forgets them.
  - `{"type": "run.stop", "runId": "…"}` answers 202 `{"stopped": true}`, or 404 `{"error": "no live or queued run <id>"}`. For the task it interrupts the current turn, like `/stop` (see In WeChat); the reply `已停止当前任务。` arrives as a `message.created` event.
- **`GET /events`** streams `text/event-stream`. It starts after the `Last-Event-ID` header if there is one, else after `?after=<id>`, else from the start; anything but a non-negative integer gets 400. It sends the backlog first, then new events, with no gap and no repeat across the switch. Each durable event is `id: <id>`, `event: <type>` and `data: <the event as one line of JSON>`, and `: ping` goes out every 30 seconds. A reconnecting client sends the last id it saw.
- **Live events** go out on the same stream as `event: <type>` and `data: <one line of JSON: at, type, data>`, with no `id:` line, so a client's last id stays that of the last durable event. They are never stored, and a stream never replays them: one that happens while a stream is still sending its backlog is dropped for that stream, and a client that reconnects misses what happened meanwhile (the final reply is a `message.created` event, so nothing durable is lost).
  - `message.delta` (`runId`, `streamId`, `text`): a piece of the main agent's reply text. `streamId` is the API message's id and the index of the text block (`msg_01….1`): it is the same for every delta of one block and differs for the next. Subagents' text, thinking and tool input are not streamed.
  - `run.step` (`runId`, `step`): a step as it is recorded on the run's card. It carries the id of the run that took it: the task's for its own and its foreground subagents' steps (with `agent` set for the latter), a background subagent's own for its steps.
- **`GET /health`** answers `{"ok": true, "lastEventId": <n>}`. Other paths get 404, other methods 405.

```bash
node src/cli.ts api send "text"                 # POST message.send with a fresh client id; prints the status and body
node src/cli.ts api stop k7m2qa                 # POST run.stop
node src/cli.ts api events --after 120          # the events after id 120, then exit
node src/cli.ts api events --follow             # all of them, then new ones as they come
curl --unix-socket "$STATE_DIR/api/alfred.sock" -N http://localhost/events
```

### Sessions and context

- Each user has one active Claude Code session, and every task resumes it, so the agent remembers earlier tasks. The session id is stored in `agent-state.json`; the transcript lives in the isolated config dir.
- Idle rotation: a task that starts more than `ALFRED_SESSION_IDLE_HOURS` (default 4) after the previous task ended gets a new session, and Alfred says so in one line before it runs. This keeps an old transcript from being re-sent, and billed again once the prompt cache has expired, on every task. Stopped and failed tasks count as activity. `0` disables rotation.
- `/new` and idle rotation keep the retired session as the previous one. `/resume` makes it active again for the next task and keeps the session it replaced as the previous one, so a second `/resume` undoes the first. Only one previous session is kept.
- Spend: `sessionCostUsd` is the SDK's running total for the active session (a resumed session continues from the total its transcript saved) and starts at zero in a new session; `totalCostUsd` adds up each task's increment across all sessions.
- Claude Code compacts the transcript on its own when it nears the context window. Alfred adds no compaction logic and does not log when compaction happens.
- The system prompt is rebuilt for every task and carries the current date and the root `ALFRED.md`. No `CLAUDE.md` or settings files are loaded (`settingSources: []`). The only plugins are Alfred's two skill plugins (see Skills), and the only MCP server is Alfred's own tools.
- If a session cannot be resumed, Alfred starts a new one and tells the user; the broken session is dropped, not kept for `/resume`. This happens, for example, after the workspace moves, because transcripts are keyed by working directory.
- Two kinds of state are held in memory only and lost on restart: follow-ups and queued messages not yet answered, and attachments that have not yet gone out with a text message. Runs a restart cuts short are recorded as lost (see Subagents).
- `/new` and `/resume` are refused while a task runs, background subagents included.
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
  3. **Background extraction.** A scan reads the transcript entries added since the last scan and asks `haiku` for memory candidates, which are merged into existing memories. It runs at startup, every `ALFRED_MEMORY_SCAN_MINUTES`, and whenever a session is retired (idle rotation, `/new`, `/resume`, failed resume). It never runs while a task is running or queued: tasks and scans share a lock file, which also covers a manual `npm run memory-scan` from another process. A scan with no new user messages makes no model call. Each scan is capped at `ALFRED_MEMORY_SCAN_BUDGET_USD` and about 60k characters of conversation, and logs its cost; per-file offsets and the running cost are kept in `memory-scan.json`. Transcripts are read in 1 MB chunks and lines over 1 MB (bulky tool results) are skipped unparsed, so memory use does not grow with transcript size. A batch whose extraction fails three times in a row is skipped.
- Extraction reads only the user's messages (follow-ups sent mid-task included) and the assistant's final replies, never tool calls or tool results (fetched pages, file contents), so a malicious page cannot plant a memory. The extractor may create or update memories but not delete them, and candidates that look like credentials are dropped.
- To correct or forget a memory, say so in chat. The agent edits the file, or moves it into `.trash/memory/`.
- Boundary with `ALFRED.md`: memory holds facts about the user (who they are, what they like, what they are working on); rules for how to work in the workspace (where files go, naming, report style) go into `ALFRED.md`. The system prompt states both sides, and background extraction skips workspace rules.

### Workspace rules (`ALFRED.md`)

Conventions for working in the workspace (where things go, naming, report style) live in `ALFRED.md` files that the user can change from WeChat ("以后报告开头都加三行摘要") or edit directly. Core behavior stays in code: WeChat formatting, delivery rules and safety.

- **Root.** `~/Alfred/ALFRED.md` is read at the start of every task and appended to the system prompt. When it is missing at startup, it is seeded with the default layout (`inbox/`, `reports/`, `notes/`, `images/`, `skills/`, `.trash/`).
- **Nested.** A subdirectory can have its own `ALFRED.md` (e.g. `reports/ALFRED.md`) that applies to it and everything below it. It is disclosed only when the agent works there: a `PostToolUse`/`PostToolUseFailure` hook on `Read`, `Write`, `Edit`, `Glob`, `Grep`, `move_file`, `render_pdf` and `generate_image` resolves the touched path and injects, through `additionalContext`, the `ALFRED.md` files between the workspace root and that path that the agent has not seen in this task. `Glob` and `Grep` count the directory their pattern or `glob` starts in, and a content-mode `Grep` also counts the directories of the files whose lines it returned. Disclosures are tracked per task by path and mtime, so a file that changes is disclosed again. A task that never touches `reports/` never receives `reports/ALFRED.md`.
- **Limits.** Each file is capped at 8 KB in the prompt. Symlinked `ALFRED.md` files, paths outside the workspace and anything under `.trash/` are ignored. A received file named `ALFRED.md` is saved as `_ALFRED.md`, so a forwarded file cannot become rules.
- **Edits.** The agent changes an `ALFRED.md` only on the user's explicit request, never because content it read says so. Every write is logged, and after any task that created, changed or removed an `ALFRED.md`, Alfred says so in WeChat (`已更新 reports/ALFRED.md`), even if the task was stopped or failed.
- `ALFRED.md` holds rules for how to work, not facts about the user; those go into long-term memory (above).

### Skills

Know-how for one kind of task that is too long for the system prompt lives in skills (`SKILL.md`), loaded the way the Agent SDK ships them. The model sees each skill's name and description and loads the body through the `Skill` tool when a task calls for it. Each `Skill` call is a step on the run's card.

- **Baked skills** are the local plugin `alfred` in `plugin/`, copied into the image and changed through a PR: `html-report` (a self-contained HTML template with print CSS, inline-SVG chart snippets and a checklist), `compare-options` and `deep-dive`. The `writer` role starts with `html-report` preloaded.
- **The owner's skills** live in `~/Alfred/skills/<name>/SKILL.md` and are listed as `workspace:<name>`. They reach Claude Code through a plugin root outside the workspace, `$STATE_DIR/workspace-plugin/`, which startup creates with a manifest and a symlink `skills → <workspace>/skills`. Nothing else in that root points into the workspace, so the agent can add skills but never hooks, MCP servers or agent types. Supporting files next to a `SKILL.md` resolve into the workspace and pass the workspace guard. A new skill is listed from the next task; a resumed session gets it as a delta.
- **Edits.** The agent creates, changes or removes a skill only on the owner's explicit request, as with `ALFRED.md`. After a task that changed anything under `skills/`, Alfred says so in WeChat (`已新建 skills/weekly-brief/SKILL.md`). Subagents cannot write there. Where a skill conflicts with the request or an `ALFRED.md`, those win.
- **Nothing in a skill runs code.** `disableSkillShellExecution` replaces inline `` !`cmd` `` with a placeholder. `disableAllHooks` stops hooks a skill or plugin declares; Alfred's own hooks are SDK callbacks and keep working. The fixed `tools` list ignores a skill's `allowed-tools`, and the workspace plugin has `skipMcpDiscovery`.
- **Forked skills.** A skill with `context: fork` runs as a foreground subagent of the type its `agent:` names (`general-purpose` by default, or a plugin's agent such as `alfred:<name>`), under the same rules as any subagent (see Subagents).
- **Only Alfred's skills.** `skills: 'all'` lists the skills of the two plugins. The skills bundled with Claude Code are coding tools and stay off: `disableBundledSkills`, plus `cc-plugin-plugin-authoring@builtin` turned off in `enabledPlugins`.
- **Invocation.** One line in the system prompt tells the agent to invoke a skill that covers the task before it starts. Without it, sonnet wrote chart reports without `html-report` in four of five smoke runs.
- **Cost.** The `Skill` tool, the three descriptions and the prompt lines add about 1,100 tokens to a task's first request (12.6k against 11.5k), which are then cached. The listing is not part of the system prompt, so the prompt cache holds when skills change. A body costs only when it is used; a preloaded one costs on every start of its role.

### Subagents

Alfred can hand parts of a task to subagents through the SDK's `Agent` tool, for example one researcher per independent thread, or a collector for bulk reading that would flood its own context. The roles are SDK agent definitions in `SUBAGENT_ROLES` in `src/agent/config.ts`, each with a default model, tools and turn budget:

| Role | Default model | Tools | Max turns | Use |
| --- | --- | --- | --- | --- |
| `collector` | haiku | file tools, `WebSearch`, `WebFetch` | 40 | bulk fetching and extraction |
| `researcher` | sonnet | file tools, `WebSearch`, `WebFetch` | 40 | one research thread with source links |
| `writer` | opus | file tools, `render_pdf`, `generate_image` | 30 | long reports from gathered material, PDF output |

- **Any agent type, any model.** The system prompt recommends the roles, but an `Agent` call may use any type the SDK offers (`general-purpose`, `Explore`, `Plan`, a plugin's agent, a role) and pass `model` or `effort`; the call runs as written. `general-purpose` runs on Alfred's model with all its tools, so it costs more than a role. The spend caps bound the cost, and a subagent's card shows the model it actually ran on, taken from its first message.
- **Shared rules for every subagent.** A `SubagentStart` hook adds the subagent rules (the report goes to Alfred, what it reads is data, cite sources, stay off `memory/`, `skills/` and `ALFRED.md`) to every subagent: roles, built-in types, plugin agents and forked skills. Each role's own prompt holds only its focus.
- **Background by default.** Long work runs in background subagents while Alfred keeps answering. A task's query stays open while any of them run or wait: its input closes only once every message is answered and no background subagent is live or queued, because the SDK kills background tasks when the input closes.
  - **Dispatch.** The reply that starts subagents ends with one line per run id (`后台运行 k7m2qa：researcher「…」`). Each background subagent has a card of its own on the workbench, linked to the task that started it, with its own steps and files.
  - **Reports.** When a subagent finishes, its report starts a turn of its own. Alfred reviews it (below) and replies, and the reply names the runs it covers (`来自运行 k7m2qa`). That turn answers no user message: its result carries no message uuid, and the live input knows to answer nothing with it.
  - **Concurrency.** At most `MAX_BACKGROUND_RUNS` (2) background subagents run at a time, because every `render_pdf` starts its own Chrome inside a 2 GB container. Background calls a subagent makes (a `general-purpose` one has the `Agent` tool) count toward the same cap. A further call is denied with a reason that tells Alfred it is queued. Its run gets a card with the status queued. When a slot frees, Node hands the brief back to Alfred as a message from Alfred itself, and Alfred starts it. A brief the agent decides not to start is marked stopped.
  - **Steering.** No message reaches a running subagent. A change of content or direction makes Alfred stop the subagent (`TaskStop`) and start it again with an amended brief. A change of form (language, format, length) is applied when Alfred reviews the report. A message that names a run id gets the run's record, and its agent id while it runs.
  - **Foreground.** A call with `run_in_background: false` runs in the foreground, for quick work Alfred's next step needs.
- **Only Alfred talks to the user.** No subagent can call `send_file`, and none changes `memory/`, `skills/` or any `ALFRED.md`. A hook denies those calls whenever they come from a subagent (the hook input carries `agent_id`), whatever its type, so a forked skill is held to the same rules as a role. The roles also go without `Agent` and `TaskStop`. The workspace guard applies to subagents as it does to Alfred.
- **Review.** The system prompt says when to delegate and when not to, what a self-contained brief holds, and how Alfred checks a result before replying: it answers the brief, at least one cited source is opened to confirm it, and the files it names exist. A result that falls short gets one more round with the same role. If it still falls short, Alfred replies with what it has and says what is missing.
- **Spend.** `ALFRED_MAX_BUDGET_USD` (per query, default $10) covers subagent calls too, and the image cap of `generate_image` is per task across subagents. `ALFRED_DAILY_BUDGET_USD` (default $20) is the budget: once the day's spend reaches it, no new task or background subagent starts until the next day in the owner's time zone, and running ones finish. At the end of each task the log line `agent run done` breaks the spend down per model (`models=[...]`), from the SDK's `modelUsage`. A background subagent's card shows its spend so far (`≈`), updated as it works: the usage of its own responses, read from its transcript, priced at the rate its model's `modelUsage` implies. Calls its tools make on another model (WebFetch summaries, for one) count only toward the task. The task's card and the spend totals already include its subagents.
- **Tracking.** `/status` and the progress note list foreground subagents from the SDK's `task_started` and `task_notification` messages, so a forked skill shows up while it runs.
- `/stop` interrupts the main agent's current turn only (`interrupt()`; `perTaskStopAffordance` makes an interrupt spare the background subagents), so they keep running and report as usual. The reply names them: `已停止当前任务。后台运行 <id>、<id> 仍在继续，发 /stop <id> 停止。` `/stop <run id>` stops one background subagent (`stopTask`) or drops it from the queue. Only the 10-second fallback (a turn that does not end after an interrupt) and a shutdown end the Claude Code process, and the subagents inside it with it.
- **Restarts.** On SIGTERM Alfred stops every task before it exits, so the container never waits for `StopTimeout`. The task's run and its live or queued subagents are recorded as lost. After a crash, runs still marked live are marked lost at startup. Either way, the owner's next message gets one line naming them (`Alfred 重启时中断了 2 个任务：…`).

### Agent sandbox

- Built-in tools: `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, `Skill` for skills, and `Agent` and `TaskStop` for subagents (above). No shell.
- Custom tools: `send_file` (deliver a workspace file to WeChat; images arrive as image messages; refuses HTML), `move_file` (move or rename inside the workspace; deleting means moving into `.trash/`), `render_pdf` (Markdown or HTML to A4 PDF) and `generate_image` (MiniMax `image-01` through `mmx`).
- PDF rendering uses Playwright's standalone Chrome Headless Shell in `~/.cache/alfred/ms-playwright/`, never the installed Chrome. Every request the page makes goes through a route handler that serves only the source itself plus images, stylesheets and fonts whose real path (symlinks followed) is inside the workspace. Other local files, iframes, objects and embeds, network URLs and every other scheme except `data:` are refused, and a CSP plus disabled JavaScript back this up. So a report can neither pull a file from outside the workspace into the PDF nor leak anything over the network. Reference workspace images by relative path (a report in `reports/` can embed `../images/<date>/cover.jpg`); charts must be inline SVG.
- `generate_image` runs `mmx` without a shell, in its own process group, from the Alfred process rather than the agent's Claude Code subprocess. `/stop` or the 10-minute timeout kills the whole group. It uses the user's own Token Plan key. Output paths must resolve inside the workspace. Existing files and paths a running call will write are never overwritten; the default is `images/<date>/<slug>.jpg`. A task may request at most 4 images per call and 8 in total. Failed and timed-out calls count, because MiniMax bills them too, and the tool never retries. `mmx` errors, quota errors included, reach the agent verbatim, and every call is logged.
- A `PreToolUse` hook confines every file path to the workspace, following symlinks. Permission mode is `dontAsk`, so anything not listed is denied.
- The Claude Code subprocess gets a scrubbed environment and its own config dir, so it never loads the user's Claude Code settings, plugins or MCP servers. Claude Code's built-in auto memory is turned off (`autoMemoryEnabled: false`) for tasks and memory scans; long-term memory is Alfred's own (see above).
- Spend is capped per query at `ALFRED_MAX_BUDGET_USD` (default $10), follow-up turns and background subagents included; once it is reached, the task stops and any follow-up still waiting fails at once without spending. The daily cap `ALFRED_DAILY_BUDGET_USD` (default $20) stops new work for the rest of the day. Model round-trips are capped at 60 per turn, so a follow-up that starts a turn of its own gets a fresh 60.
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
| `$XDG_STATE_HOME/alfred/` (default `~/.local/state/alfred/`, override with `ALFRED_STATE_DIR`) | `account.json` (bot token), `sync.json` (poll cursor), `context-tokens.json`, `agent-state.json` (active and previous session, model and spend per user), `memory-scan.json` (transcript offsets and extraction spend), `memory.lock` (held while a task or memory scan runs), `events/events.jsonl` (the append-only event log for clients: one line per durable event, ids increase, kept for good), `api/alfred.sock` (the command API's socket while Alfred runs); files are mode 600 |
| `$XDG_STATE_HOME/alfred/claude/` | isolated Claude Code config dir: agent session transcripts used for resume |
| `$XDG_STATE_HOME/alfred/workspace-plugin/` | the `workspace` skills plugin: a manifest and the `skills` symlink into the workspace, recreated at startup |
| `$XDG_STATE_HOME/alfred/workbench/` | what the workbench reads: `runs.jsonl` (one line per finished run, kept for good), `runs/<id>.json` (live and recent runs with their steps, kept 30 days), `status.json` (heartbeat), `alfred.log` (the log, rotated at 5 MB to `alfred.log.1`) |
| `~/Alfred/` (override with `ALFRED_WORKSPACE`) | `ALFRED.md` (workspace rules), `inbox/`, `reports/`, `notes/`, `images/`, `memory/` (long-term memory), `skills/` (the owner's skills), `.trash/` |
| `$XDG_CACHE_HOME/alfred/ms-playwright/` (default `~/.cache/…`, override with `PLAYWRIGHT_BROWSERS_PATH`) | Chrome Headless Shell for PDF rendering |

| Variable | Default | Purpose |
| --- | --- | --- |
| `ALFRED_LOG` | `info` | `debug` logs every request (credentials redacted) and the agent's stderr |
| `ALFRED_MAX_BUDGET_USD` | `10` | spend cap per query, follow-up turns and background subagents included |
| `ALFRED_DAILY_BUDGET_USD` | `20` | spend per day (owner's time zone) after which no new task or background subagent starts; must be a finite number > 0 |
| `ALFRED_SESSION_IDLE_HOURS` | `4` | idle hours after which the next task starts a new session; `0` disables rotation, empty means the default, anything else that is not a finite number >= 0 fails at startup |
| `ALFRED_ANTHROPIC_API_KEY` | none, required | Anthropic API key for tasks and memory scans; inherited `ANTHROPIC_*` variables are ignored |
| `ALFRED_MMX_BIN` | `$CLAUDE_CONFIG_DIR/skills/mmx/bin/mmx` (`~/.claude/…` when unset) | `mmx` executable for `generate_image`; if it is missing, the tool returns an error |
| `ALFRED_MEMORY_SCAN_MINUTES` | `60` | interval between background memory scans; `0` turns automatic scans off (`npm run memory-scan` still works); empty means the default, anything else that is not a finite number of minutes from 0 to 35791 fails at startup |
| `ALFRED_MEMORY_SCAN_BUDGET_USD` | `0.1` | spend cap for one memory scan; must be a finite number > 0 |
| `ALFRED_API_SOCKET` | `$STATE_DIR/api/alfred.sock` | the command API's Unix socket (see Command API); `off` disables the API |
| `ALFRED_WORKBENCH` | off | `on` when a workbench is deployed: the agent is told HTML reports can be read there |
| `ALFRED_WORKBENCH_URL` | none | the workbench's https base URL, for card links in WeChat replies; implies `ALFRED_WORKBENCH=on` |
| `ALFRED_WORKBENCH_LISTEN` | `127.0.0.1:8787` | the workbench's TCP listener (`host:port`, or `off`); needs the three Access variables below unless `--dev` |
| `ALFRED_WORKBENCH_SOCKET` | none | the workbench's Unix socket for the SSH-tunnel fallback |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `ALFRED_WORKBENCH_OWNER_EMAIL` | none | the Access team domain, the application's AUD tag and the one email allowed in |

## Layout

```
src/ilink/          iLink protocol client: HTTP, QR login, CDN crypto, message shapes
src/bot.ts          long-poll loop, owner filter, typing indicator
src/channels.ts     the channel boundary (`Outbound`, `Inbound`), the app channel, and the recording of every message as an event
src/channels/wechat.ts  the WeChat channel: iLink messages in (media saved), replies, files and typing out
src/events.ts       the append-only event log clients read
src/api/            the client API: schema (events and commands), the command API server on a Unix socket, and the client behind the `api` commands
src/agent/          Agent SDK handler (intake queue, routing, stop), live task input, options, workspace guard, ALFRED.md rules, skill plugins, custom tools, image generation, session lifecycle, long-term memory, persisted state
src/echo.ts         PoC handler and protocol test commands
src/files.ts        inbound media storage and file helpers
src/pdf.ts          Markdown/HTML to PDF rendering
src/runs.ts         run ids and records, the heartbeat: what the workbench reads
src/workbench/      the read-only workbench: server, Access check, pages, safe Markdown
src/cli.ts          login | run | push | status | setup-pdf | pdf | memory-scan | workbench | api
plugin/             the baked skills plugin `alfred`
scripts/agent-smoke.ts  local agent run without WeChat
```

## Development

```bash
npm run check   # type-check
npm test        # unit tests
npm run smoke -- --model haiku "prompt"   # one agent run with production options, WeChat tools stubbed
npm run smoke -- --model haiku --steer-after 20 "only look at Y" "prompt"   # push a follow-up mid-run
npm run smoke -- --stop-after 30 "prompt"      # abort mid-run, as /stop does, and check no Claude Code process is left
npm run smoke -- --no-subagents "prompt"       # the same run without the Agent tool, to compare spend
npm run smoke -- --skills "prompt"             # also print the skills the session lists
node scripts/handler-smoke.ts background       # the real message handler with a fake WeChat client: three parallel collectors
node scripts/handler-smoke.ts restart          # a shutdown while a subagent runs, then the lost-runs note
node scripts/handler-smoke.ts undelivered      # replies fail as after the push window closes, then the note
node scripts/handler-smoke.ts stop             # two background collectors, then /stop <run id> for one of them
node scripts/handler-smoke.ts nested           # a general-purpose subagent starts three background collectors
node scripts/handler-smoke.ts channels         # WeChat starts a run, the app steers it and starts the next; a pass or fail line per routing rule
node scripts/handler-smoke.ts api              # the real handler behind the command API on a temp socket, driven over HTTP only; a pass or fail line per check
node scripts/handler-smoke.ts prompt "text"    # one message through the real handler, then the spend per model
```

The handler smoke script prints every WeChat send (`[wechat]`) and every message event (`[event]`: channel, direction, run id, the start of the text). The agent smoke script marks lines from inside a subagent with `[sub <id>]`, prints the SDK's `task_*` messages and the subagents still running after each tool result, and ends with the spend per model. `[first-request]` gives the first request's input tokens, to compare the prompt prefix across changes.

- The smoke script uses the real workspace and agent config dir. Point `ALFRED_WORKSPACE` and `ALFRED_STATE_DIR` at scratch directories to keep test runs out of them. Like the bot, it seeds the workspace and the workspace skills plugin, and prints the change notice for `ALFRED.md` files and skills (`[notice]`); rule disclosures show up as `disclosed … after <tool>` log lines. `npm run memory-scan` also reads transcripts from `$ALFRED_STATE_DIR/claude/projects/` and writes into `$ALFRED_WORKSPACE/memory/`, so point it at scratch directories the same way.
- Do not start a second `npm start` against the same state dir while the bot is running. Both processes would long-poll the same cursor and take messages from each other.

## Protocol source

There is no public iLink documentation site. The client follows the protocol notes and MIT-licensed reference implementation in [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) (v2.4.9); see `NOTICE`. The server contract may change without notice.

## License

MIT, see `LICENSE`. The iLink client under `src/ilink/` is ported from openclaw-weixin, also MIT; its notice is in `NOTICE`.
