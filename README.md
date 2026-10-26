# Alfred

A personal research assistant: web research, material collection and file organization, driven by the Claude Agent SDK. The owner talks to it through a native iOS app, which pairs with the workbench (below) and reaches Alfred through it. Alfred itself listens on a local Unix socket only, so it opens no port.

## Requirements

- Node.js 24+ (runs TypeScript directly, no build step)
- The Alfred app (`ios/`), paired with the workbench (see Workbench), to talk to it
- An Anthropic API key in `ALFRED_ANTHROPIC_API_KEY`. Give Alfred a key of its own, in a Console workspace with a spend limit, so a leaked key costs at most that limit and can be revoked without touching anything else
- Optional, for image generation: the [`mmx`](https://www.npmjs.com/package/mmx-cli) CLI with a MiniMax Token Plan key in its config file, `~/.mmx/config.json` or `$MMX_CONFIG_DIR/config.json` (check with `mmx quota show`)

## Usage

```bash
npm install
npm run setup:pdf  # one-time: download Chrome Headless Shell (~99 MB) for PDF rendering
npm start       # run the assistant: the agent behind the command API the app reaches, and memory scans
npm run status  # whether it runs: its API socket and its last heartbeat
npm run smoke -- --model haiku "prompt"      # run one prompt through the agent locally, without the app
npm run memory-scan                          # extract long-term memories from new transcript entries now
node src/cli.ts pdf report.md                # render Markdown or HTML to PDF locally; local images load from the workspace, or only from the source's directory for files outside it
```

`npm start` needs the command API (see Command API), the only way in, and refuses to start with `ALFRED_API_SOCKET=off`. The owner is whoever holds a paired device (see Workbench); Alfred has no other account or login of its own.

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
- Stop any other `npm start` instance first: a second Alfred on the same state dir takes over the socket and runs tasks on the same sessions.
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
install -Dm644 deploy/alfred.container ~/.config/containers/systemd/alfred.container
systemctl --user daemon-reload && systemctl --user start alfred
```

- Alfred has no login: once it runs, set up the workbench below and pair the app.
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

A read-only web page for following Alfred's work: one card per run with live progress and the files it wrote, the workspace with Markdown, image and PDF preview, HTML reports, spend, session transcripts, memory and logs. You talk to Alfred from the native app, through `/api/` (below). The pages never send anything to Alfred, and Alfred never reads from the workbench.

- **Runs.** Every task (and every memory scan that called the model) is a run with a short id such as `k7m2qa`.
  - The id shows on its card, with a button that copies it, in `/status` and in the logs.
  - A reply from a run that wrote files ends with the id, or with a link to the card when `ALFRED_WORKBENCH_URL` is set.
  - Paste an id into a message ("把 k7m2qa 的报告改成英文") and the run's title, status and file list are added to the prompt.
- **HTML reports** open in a sandboxed frame. Inline scripts, styles and SVG run, so charts draw, but the frame has an opaque origin and a policy that blocks every request, so a report can neither read the workbench nor send anything out. Workspace images are inlined as `data:` URIs. With `ALFRED_WORKBENCH=on` (or a URL), the agent is told that HTML reports can be read here and need a PDF only when you want one.
- **Read-only.** Every page answers only `GET` (`/api/` is the app's way in, below). The workbench reads `$ALFRED_STATE_DIR/workbench/` (`runs.jsonl` for good, `runs/<id>.json` with the step timeline for 30 days, `status.json` as the heartbeat, `alfred.log`), the transcripts under `claude/projects/`, and the workspace. All output is escaped, Markdown renders without raw HTML, paths are confined to the workspace, and HTML and SVG files download instead of opening outside the report viewer.
- **Two listeners.** TCP (`ALFRED_WORKBENCH_LISTEN`, default `127.0.0.1:8787`) is for a Cloudflare tunnel. Every request there needs a valid `Cf-Access-Jwt-Assertion`: an RS256 signature from the team's keys, the application's AUD tag, the team's issuer, a token that has not expired, and the owner's email. A Unix socket (`ALFRED_WORKBENCH_SOCKET`, created 0600) needs no Access token (`/api/` still wants a device token), for an SSH tunnel: `ssh -N -L 8787:/home/<user>/data/workbench-socket/workbench.sock <host>`, then open `http://localhost:8787`.
- **App access.** The native app calls `/api/` on the workbench; the pages stay the owner's. `/api/` takes `GET` and `POST`, its errors are JSON (`{"error": "…"}`) and never cached. Two checks come first, in order:
  - **Access.** On the tunnel, `/api/` takes the owner's `Cf-Access-Jwt-Assertion` or the one of the app's Access service token, whose `common_name` is the token's client id (`CF_ACCESS_SERVICE_CLIENT_ID`) and which has no email. Either must still pass the signature, AUD, issuer and expiry checks above; otherwise 403. A service-token JWT gets 403 on every page, and without `CF_ACCESS_SERVICE_CLIENT_ID` service tokens are refused.
  - **Device token.** On every listener, the socket and `--dev` included, the request needs `Authorization: Bearer <device token>` of a paired, unrevoked device. A missing, malformed, unknown or revoked token gets 401 with `WWW-Authenticate: Bearer`. Refusals are logged with their reason, never with a token.

  After those checks, the routes (a method a route does not take gets 405 with `Allow`; an unknown path gets 404):
  - `GET /api/ping` answers 204.
  - `POST /api/commands` takes a command as the Command API does (`message.send`, `run.stop`, `question.answer` and the task commands). It is checked with `parseCommand` first: a body that is not `application/json`, not JSON or not a valid command gets 400 `{"error": "…"}` and nothing is sent. A valid command goes to Alfred's socket, and Alfred's status and body come back unchanged. Over 65,536 bytes is 413.
  - `GET /api/events` relays Alfred's event stream as it arrives, passing on `Last-Event-ID` or `?after=`. A client that goes away closes Alfred's request; when Alfred ends or breaks the stream, the response ends. When the workbench stops, it ends open event streams at once, gives other requests up to 2 s, then closes the remaining connections.
  - `POST /api/uploads?name=<name>` streams the body to Alfred's `/uploads` and relays the answer. A declared length over 52,428,800 bytes is 413 before anything is sent; an undeclared one is cut with 413 once it passes that limit.
  - `GET /api/runs` answers `RunList`: the 100 newest runs, newest first, with only the fields the client shows.
  - `GET /api/runs/<id>` answers `RunDetail`: the run and its steps. An unknown or malformed id is 404.
  - `GET /api/tasks` answers `TaskList`: the time zone the schedules are computed in, and the tasks the store keeps in `tasks.json`; with no such file there are no tasks. A file that does not fit answers 500 and is logged.
  - `GET /api/tasks/<id>` answers `TaskDetail`: the task and its 50 newest runs, newest first. A malformed or unknown id is 404 `{"error": "There is no such task."}`.
  - `GET /api/files/<path>` streams a workspace file's bytes, typed by extension as the pages type them, under `Content-Security-Policy: sandbox`. An HTML report (`.html`, `.htm`) comes with its workspace images inlined as `data:` URIs, under the report page's caps; a report over 4 MiB comes as it is. A missing path, a directory, a path outside the workspace and a `..` segment are all 404.
  - `POST /api/push` takes the app's APNs registration, `{"token": "<hex>", "environment": "development" | "production"}`, and stores it on the device's record in `devices.json`, replacing an earlier one; it answers 204. A body that does not fit is 400 `{"error": "…"}`, and one over 4,096 bytes is 413.
  - While Alfred's socket cannot be reached (Alfred restarting, or the API off), the three forwarding routes answer 503 `{"error": "…"}`, and the app retries.

  The socket is `ALFRED_API_SOCKET` (`deploy/workbench.container` mounts its directory read-only). The workbench holds no Alfred secret and forwards only the command set.
- **Pairing.** `node src/cli.ts pair [--name <name>]` (name default `iPhone`) creates a device and shows one QR code with the server URL (`ALFRED_WORKBENCH_URL`, an `https://` origin, or `http://127.0.0.1` or `http://localhost` with any port for local work), the Access service token (`CF_ACCESS_SERVICE_CLIENT_ID` and `CF_ACCESS_SERVICE_CLIENT_SECRET`) and the new device's token, so one scan sets the app up. The tokens appear nowhere but in the QR code; `--json` prints the same pairing as JSON instead, for scripts. On the host: `podman exec -it workbench node src/cli.ts pair --name <name>`.
- **Revoking.** `node src/cli.ts devices` lists the devices with their ids, names, creation and revocation times, and `devices revoke <id>` locks one out. The workbench re-reads `devices.json` when the file changes, so the next request from that device is refused, with no restart. The file keeps only a SHA-256 of each device token, so a token lost with its phone cannot be read back: revoke the device and pair again.
- **Push.** A paired phone with a registration gets a notification through APNs when Alfred sends a message in the app and when Alfred asks a question (below), even with the app closed. Nothing else pushes, and a message of the retired WeChat channel that is still in the event log never does. A `development` registration goes to APNs's sandbox, a `production` one to production. The title is `Alfred`, and the body is the text cut to its first 100 characters, with `…` after them when it is longer. A file-only message reads `文件：<first file's name>`. A question reads `Alfred 想问你：` and its first question, cut the same way; the answer pushes nothing. The notification also carries `eventId`, and `runId` when the message has one, so the app can open the right place. Inside `workbench`, a dispatcher follows Alfred's `/events` from the cursor in `push-cursor.json`. With no cursor it starts after the latest event, so old events never push, and the cursor is saved after each event, so a restart pushes nothing twice. A token APNs reports dead (410, or 400 `BadDeviceToken`) is removed from its device's registration; any other refusal is logged and not retried. The provider token is an ES256 JWT signed with the `.p8` key and renewed every 50 minutes. With any one of the four `ALFRED_APNS_*` variables missing, push is off and the workbench logs which one. `node src/cli.ts apns-test [text]` sends one test notification to every registered device and prints each device's answer; on the host: `podman exec -it workbench node src/cli.ts apns-test`.
- `node src/cli.ts workbench --dev` serves on loopback without the Access check, for local testing. `/api/` still wants a device token there.

On the host, the workbench and a dedicated `cloudflared` run in their own pod (`deploy/workbench.pod`, `workbench.container`, `workbench-tunnel.container`). They use the Alfred image, so `deploy/update.sh` restarts the workbench after an update. In the Cloudflare dashboard, create a remotely managed tunnel whose public hostname points at `http://localhost:8787`, and an Access application on that hostname that allows only your email. Then:

```bash
mkdir -p ~/data/state/workbench ~/data/state/api ~/data/state/claude/projects ~/data/workbench-socket ~/data/workbench-app ~/.config/alfred
read -rs TOKEN && printf %s "$TOKEN" | podman secret create workbench_tunnel_token - && unset TOKEN   # the tunnel token
cat > ~/.config/alfred/workbench.env <<'ENV'
CF_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com
CF_ACCESS_AUD=<the Access application's AUD tag>
ALFRED_WORKBENCH_OWNER_EMAIL=<your email>
# For the app:
CF_ACCESS_SERVICE_CLIENT_ID=<the service token's client id, ending in .access>
CF_ACCESS_SERVICE_CLIENT_SECRET=<its client secret>
ALFRED_WORKBENCH_URL=https://<hostname>
# For push (APNs), with the .p8 key below as the alfred_apns_key secret:
ALFRED_APNS_KEY_ID=<the APNs key's id>
ALFRED_APNS_TEAM_ID=<your Apple team id>
ALFRED_APNS_TOPIC=<the app's bundle id>
ENV
podman secret create alfred_apns_key <path to AuthKey_<key id>.p8>
install -m644 deploy/workbench.pod deploy/workbench.container deploy/workbench-tunnel.container ~/.config/containers/systemd/
systemctl --user daemon-reload && systemctl --user start workbench-pod
```

- For the app, create a service token in Cloudflare Zero Trust (Access, Service Auth), add a policy with the Service Auth action that includes it to the Access application, and put its client id and secret in `workbench.env` as above. Then pair with `podman exec -it workbench node src/cli.ts pair --name <name>`.
- The workbench container mounts only what it shows, read-only: the rest of the state dir is not mounted. The one exception is the directory of Alfred's command socket (`~/data/state/api`), which `/api/` forwards to. Its root filesystem is read-only too, and two directories are writable: the socket directory and `~/data/workbench-app`, where `devices.json` lives.
- Once the workbench is up, set `Environment=ALFRED_WORKBENCH=on` for Alfred in a drop-in such as `~/.config/containers/systemd/alfred.container.d/workbench.conf` (under `[Container]`, as above), not in `alfred.container` itself, then `systemctl --user daemon-reload` and `deploy/update.sh --restart`. Add `Environment=ALFRED_WORKBENCH_URL=https://<hostname>` there to put card links in replies, when the device that opens them gets through the Access sign-in; leave it unset otherwise, and replies carry the run id only.

### In the app

Send a task as text. Photos and files go with a message (the app uploads them to `~/Alfred/inbox/<date>/` first, see Command API); files sent without text are saved and attached to your next text message. Replies stream in as they are written. Alfred delivers long results as Markdown files, a report with charts as a self-contained HTML file that the app opens in a sandbox, a PDF only when you ask for one or the document is meant to be kept or forwarded, and generates images on request.

| Command | Effect |
| --- | --- |
| `/new` | start a new session (drops the conversation context; `/resume` brings it back) |
| `/resume` | switch back to the previous session for the next task; send it again to switch back |
| `/stop [run id]` | interrupt the turn the agent is on (below); with a run id, stop only that background subagent or take it out of the queue |
| `/model [sonnet\|opus\|haiku]` | show or switch the model; default `sonnet`. During a task the switch applies from its next turn (subagent roles keep their default models) |
| `/memory` | list long-term memories |
| `/status` | model, session age and idle time, when it rotates, spend today against the daily cap, current task, background and queued subagents, pending follow-ups, the task run in progress, and each active task with its next run |
| `/help` | command list |

One task runs at a time, and you can steer it while it runs ("别查 X 了，重点看 Y"):

- A message sent during a task is acknowledged (`收到，会在当前步骤结束后转给 Alfred。`) and handed to the running agent at the next step boundary, once the current model call and its tool calls finish. A tool call in flight is not interrupted. Files sent mid-task travel with the next text message.
- If the agent is still working through tool calls, the follow-up joins the current turn and one reply answers both. If it was already writing its final answer, the follow-up runs as its own turn right after, and each turn gets its own reply, sent as soon as it ends.
- `/status` lists the foreground subagents with their role, brief title and age. A run's progress shows on its card in the app (and on the workbench), and the reply text streams as it is written; no progress message is sent. Background subagents show their progress on their cards.
- Once every message has been answered and no background subagent is running or queued, the task ends. A message that arrives after that is queued and starts the next task, which resumes the same session.
- `/stop` (or the app's stop button, `run.stop`) interrupts the turn the agent is on (`Query.interrupt()`) and does not abort the task. The turn ends without a reply: neither its text nor an error line. Alfred answers `已停止当前任务。`, and when background subagents are still running or queued, `已停止当前任务。后台运行 <id>、<id> 仍在继续，发 /stop <id> 停止。` Follow-ups already handed to the task and messages queued behind it are kept and answered afterwards. The task ends as stopped when the interrupted turn was its last, with nothing left to answer and no background subagent running; otherwise it goes on and ends as usual. If the turn has not ended 10 seconds after the interrupt, the task is aborted instead (logged), which also drops its subagents and the follow-ups it has not answered.

Alfred can ask you a question mid-run, with a few options, instead of guessing (the SDK's `AskUserQuestion` tool, offered to the main agent only; the system prompt tells it to ask only when a choice between a few options blocks progress and it cannot decide). The app shows the question on a card in the timeline, from the `question.asked` event.

- **Answering.** The app answers each question with `question.answer` (see Command API). While a question is open, any message from you that is not a slash command also answers it, as free text: the text, trimmed, is the answer to every question of the ask, and a bare number is text like any other. It is recorded as usual, with the run's id, and is not acknowledged or handed to the agent as a follow-up. A message with only a file does not answer.
- **Waiting.** The run waits for the answer with no timeout, and the question pushes a notification to the app (see Workbench). The call is held in a `PreToolUse` hook for `AskUserQuestion`, not in `canUseTool`: under `dontAsk` the CLI denies the tool before `canUseTool` is asked, so the hook answers it with `permissionDecision: "allow"` and the answers added to the tool's input. Its matcher sets a timeout of a week, because the SDK's default for a hook is 10 minutes. The CLI also offers the tool only when a `canUseTool` is set, so the options carry one that denies everything; it is never asked in practice, and the SDK logs its `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning at each run's start because of it. A subagent's call is denied at once ("tell the main agent what you need to know, and it will ask").
- **Cancelling.** `/stop` (or `run.stop` for the run) cancels the open question: `question.answered` is recorded with `cancelled: true`, the call is denied with "The user stopped the run", and the turn is interrupted as above. So does the interrupt's abort signal reaching the held call, the end of the run, and shutdown.

### The app channel

The handler has one channel, the app, whose only client is the command API below. It calls the handler's `submit`, `stopRun` and `answerQuestion` (see `src/channels.ts`).

- One intake queue takes the owner's messages in arrival order, with the steer, queue and command rules above.
- A message can carry files: they are uploaded to the inbox first and named by the message (see Command API). They are attached to the next text message, and a message with files and no text is answered `已保存 …，告诉我要怎么处理。`.
- A run answers the owner: the final reply, files from `send_file` and background subagent reports. A command's reply and the notices a message triggers (acknowledgements, runs a restart cut short, the daily cap, changed rules) are messages of their own.
- Every message in either direction is recorded in the event log as `message.created`: channel, direction, text, files, the run it started, steered or came from, and for a message from the owner its client id. On the app channel the event is the delivery. The log still holds the messages recorded on the `wechat` channel before it was retired, and the contract and the app still read them; nothing is written to that channel any more.
- The note a message triggers (the runs a restart cut short) is recorded after that message, so in the log the owner's `message.created` comes first.
- A question the main agent asks is recorded as `question.asked` (its id, the run, and the questions with their options), and its end as `question.answered` (the answers by question text, or `cancelled: true` with none). The event is the whole delivery. The app can follow the open ones by id: asked adds, answered removes.
- A run also publishes live events, which are told to whoever is following the stream and never stored (see Command API): the main agent's reply text as it is written (`message.delta`) and each step the run records (`run.step`).

### Command API

A process on the same host can send the owner's commands to Alfred and follow its events over a Unix socket. `node src/cli.ts run` serves it and closes it at shutdown before the handler stops its runs. There is no TCP listener.

- **Socket.** `ALFRED_API_SOCKET`, by default `$STATE_DIR/api/alfred.sock`; `off` disables the API. The socket is mode 0600, and a directory created for it is 0700 (one that exists is left as it is). A socket file left by a crash is removed at start.
- **`POST /commands`** takes `Content-Type: application/json` and a body of at most 65,536 bytes, which gets 413 as soon as the limit is crossed. A wrong content type, invalid JSON or a command `parseCommand` (`src/api/schema.ts`) rejects gets 400 `{"error": "…"}`, and nothing reaches the handler.
  - `{"type": "message.send", "clientId": "…", "text": "…", "files": [{"path": "inbox/…"}]}` submits the message on the app channel and answers 202 `{"accepted": true}`. A client id among the last 1000 accepted gets 200 `{"accepted": false, "duplicate": true}` and is not submitted again. Those ids are kept in memory: a restart forgets them. `text` may be `""` when `files` is given. `files` is optional, at most 10 entries, each a path inside the inbox (`inbox/…`) with an optional `kind`. Every file must be a regular file in the inbox, with symlinks followed: otherwise the answer is 400 `{"error": "files.<n>.path: no such file in the inbox"}` (the first bad one) and nothing is submitted. The files are attached to the next text message, a message with files and no text is answered `已保存 …，告诉我要怎么处理。`, and the `message.created` event lists them.
  - `{"type": "question.answer", "questionId": "…", "answers": {"<question text>": "<answer>"}}` answers an open question: 202 `{"answered": true}`, 404 `{"error": "no open question <id>"}` when it is not open (never asked, already answered or cancelled), and 400 `{"error": "answers: … is not the text of one of the question's questions"}`, leaving the question open, for a key that is not one of its questions' texts. `answers` has at least one entry (a question of the ask may be left out), each value 1 to 2000 characters: an option's label, the labels of several joined with `, ` for a multi-select question, or free text. The answer is recorded as `question.answered`.
  - `{"type": "run.stop", "runId": "…"}` answers 202 `{"stopped": true}`, or 404 `{"error": "no live or queued run <id>"}`. For the task it interrupts the current turn, like `/stop` (see In the app); the reply `已停止当前任务。` arrives as a `message.created` event. For the live run of a scheduled task (see Tasks) it aborts the run, which ends stopped and says nothing more.
  - `{"type": "task.create", "title": "…", "brief": "…", "schedule": {…}, "model": "…", "budgetUsd": 2}` creates a task and answers 201 `{"task": …}`, the task as the store now holds it. `model` and `budgetUsd` are optional and take Alfred's defaults when omitted. The schedule is one of `{"kind": "once", "at": "<ISO time>"}`, `{"kind": "daily", "time": "HH:MM"}`, `{"kind": "weekly", "days": [1 to 7, 1 being Monday], "time": "HH:MM"}` or `{"kind": "interval", "hours": 1 to 168}`.
  - `{"type": "task.update", "taskId": "…", …}` changes at least one of `title`, `brief`, `schedule`, `model`, `budgetUsd` and `status` (`active`, `paused` or `done`), and answers 200 `{"task": …}`.
  - `{"type": "task.run", "taskId": "…"}` starts a run of the task now, or queues it behind the runs already waiting (see Tasks), without moving its next scheduled time: 202 `{"accepted": true}`, or 404 `{"error": "no task <id>"}`.
  - A create or update the store refuses answers the store's 400 or 404 with `{"error": "…"}`: a task made here has the origin `manual`, and a change the moment does not allow (such as a one-time task whose time has passed) is a 400 with the store's message. `src/cli.ts run` creates the one task store and passes it to the handler and, as these commands (`src/tasks/commands.ts`), to the API; `scripts/app-dev.ts` wires them the same way. An API started without them answers every task command 503 `{"error": "tasks are not available"}`.
- **`POST /uploads?name=<name>`** saves the body, the file's bytes, into `inbox/<local date>/`, for a message to name. `name` is required: trimmed, 1 to 255 characters, with no `/`, `\` or NUL, and not `.` or `..`; otherwise 400. The body is at most 52,428,800 bytes (50 MiB): a declared `Content-Length` over that is 413 before the body is read, and a body that grows past it is cut with 413. The file is saved under the name sanitized (path components and unsafe characters stripped, a hidden file or an `ALFRED.md` given a `_` prefix), made unique with a suffix (`name-1.ext`), written under a temporary name and renamed when complete, so an upload cut short leaves no file. It answers 201 `{"file": {"path": "inbox/<date>/<name>", "kind": "image"|"video"|"file"}}`: `image` for png, jpg, jpeg, gif, webp and heic, `video` for mp4 and mov, `file` for the rest. An upload records no event; the message that names the file does.
- **`GET /events`** streams `text/event-stream`. It starts after the `Last-Event-ID` header if there is one, else after `?after=<id>`, else from the start; anything but a non-negative integer gets 400. It sends the backlog first, then new events, with no gap and no repeat across the switch. Each durable event is `id: <id>`, `event: <type>` and `data: <the event as one line of JSON>`, and `: ping` goes out every 30 seconds. A reconnecting client sends the last id it saw.
- **Live events** go out on the same stream as `event: <type>` and `data: <one line of JSON: at, type, data>`, with no `id:` line, so a client's last id stays that of the last durable event. They are never stored, and a stream never replays them: one that happens while a stream is still sending its backlog is dropped for that stream, and a client that reconnects misses what happened meanwhile (the final reply is a `message.created` event, so nothing durable is lost).
  - `message.delta` (`runId`, `streamId`, `text`): a piece of the main agent's reply text. `streamId` is the API message's id and the index of the text block (`msg_01….1`): it is the same for every delta of one block and differs for the next. Subagents' text, thinking and tool input are not streamed.
  - `run.step` (`runId`, `step`): a step as it is recorded on the run's card. It carries the id of the run that took it: the task's for its own and its foreground subagents' steps (with `agent` set for the latter), a background subagent's own for its steps.
- **`GET /health`** answers `{"ok": true, "lastEventId": <n>}`. Other paths get 404, other methods 405.

```bash
node src/cli.ts api send "text"                 # POST message.send with a fresh client id; prints the status and body
node src/cli.ts api upload photo.jpg           # POST /uploads; prints the status and the file's inbox path
node src/cli.ts api send --file inbox/2026-10-26/photo.jpg "what is this?"   # a message that names an uploaded file
node src/cli.ts api stop k7m2qa                 # POST run.stop
node src/cli.ts api events --after 120          # the events after id 120, then exit
node src/cli.ts api events --follow             # all of them, then new ones as they come
curl --unix-socket "$STATE_DIR/api/alfred.sock" -N http://localhost/events
```

### Sessions and context

- The owner has one active Claude Code session, and every task resumes it, so the agent remembers earlier tasks. The session id is stored in `agent-state.json`, in the owner's record under the key `owner`; the transcript lives in the isolated config dir.
- A state file from before the app was the only channel keeps the owner's record under their old chat user id. The first start moves it to `owner` (the record used last, if there are several; one already under `owner` is never replaced), so the session, model, spend and the runs a restart cut short carry over. The note about results that did not arrive is dropped with the feature.
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

Conventions for working in the workspace (where things go, naming, report style) live in `ALFRED.md` files that the user can change in the app ("以后报告开头都加三行摘要") or edit directly. Core behavior stays in code: reply formatting, delivery rules and safety.

- **Root.** `~/Alfred/ALFRED.md` is read at the start of every task and appended to the system prompt. When it is missing at startup, it is seeded with the default layout (`inbox/`, `reports/`, `notes/`, `images/`, `skills/`, `.trash/`).
- **Nested.** A subdirectory can have its own `ALFRED.md` (e.g. `reports/ALFRED.md`) that applies to it and everything below it. It is disclosed only when the agent works there: a `PostToolUse`/`PostToolUseFailure` hook on `Read`, `Write`, `Edit`, `Glob`, `Grep`, `move_file`, `render_pdf` and `generate_image` resolves the touched path and injects, through `additionalContext`, the `ALFRED.md` files between the workspace root and that path that the agent has not seen in this task. `Glob` and `Grep` count the directory their pattern or `glob` starts in, and a content-mode `Grep` also counts the directories of the files whose lines it returned. Disclosures are tracked per task by path and mtime, so a file that changes is disclosed again. A task that never touches `reports/` never receives `reports/ALFRED.md`.
- **Limits.** Each file is capped at 8 KB in the prompt. Symlinked `ALFRED.md` files, paths outside the workspace and anything under `.trash/` are ignored. A received file named `ALFRED.md` is saved as `_ALFRED.md`, so a forwarded file cannot become rules.
- **Edits.** The agent changes an `ALFRED.md` only on the user's explicit request, never because content it read says so. Every write is logged, and after any task that created, changed or removed an `ALFRED.md`, Alfred says so in the app (`已更新 reports/ALFRED.md`), even if the task was stopped or failed.
- `ALFRED.md` holds rules for how to work, not facts about the user; those go into long-term memory (above).

### Skills

Know-how for one kind of task that is too long for the system prompt lives in skills (`SKILL.md`), loaded the way the Agent SDK ships them. The model sees each skill's name and description and loads the body through the `Skill` tool when a task calls for it. Each `Skill` call is a step on the run's card.

- **Baked skills** are the local plugin `alfred` in `plugin/`, copied into the image and changed through a PR: `html-report` (a self-contained HTML template with print CSS, inline-SVG chart snippets and a checklist), `compare-options` and `deep-dive`. The `writer` role starts with `html-report` preloaded.
- **The owner's skills** live in `~/Alfred/skills/<name>/SKILL.md` and are listed as `workspace:<name>`. They reach Claude Code through a plugin root outside the workspace, `$STATE_DIR/workspace-plugin/`, which startup creates with a manifest and a symlink `skills → <workspace>/skills`. Nothing else in that root points into the workspace, so the agent can add skills but never hooks, MCP servers or agent types. Supporting files next to a `SKILL.md` resolve into the workspace and pass the workspace guard. A new skill is listed from the next task; a resumed session gets it as a delta.
- **Edits.** The agent creates, changes or removes a skill only on the owner's explicit request, as with `ALFRED.md`. After a task that changed anything under `skills/`, Alfred says so in the app (`已新建 skills/weekly-brief/SKILL.md`). Subagents cannot write there. Where a skill conflicts with the request or an `ALFRED.md`, those win.
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
- **Tracking.** `/status` lists foreground subagents from the SDK's `task_started` and `task_notification` messages, so a forked skill shows up while it runs.
- `/stop` interrupts the main agent's current turn only (`interrupt()`; `perTaskStopAffordance` makes an interrupt spare the background subagents), so they keep running and report as usual. The reply names them: `已停止当前任务。后台运行 <id>、<id> 仍在继续，发 /stop <id> 停止。` `/stop <run id>` stops one background subagent (`stopTask`) or drops it from the queue. Only the 10-second fallback (a turn that does not end after an interrupt) and a shutdown end the Claude Code process, and the subagents inside it with it.
- **Restarts.** On SIGTERM Alfred stops every task before it exits, so the container never waits for `StopTimeout`. The task's run and its live or queued subagents are recorded as lost. After a crash, runs still marked live are marked lost at startup. Either way, the owner's next message gets one line naming them (`Alfred 重启时中断了 2 个任务：…`).

### Tasks

A task is a brief the agent runs on a schedule, without being asked each time. The app creates, changes and runs tasks through the task commands (see Command API), you can also set them up by talking to Alfred (below), and `workbench/tasks.json` holds them (see State and files).

- **From chat.** The main agent of a chat run has three tools, `task_list`, `task_create` and `task_update` (`src/agent/task-tools.ts`), when the handler has a task store. Their inputs are the fields of `task.create` and `task.update`, checked by the same rules, and a task made this way has the origin `chat`. A task run is not offered them, a subagent's call is denied (the subagent guard, as for `send_file`), and the system prompt gets a short Tasks section only when they are offered: create a task only when you ask for scheduled or recurring work, never on its own initiative; the tool returns once you answer, so say what it proposed and what happened, and do not repeat the question in text; name the time zone when it states a schedule; prefer `haiku` or `sonnet` and give a realistic per-run cap; pause or end a task on request without asking. Each tool returns one line for the agent to relay: what changed and the next run, or why nothing changed (the store's message for a change the moment does not allow, an unknown id, a declined or cancelled confirmation).
  - **What asks for your tap.** A new task, and a change of its `brief`, `schedule`, `model` or `budgetUsd`, or resuming it (`status` `active` on a task that is not), wait for you. Pausing, ending and a new title do not ask, and neither does a call that gives only values the task already has. So a page or file the agent reads can plant or change no recurring task on its own.
  - **The confirmation** is an ordinary structured question (see In the app) with the header `新任务` or `改任务` and two options, `确认` and `不要`, so it reaches the app as `question.asked` and is answered, cancelled and recorded as any other. Alfred writes its text from the arguments of the call, not the agent: the title, the schedule in words with the time zone, the model, the per-run cap and the brief (the first 300 characters, with its length when it is cut); for a change, only the changed fields, old → new. Only the answer `确认` applies the change (a message that says exactly 确认 is that answer too). `不要`, any other free text (a message of yours while it is open, which goes back to the agent as your words, even if it says "好的") and a cancel (a stop, or the end of the run) leave the task as it was. The tool waits as long as a question does: the tools' server sets the SDK's tool-call timeout to a week.

- **Schedules.** Once at a time, daily at a time, weekly on chosen weekdays at a time, or every N hours. Daily, weekly and one-time times are local times in the process's time zone, which is the owner's: `TZ` (`Asia/Taipei` in the container), the same zone the daily cap counts days in. A phone in another zone does not move a schedule, and a daylight-saving change does not move the time of day. There are no cron expressions.
- **Due and missed runs.** The handler asks the task store which runs are due once at startup, after the runs a restart cut short are marked lost, and then every 30 seconds. The store moves a task on to its next time as it hands a run over, so a run that a restart cut short is not run again. A run missed by up to 6 hours runs once; older misses are skipped, and several misses in a row run at most once. Skips are recorded on the task (`missed`, `daily-cap`) and shown in its detail, with no message and no push, except for the cap (below). A one-time task is done once its run is taken.
- **One at a time, beside the chat.** The due runs wait in a queue in the order they fell due, and one runs at a time. A task run neither waits for the chat nor stops it: the chat's run, queue, session, questions and model are untouched, and a message to Alfred gets a run of its own while a task run is live. A run now (`task.run`, the app's button) joins the same queue as a run due now and leaves the task's next scheduled time alone.
- **Unattended.** A task run is a run of kind `task` with the task's `taskId`, its title as the run title and the task's model (default `sonnet`). It goes through the same `execute` and `agentOptions` as a chat run, with these differences:
  - A new session with `persistSession: false`: nothing to resume, and no transcript, so a task run's session is never memory-scanned.
  - `maxBudgetUsd` is the task's per-run cap (default $2, at most $20), in place of `ALFRED_MAX_BUDGET_USD`.
  - `AskUserQuestion` and the task tools (From chat, above) are not offered: a run of a task manages no tasks.
  - Background `Agent` calls (`run_in_background`, which is the default of the call) are denied with a reason that tells the agent to call again with `run_in_background: false`; foreground subagents work as in chat.
  - `memory/`, `skills/` and every `ALFRED.md` are read-only. The workspace guard (`workspaceGuard` with its `readOnly` option) denies every writing tool that names such a path, in the run and in its subagents: `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, both paths of `move_file`, and the output of `render_pdf` (its default included) and `generate_image`. Reading them is fine, and the denial tells the agent to say in its report what should change.
  - The first message is a short preamble and then the task's brief. The preamble names the task (title and id) and the time it was due in the owner's zone, says the owner is not watching (ask no questions, make assumptions and state them in the report), asks for the report under `reports/tasks/<task id>/` and for it to be sent with `send_file`, and names the previous report: the newest file in that directory, if there is one.
- **Spend.** A task run's cost is on its run record and goes into the owner's day and total, so it counts toward `ALFRED_DAILY_BUDGET_USD`. It does not count toward the chat session's figures or move its idle clock. When a run comes up and the day's spend has reached the cap, it does not start: a scheduled occurrence is recorded on the task as skipped (`daily-cap`), and for it and for a run now one message with the task's id says the task was due and the cap is reached, with what was spent. That message pushes, since the owner is waiting for the report.
- **Delivery.** Everything the run says, its final reply and the files it sends with `send_file`, is recorded as a `message.created` with the run's id and the task's id. The push dispatcher pushes it like any reply, and the app labels it with the task. Every run pushes: there is no quiet mode. A run that ends with an error result, by its budget cap (`error_max_budget_usd`) or by an error ends failed, and posts one message saying what happened. `run.stop` (or `/stop <run id>`) aborts a task run: it ends stopped and posts nothing more. A task run live at a shutdown is recorded as lost, and one live at a crash is marked lost at the next start, as chat runs are; either way its occurrence is not run again.
- **The chat hears of it.** Each task run that delivered a reply is kept in the owner's record (`taskDeliveries` in `agent-state.json`): task id and title, run id, time, the first line of the reply and the paths of the files it sent; the 20 newest are kept. The owner's next message to the chat gets a section listing them, as data, in its prompt, and the list is cleared. A command, or the answer to a question, leaves the list for the next message. Without a delivery the prompt is unchanged. A failed run is not a delivery.
- **Queued occurrences.** A scheduled occurrence waits in the queue behind the run that is live. When it comes up and its task has been paused since, or ended (`done`) when its schedule is not a one-time one, it does not run: it is logged and dropped, with no skip recorded and no message. A one-time task is `done` by then in any case, because the store marks it done as its run falls due, so it still runs. A run now is not affected.
- **Shutdown.** It stops a live task run, empties the queue of task runs and stops the 30-second timer. A chat message queued behind the live chat run starts no run once the shutdown has begun.

### Agent sandbox

- Built-in tools: `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, `Skill` for skills, and `Agent` and `TaskStop` for subagents (above). No shell.
- Custom tools: `send_file` (deliver a workspace file to the owner in the app; images arrive as images; an HTML report is sent as it is, and the app opens it in a sandbox where inline scripts and SVG charts work, with no network), `move_file` (move or rename inside the workspace; deleting means moving into `.trash/`), `render_pdf` (Markdown or HTML to A4 PDF) and `generate_image` (MiniMax `image-01` through `mmx`). Each one stops when its run is stopped and when its own call is interrupted by `/stop`: a `send_file` or `move_file` not yet done does nothing, `render_pdf` closes its browser, and `generate_image` kills its `mmx` process group. A send that has started runs to the end.
- PDF rendering uses Playwright's standalone Chrome Headless Shell in `~/.cache/alfred/ms-playwright/`, never the installed Chrome. Every request the page makes goes through a route handler that serves only the source itself plus images, stylesheets and fonts whose real path (symlinks followed) is inside the workspace. Other local files, iframes, objects and embeds, network URLs and every other scheme except `data:` are refused, and a CSP plus disabled JavaScript back this up. So a report can neither pull a file from outside the workspace into the PDF nor leak anything over the network. Reference workspace images by relative path (a report in `reports/` can embed `../images/<date>/cover.jpg`); charts must be inline SVG.
- `generate_image` runs `mmx` without a shell, in its own process group, from the Alfred process rather than the agent's Claude Code subprocess. `/stop` or the 10-minute timeout kills the whole group. It uses the user's own Token Plan key. Output paths must resolve inside the workspace. Existing files and paths a running call will write are never overwritten; the default is `images/<date>/<slug>.jpg`. A task may request at most 4 images per call and 8 in total. Failed and timed-out calls count, because MiniMax bills them too, and the tool never retries. `mmx` errors, quota errors included, reach the agent verbatim, and every call is logged.
- A `PreToolUse` hook confines every file path to the workspace, following symlinks; for a task run it also keeps `memory/`, `skills/` and the `ALFRED.md` files read-only (see Tasks). Permission mode is `dontAsk`, so anything not listed is denied.
- The Claude Code subprocess gets a scrubbed environment and its own config dir, so it never loads the user's Claude Code settings, plugins or MCP servers. Claude Code's built-in auto memory is turned off (`autoMemoryEnabled: false`) for tasks and memory scans; long-term memory is Alfred's own (see above).
- Spend is capped per query at `ALFRED_MAX_BUDGET_USD` (default $10), follow-up turns and background subagents included; once it is reached, the task stops and any follow-up still waiting fails at once without spending. A scheduled task run has its own cap instead, the task's budget (see Tasks). The daily cap `ALFRED_DAILY_BUDGET_USD` (default $20) stops new work for the rest of the day, task runs included. Model round-trips are capped at 60 per turn, so a follow-up that starts a turn of its own gets a fresh 60.
- Residual risk: `WebFetch` can reach any URL, so a malicious page could try to make the agent leak workspace content through a request. Keep secrets out of the workspace.

## State and files

| Path | Content |
| --- | --- |
| `$XDG_STATE_HOME/alfred/` (default `~/.local/state/alfred/`, override with `ALFRED_STATE_DIR`) | `agent-state.json` (the owner's record, under the key `owner`: active and previous session, model, spend, and the task runs delivered since the owner's last message), `memory-scan.json` (transcript offsets and extraction spend), `memory.lock` (held while a task or memory scan runs), `events/events.jsonl` (the append-only event log for clients: one line per durable event, ids increase, kept for good), `api/alfred.sock` (the command API's socket while Alfred runs); files are mode 600 |
| `$XDG_STATE_HOME/alfred/{account,sync,context-tokens}.json` | what the retired WeChat bot kept; nothing reads them any more, and they can stay or be deleted |
| `$XDG_STATE_HOME/alfred/claude/` | isolated Claude Code config dir: agent session transcripts used for resume |
| `$XDG_STATE_HOME/alfred/workspace-plugin/` | the `workspace` skills plugin: a manifest and the `skills` symlink into the workspace, recreated at startup |
| `$XDG_STATE_HOME/alfred/workbench/` | what the workbench reads: `runs.jsonl` (one line per finished run, kept for good), `runs/<id>.json` (live and recent runs with their steps, kept 30 days), `status.json` (heartbeat), `tasks.json` (the owner's tasks with their schedules, next runs, skips and last run, written on every change by the task store, its only writer), `alfred.log` (the log, rotated at 5 MB to `alfred.log.1`) |
| `$ALFRED_WORKBENCH_STATE` (default `$XDG_STATE_HOME/alfred/app/`) | `devices.json`: the app's paired devices, each with its id, name, creation and revocation times and the SHA-256 of its token, never the token; a device that has registered for push also has `push`, its APNs registration (the APNs device token and the environment, as `POST /api/push` stored it); the directory is mode 700 and the file 600, rewritten atomically. The workbench re-reads it when it changes. `push-cursor.json`: the id of the last event the push dispatcher handled |
| `~/Alfred/` (override with `ALFRED_WORKSPACE`) | `ALFRED.md` (workspace rules), `inbox/`, `reports/` (a task's reports go in `reports/tasks/<task id>/`), `notes/`, `images/`, `memory/` (long-term memory), `skills/` (the owner's skills), `.trash/` |
| `$XDG_CACHE_HOME/alfred/ms-playwright/` (default `~/.cache/…`, override with `PLAYWRIGHT_BROWSERS_PATH`) | Chrome Headless Shell for PDF rendering |

| Variable | Default | Purpose |
| --- | --- | --- |
| `ALFRED_LOG` | `info` | `debug` logs the agent's stderr |
| `ALFRED_MAX_BUDGET_USD` | `10` | spend cap per query, follow-up turns and background subagents included |
| `ALFRED_DAILY_BUDGET_USD` | `20` | spend per day (owner's time zone), scheduled task runs included, after which no new task, scheduled run or background subagent starts; must be a finite number > 0 |
| `ALFRED_SESSION_IDLE_HOURS` | `4` | idle hours after which the next task starts a new session; `0` disables rotation, empty means the default, anything else that is not a finite number >= 0 fails at startup |
| `ALFRED_ANTHROPIC_API_KEY` | none, required | Anthropic API key for tasks and memory scans; inherited `ANTHROPIC_*` variables are ignored |
| `ALFRED_MMX_BIN` | `$CLAUDE_CONFIG_DIR/skills/mmx/bin/mmx` (`~/.claude/…` when unset) | `mmx` executable for `generate_image`; if it is missing, the tool returns an error |
| `ALFRED_MEMORY_SCAN_MINUTES` | `60` | interval between background memory scans; `0` turns automatic scans off (`npm run memory-scan` still works); empty means the default, anything else that is not a finite number of minutes from 0 to 35791 fails at startup |
| `ALFRED_MEMORY_SCAN_BUDGET_USD` | `0.1` | spend cap for one memory scan; must be a finite number > 0 |
| `ALFRED_API_SOCKET` | `$STATE_DIR/api/alfred.sock` | the command API's Unix socket (see Command API); `off` disables the API |
| `ALFRED_WORKBENCH` | off | `on` when a workbench is deployed: the agent is told HTML reports can be read there |
| `ALFRED_WORKBENCH_URL` | none | the workbench's https base URL, for card links in replies (implies `ALFRED_WORKBENCH=on`) and as the server in the pairing QR code, where it must be an origin with no path (`http://` only on `127.0.0.1` or `localhost`, for local work) |
| `ALFRED_WORKBENCH_LISTEN` | `127.0.0.1:8787` | the workbench's TCP listener (`host:port`, or `off`); needs the three Access variables below unless `--dev` |
| `ALFRED_WORKBENCH_SOCKET` | none | the workbench's Unix socket for the SSH-tunnel fallback |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `ALFRED_WORKBENCH_OWNER_EMAIL` | none | the Access team domain, the application's AUD tag and the one email allowed in |
| `CF_ACCESS_SERVICE_CLIENT_ID`, `CF_ACCESS_SERVICE_CLIENT_SECRET` | none | the Access service token the app uses: the workbench accepts its JWT on `/api/` when the client id matches (without it service tokens are refused), and `pair` puts both in the QR code |
| `ALFRED_WORKBENCH_STATE` | `$ALFRED_STATE_DIR/app` | the directory of `devices.json`, the app's paired devices |
| `ALFRED_APNS_KEY_FILE`, `ALFRED_APNS_KEY_ID`, `ALFRED_APNS_TEAM_ID`, `ALFRED_APNS_TOPIC` | none | push: the `.p8` key file, its key id, the Apple team id and the app's bundle id (the topic). With any one missing, push is off and the workbench logs which; the key is read at startup and never logged |

## Layout

```
src/channels.ts     the channel boundary (`Outbound`, `Inbound`), the app channel, and the recording of every message as an event
src/events.ts       the append-only event log clients read
src/api/            the client API: schema (events and commands), the command API server on a Unix socket, and the client behind the `api` commands
src/agent/          Agent SDK handler (intake queue, routing, stop), structured questions, live task input, options, workspace guard, ALFRED.md rules, skill plugins, custom tools, image generation, session lifecycle, long-term memory, persisted state
src/files.ts        file name, date and text helpers
src/pdf.ts          Markdown/HTML to PDF rendering
src/runs.ts         run ids and records, the heartbeat: what the workbench reads
src/tasks/          the owner's tasks: schedule arithmetic in the owner's time zone, the task store (the only writer of workbench/tasks.json), and the API's task commands over the store and the handler
src/workbench/      the read-only workbench: server, Access check, pages, safe Markdown
src/cli.ts          run | status | setup-pdf | pdf | memory-scan | workbench | apns-test | pair | devices | api
plugin/             the baked skills plugin `alfred`
scripts/agent-smoke.ts  local agent run without the app
ios/project.yml     XcodeGen spec for the iOS app and its Share Extension (the .xcodeproj is generated)
ios/Alfred/         the iOS app: the 对话, 任务 and 文档 tabs, the file viewer, attachments, questions, push, pairing, the app entry point and the app icon
ios/AlfredShare/    the iOS Share Extension: a page, PDF or image from another app, sent to Alfred
ios/Shared/         code the app and the Share Extension both compile: the keychain store, the upload limit, photo conversion and the share logic
ios/AlfredTests/    unit tests of the app and of the shared code, on a stubbed URLSession
ios/AlfredUITests/  UI tests that drive the app against a running app-dev
ios/Config/         build settings; the owner's Signing.xcconfig is git-ignored
ios/AlfredKit/      Swift package: the client's model of the API, tested on the shared fixtures
```

## Development

```bash
npm run check   # type-check
npm test        # unit tests
npm run smoke -- --model haiku "prompt"   # one agent run with production options, the delivery tools stubbed
npm run smoke -- --model haiku --steer-after 20 "only look at Y" "prompt"   # push a follow-up mid-run
npm run smoke -- --stop-after 30 "prompt"      # abort mid-run, as /stop does, and check no Claude Code process is left
npm run smoke -- --no-subagents "prompt"       # the same run without the Agent tool, to compare spend
npm run smoke -- --skills "prompt"             # also print the skills the session lists
node scripts/handler-smoke.ts background       # the real message handler behind the command API on a temp socket: three parallel collectors
node scripts/handler-smoke.ts restart          # a shutdown while a subagent runs, then the lost-runs note
node scripts/handler-smoke.ts stop             # two background collectors, then /stop <run id> for one of them
node scripts/handler-smoke.ts nested           # a general-purpose subagent starts three background collectors
node scripts/handler-smoke.ts api              # the real handler behind the command API on a temp socket, driven over HTTP only; a pass or fail line per check
node scripts/handler-smoke.ts stream           # replies stream as message.delta, a task is stopped by interrupting its turn, the next message resumes the session
node scripts/handler-smoke.ts attach           # an upload into the inbox, then a message naming it; the reply must quote the file
node scripts/handler-smoke.ts ask              # the agent asks a structured question; answered by question.answer, by a plain message, and cancelled by run.stop
node scripts/handler-smoke.ts scheduled        # a one-time task on haiku falls due seconds ahead and runs by itself; its report is delivered with the task's id and a file lands in reports/tasks/<id>/
node scripts/handler-smoke.ts tasks            # on haiku, the owner asks for a daily 08:00 brief, a 新任务 card is answered 确认 and a chat task appears; asked to pause it, the task is paused with no card
node scripts/handler-smoke.ts prompt "text"    # one message through the real handler, then the spend per model
node scripts/app-dev.ts --port 8787            # a local Alfred for the app in the simulator: the handler behind the command API, the workbench on 127.0.0.1 with a paired device
```

The handler smoke script sends its messages through the command API and prints every message event (`[event]`: channel, direction, run id, the start of the text); a reply to the owner is such an event. The agent smoke script marks lines from inside a subagent with `[sub <id>]`, prints the SDK's `task_*` messages and the subagents still running after each tool result, and ends with the spend per model. `[first-request]` gives the first request's input tokens, to compare the prompt prefix across changes.

- `scripts/app-dev.ts` runs the real handler on the app channel with the task store, behind the command API (task commands included) on `$ALFRED_STATE_DIR/api/alfred.sock`, and the workbench on `127.0.0.1:<port>` (default 8787) without the Access check. It needs `ALFRED_STATE_DIR`, `ALFRED_WORKSPACE` and `ALFRED_ANTHROPIC_API_KEY`, and refuses to start without the first two, so point them at new scratch directories. `--model` (default `haiku`) sets the model. On the first start it pairs a device named `simulator` and prints the pairing as one `[pairing]` line, plus a QR code. A later start says so, and `--repair` revokes that device and pairs a new one. Stored events print as `[event]`, message deltas and steps as `[live]`. Only the messages you send reach the model, and the tasks that fall due or that you run (`task.run`); `/status` costs nothing.

- The smoke script uses the real workspace and agent config dir. Point `ALFRED_WORKSPACE` and `ALFRED_STATE_DIR` at scratch directories to keep test runs out of them. Like Alfred, it seeds the workspace and the workspace skills plugin, and prints the change notice for `ALFRED.md` files and skills (`[notice]`); rule disclosures show up as `disclosed … after <tool>` log lines. `npm run memory-scan` also reads transcripts from `$ALFRED_STATE_DIR/claude/projects/` and writes into `$ALFRED_WORKSPACE/memory/`, so point it at scratch directories the same way.
- Do not start a second `npm start` against the same state dir while Alfred is running: it would take over the command socket and run tasks on the same sessions.

The iOS client builds with Xcode 27 and XcodeGen; `ios/README.md` covers the phone build and install.

```bash
xcodegen generate --spec ios/project.yml   # generate ios/Alfred.xcodeproj (not committed)
xcodebuild -project ios/Alfred.xcodeproj -scheme Alfred -destination 'generic/platform=iOS Simulator' -derivedDataPath ios/build CODE_SIGNING_ALLOWED=NO build
swift test --package-path ios/AlfredKit
```

## License

MIT, see `LICENSE`.
