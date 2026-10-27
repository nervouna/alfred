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
  - `GET /api/ideas` answers `IdeaList`: every idea the store keeps in `ideas.json`, newest created first, and the `generatingRunId` while a generation is queued or running. A missing file is an empty list; a file that does not fit answers 500 and is logged.
  - `GET /api/documents` answers `DocumentList`: the documents the store keeps in `documents.json`, most recently updated first. A missing file is an empty list; a file that does not fit answers 500 and is logged.
  - `GET /api/documents/<id>` answers `DocumentDetail`: the document, its versions (newest first, the first being the current one), its annotations (newest first) and its revision runs (newest first, at most 50). A malformed or unknown id is 404 `{"error": "There is no such document."}`.
  - `GET /api/files/<path>` streams a workspace file's bytes, typed by extension as the pages type them, under `Content-Security-Policy: sandbox`. An HTML report (`.html`, `.htm`) comes with its workspace images inlined as `data:` URIs, under the report page's caps; a report over 4 MiB comes as it is. A missing path, a directory, a path outside the workspace and a `..` segment are all 404. With `?version=<commit>` it streams the file as it was at that commit, from the workspace's history (images are still inlined from the live workspace). A version that is not a 40-character lowercase commit id, a commit the history does not hold, and a path that is not a file in that commit are 404, as is a path the history refuses.
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

A file Alfred delivers (the `deliver` tool) is a document: known by its workspace path, with a version for each delivery, and open to the annotations of the app. Delivering the same path again adds a version, so Alfred revises a document in place instead of writing copies (the system prompt and the tool's description say so), and `move_file` carries a document along to its new path. The message that delivers a file names its document and the version it delivered (`documentId` and `version` on the message's file), so the app can open that version. A file over 20 MB is delivered all the same, but as a plain file with no document.

| Command | Effect |
| --- | --- |
| `/new` | start a new session (drops the conversation context; `/resume` brings it back) |
| `/resume` | switch back to the previous session for the next task; send it again to switch back |
| `/stop [run id]` | interrupt the turn the agent is on (below); with a run id, stop only that background subagent or take it out of the queue, or stop a task run or a revision run, live or queued |
| `/model [sonnet\|opus\|haiku]` | show or switch the model; default `sonnet`. During a task the switch applies from its next turn (subagent roles keep their default models) |
| `/memory` | list long-term memories |
| `/status` | model, session age and idle time, when it rotates, spend today against the daily cap, current task, background and queued subagents, pending follow-ups, the task or revision run in progress and those queued, and each active task with its next run |
| `/help` | command list |

One task runs at a time, and you can steer it while it runs ("别查 X 了，重点看 Y"):

- A message sent during a task is acknowledged (`收到，会在当前步骤结束后转给 Alfred。`) and handed to the running agent at the next step boundary, once the current model call and its tool calls finish. A tool call in flight is not interrupted. Files sent mid-task travel with the next text message.
- If the agent is still working through tool calls, the follow-up joins the current turn and one reply answers both. If it was already writing its final answer, the follow-up runs as its own turn right after, and each turn gets its own reply, sent as soon as it ends.
- `/status` lists the foreground subagents with their role, brief title and age. A run's progress shows on its card in the app (and on the workbench), and the reply text streams as it is written; no progress message is sent. Background subagents show their progress on their cards.
- Once every message has been answered and no background subagent is running or queued, the task ends. A message that arrives after that is queued and starts the next task, which resumes the same session.
- `/stop` (or the app's stop button, `run.stop`) interrupts the turn the agent is on (`Query.interrupt()`) and does not abort the task. The turn ends without a reply: neither its text nor an error line. Alfred answers `已停止当前运行。`, and when background subagents are still running or queued, `已停止当前运行。后台运行 <id>、<id> 仍在继续，发 /stop <id> 停止。` Follow-ups already handed to the task and messages queued behind it are kept and answered afterwards. The task ends as stopped when the interrupted turn was its last, with nothing left to answer and no background subagent running; otherwise it goes on and ends as usual. If the turn has not ended 10 seconds after the interrupt, the task is aborted instead (logged), which also drops its subagents and the follow-ups it has not answered.

Alfred can ask you a question mid-run, with a few options, instead of guessing (the SDK's `AskUserQuestion` tool, offered to the main agent only; the system prompt tells it to ask only when a choice between a few options blocks progress and it cannot decide). The app shows the question on a card in the timeline, from the `question.asked` event.

- **Answering.** The app answers each question with `question.answer` (see Command API). While a question is open, any message from you that is not a slash command also answers it, as free text: the text, trimmed, is the answer to every question of the ask, and a bare number is text like any other. It is recorded as usual, with the run's id, and is not acknowledged or handed to the agent as a follow-up. A message with only a file does not answer.
- **Waiting.** The run waits for the answer with no timeout, and the question pushes a notification to the app (see Workbench). The call is held in a `PreToolUse` hook for `AskUserQuestion`, not in `canUseTool`: under `dontAsk` the CLI denies the tool before `canUseTool` is asked, so the hook answers it with `permissionDecision: "allow"` and the answers added to the tool's input. Its matcher sets a timeout of a week, because the SDK's default for a hook is 10 minutes. The CLI also offers the tool only when a `canUseTool` is set, so the options carry one that denies everything; it is never asked in practice, and the SDK logs its `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning at each run's start because of it. A subagent's call is denied at once ("tell the main agent what you need to know, and it will ask").
- **Cancelling.** `/stop` (or `run.stop` for the run) cancels the open question: `question.answered` is recorded with `cancelled: true`, the call is denied with "The user stopped the run", and the turn is interrupted as above. So does the interrupt's abort signal reaching the held call, the end of the run, and shutdown.

### The app channel

The handler has one channel, the app, whose only client is the command API below. It calls the handler's `submit`, `stopRun` and `answerQuestion` (see `src/channels.ts`).

- One intake queue takes the owner's messages in arrival order, with the steer, queue and command rules above.
- A message can carry files: they are uploaded to the inbox first and named by the message (see Command API). They are attached to the next text message, and a message with files and no text is answered `已保存 …，告诉我要怎么处理。`.
- A run answers the owner: the final reply, files from `deliver` and background subagent reports. A command's reply and the notices a message triggers (acknowledgements, runs a restart cut short, the daily cap, changed rules) are messages of their own.
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
  - `{"type": "run.stop", "runId": "…"}` answers 202 `{"stopped": true}`, or 404 `{"error": "no live or queued run <id>"}`. For the task it interrupts the current turn, like `/stop` (see In the app); the reply `已停止当前运行。` arrives as a `message.created` event. For the live run of a scheduled task (see Tasks) it aborts the run, which ends stopped and says nothing more. For a revision run (see Documents), live or still queued, it ends the run stopped, and its message says so.
  - `{"type": "task.create", "title": "…", "brief": "…", "schedule": {…}, "model": "…", "budgetUsd": 2}` creates a task and answers 201 `{"task": …}`, the task as the store now holds it. `model` and `budgetUsd` are optional and take Alfred's defaults when omitted. The schedule is one of `{"kind": "once", "at": "<ISO time>"}`, `{"kind": "daily", "time": "HH:MM"}`, `{"kind": "weekly", "days": [1 to 7, 1 being Monday], "time": "HH:MM"}` or `{"kind": "interval", "hours": 1 to 168}`.
  - `{"type": "task.update", "taskId": "…", …}` changes at least one of `title`, `brief`, `schedule`, `model`, `budgetUsd` and `status` (`active`, `paused` or `done`), and answers 200 `{"task": …}`.
  - `{"type": "task.run", "taskId": "…"}` starts a run of the task now, or queues it behind the runs already waiting (see Tasks), without moving its next scheduled time: 202 `{"accepted": true}`, or 404 `{"error": "no task <id>"}`.
  - A create or update the store refuses answers the store's 400 or 404 with `{"error": "…"}`: a task made here has the origin `manual`, and a change the moment does not allow (such as a one-time task whose time has passed) is a 400 with the store's message. `src/cli.ts run` creates the one task store and passes it to the handler and, as these commands (`src/tasks/commands.ts`), to the API; `scripts/app-dev.ts` wires them the same way. An API started without them answers every task command 503 `{"error": "tasks are not available"}`.
  - `{"type": "document.revise", "documentId": "…", "version": "<commit id>", "annotations": [{"target": …, "comment": "…"}]}` submits a batch of 1 to 50 annotations on the version of the document the owner read, and starts a revision run for it (see Documents). A target is `{"kind": "passage", "quote": "…", "prefix": "…", "suffix": "…"}` (Markdown and text documents only) or `{"kind": "document"}`. It answers 202 `{"runId": "…", "annotations": […]}`, the run and the annotations as recorded (state `submitted`, in the owner's order), or `{"error": "…"}` with 404 for an unknown document, 409 when the version is not the document's current one, when the document already has a batch queued or running, when the day's spend cap is reached (`today's spend cap is reached`) or while Alfred is shutting down, and 400 for a passage on a document that is not Markdown or text. A refused batch records nothing. `src/cli.ts run` passes these commands (`src/documents/commands.ts`) to the API when documents are on; without them every document command answers 503 `{"error": "documents are not available"}`.
  - `{"type": "document.undo", "documentId": "…", "runId": "<run id>"}` undoes the document's latest revision (see Documents). It answers 200 `{"document": …}`, the document as the store holds it now, or `{"error": "…"}` with 404, 409 or 500 for the refusals listed there. `src/cli.ts run` passes it with `document.revise` when documents are on; without them it answers 503 like the other document commands.
  - `{"type": "idea.accept", "ideaId": "…", "title": "…", "brief": "…", "schedule": {…}, "model": "…", "budgetUsd": 1}` accepts an open idea as a task, with the title, brief, model and budget the owner confirmed in the app's task form. `schedule` is optional and takes the forms of `task.create`: with one the task runs on it; without one it is a one-time task due 60 seconds later (see Ideas). It answers 200 `{"idea": …, "task": …}`, the idea now accepted with the task's id and the task, whose origin is `idea`. A task the store refuses (a one-time time that has passed) is 400 with the store's message, and the idea stays open. An unknown idea is 404 `{"error": "no idea <id>"}`; an idea that is not open is 409 `{"error": "the idea is accepted"}` (or `rejected` or `archived`), and no task is made.
  - `{"type": "idea.reject", "ideaId": "…", "reason": "…", "note": "…"}` rejects an open idea with one of the reasons `not-interested`, `already-doing`, `not-now`, `too-expensive` or `wrong-direction`, and an optional `note` of 1 to 500 characters. It answers 200 `{"idea": …}`, and 404 or 409 as `idea.accept` does.
  - `{"type": "idea.generate"}` asks Alfred to generate ideas now (see Ideas, Generation). It answers 202 `{"runId": "…"}`, the generation's run, which has begun: the ideas arrive later as `idea.updated` events and the run ends with `run.updated`. It is refused with 409 `{"error": "Alfred is shutting down"}` while Alfred closes, 409 `{"error": "today's spend cap is reached"}` when the day's spend has reached the cap, 409 `{"error": "ideas are being generated"}` while a generation is queued or running, and 503 `{"error": "idea generation is not available"}` when the handler has no idea store. A refusal leaves no run behind.
  - `src/cli.ts run` creates the one idea store and passes it, with the task store, to these commands (`src/ideas/commands.ts`), and the handler's `generateIdeas` as their generation; `scripts/app-dev.ts` wires them the same way. An API started without them answers every idea command 503 `{"error": "ideas are not available"}`.
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
- Prompt cache: Alfred sets `ENABLE_PROMPT_CACHING_1H=1`, so the prompt is cached for an hour rather than five minutes. A 1-hour write costs 2× the base input price, against 1.25× for a 5-minute write, and a read costs 0.1× either way. A message within the hour after the last one reads the cached prompt instead of writing the whole context again; a longer pause still finds the cache expired. Subagents and memory scans run with the same environment, so their cache writes last an hour too.
- Compaction: Claude Code compacts the transcript on its own when it nears the context window, which is `ALFRED_COMPACT_TOKENS` (default 100000 tokens) rather than the model's full window. A long session therefore stops growing without bound. Alfred adds no compaction logic of its own, and logs one line per compaction with the run, the session and the token counts the SDK reports (`agent run compacted`).
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
- **Only Alfred talks to the user.** No subagent can call `deliver`, and none changes `memory/`, `skills/` or any `ALFRED.md`. A hook denies those calls whenever they come from a subagent (the hook input carries `agent_id`), whatever its type, so a forked skill is held to the same rules as a role. The roles also go without `Agent` and `TaskStop`. The workspace guard applies to subagents as it does to Alfred.
- **Review.** The system prompt says when to delegate and when not to, what a self-contained brief holds, and how Alfred checks a result before replying: it answers the brief, at least one cited source is opened to confirm it, and the files it names exist. A result that falls short gets one more round with the same role. If it still falls short, Alfred replies with what it has and says what is missing.
- **Spend.** `ALFRED_MAX_BUDGET_USD` (per query, default $10) covers subagent calls too, and the image cap of `generate_image` is per task across subagents. `ALFRED_DAILY_BUDGET_USD` (default $20) is the budget: once the day's spend reaches it, no new task or background subagent starts until the next day in the owner's time zone, and running ones finish. At the end of each task the log line `agent run done` breaks the spend down per model (`models=[...]`), from the SDK's `modelUsage`. A background subagent's card shows its spend so far (`≈`), updated as it works: the usage of its own responses, read from its transcript, priced at the rate its model's `modelUsage` implies. Calls its tools make on another model (WebFetch summaries, for one) count only toward the task. The task's card and the spend totals already include its subagents.
- **Tracking.** `/status` lists foreground subagents from the SDK's `task_started` and `task_notification` messages, so a forked skill shows up while it runs.
- `/stop` interrupts the main agent's current turn only (`interrupt()`; `perTaskStopAffordance` makes an interrupt spare the background subagents), so they keep running and report as usual. The reply names them: `已停止当前运行。后台运行 <id>、<id> 仍在继续，发 /stop <id> 停止。` `/stop <run id>` stops one background subagent (`stopTask`) or drops it from the queue. Only the 10-second fallback (a turn that does not end after an interrupt) and a shutdown end the Claude Code process, and the subagents inside it with it.
- **Restarts.** On SIGTERM Alfred stops every task before it exits, so the container never waits for `StopTimeout`. The task's run and its live or queued subagents are recorded as lost. After a crash, runs still marked live are marked lost at startup. Either way, the owner's next message gets one line naming them (`Alfred 重启时中断了 2 个运行：…`).

### Tasks

A task is a brief the agent runs on a schedule, without being asked each time. The app creates, changes and runs tasks through the task commands (see Command API), you can also set them up by talking to Alfred (below), and `workbench/tasks.json` holds them (see State and files).

- **From chat.** The main agent of a chat run has three tools, `task_list`, `task_create` and `task_update` (`src/agent/task-tools.ts`), when the handler has a task store. Their inputs are the fields of `task.create` and `task.update`, checked by the same rules, and a task made this way has the origin `chat`. A task run is not offered them, a subagent's call is denied (the subagent guard, as for `deliver`), and the system prompt gets a short Tasks section only when they are offered: create a task only when you ask for scheduled or recurring work, never on its own initiative; the tool returns once you answer, so say what it proposed and what happened, and do not repeat the question in text; name the time zone when it states a schedule; prefer `haiku` or `sonnet` and give a realistic per-run cap; pause or end a task on request without asking. Each tool returns one line for the agent to relay: what changed and the next run, or why nothing changed (the store's message for a change the moment does not allow, an unknown id, a declined or cancelled confirmation).
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
  - The first message is a short preamble and then the task's brief. The preamble names the task (title and id) and the time it was due in the owner's zone, says the owner is not watching (ask no questions, make assumptions and state them in the report), asks for the report under `reports/tasks/<task id>/` and for it to be delivered with `deliver`, and names the previous report: the newest file in that directory, if there is one.
- **Spend.** A task run's cost is on its run record and goes into the owner's day and total, so it counts toward `ALFRED_DAILY_BUDGET_USD`. It does not count toward the chat session's figures or move its idle clock. A run the owner pauses or ends is estimated as an aborted run is (see Agent sandbox). When a run comes up and the day's spend has reached the cap, it does not start: a scheduled occurrence is recorded on the task as skipped (`daily-cap`), and for it and for a run now one message with the task's id says the task was due and the cap is reached, with what was spent. That message pushes, since the owner is waiting for the report.
- **Delivery.** Everything the run says, its final reply and the files it delivers with `deliver`, is recorded as a `message.created` with the run's id and the task's id. A file it delivers is a document that records the task, and the task's own commit at the end of the run is `Run <run id>: <task title>`. The push dispatcher pushes it like any reply, and the app labels it with the task. Every run pushes: there is no quiet mode. A run that ends with an error result, by its budget cap (`error_max_budget_usd`) or by an error ends failed, and posts one message saying what happened. `run.stop` (or `/stop <run id>`) aborts a task run: it ends stopped and posts nothing more. A task run live at a shutdown is recorded as lost, and one live at a crash is marked lost at the next start, as chat runs are; either way its occurrence is not run again.
- **The chat hears of it.** Each task run that delivered a reply is kept in the owner's record (`taskDeliveries` in `agent-state.json`): task id and title, run id, time, the first line of the reply and the paths of the files it sent; the 20 newest are kept. The owner's next message to the chat gets a section listing them, as data, in its prompt, and the list is cleared. A command, or the answer to a question, leaves the list for the next message. Without a delivery the prompt is unchanged. A failed run is not a delivery.
- **Pausing and ending.** Pausing or ending a task (`status` `paused` or `done`, by `task.update` from the app or `task_update` from chat) stops it: its run in progress is aborted as `run.stop` aborts it, so it ends stopped and posts nothing more, and its queued runs, scheduled occurrences and runs now alike, are dropped, with no skip recorded and no message. Resuming the task does not bring a dropped run back; the next occurrence follows the schedule. Other tasks' runs, the chat's run and background subagents are untouched. Both ways change a task through the store's `update`, which tells the handler through `onStatusChange`, and the handler reacts in that one place. The `done` that `takeDue` gives a one-time task as its run is taken is not such a change, so that task's own run goes on. A run now on a paused task is the owner's call and runs, and ending that task stops it.
- **Queued occurrences.** A scheduled occurrence waits in the queue behind the run that is live. Should it come up for a task that is paused, or ended (`done`) when its schedule is not a one-time one, it does not run: it is logged and dropped, with no skip recorded and no message (pausing and ending drop it earlier, above). A one-time task is `done` by then in any case, because the store marks it done as its run falls due, so it still runs. A run now is not affected.
- **Shutdown.** It stops a live task run, empties the queue of task runs and stops the 30-second timer. A chat message queued behind the live chat run starts no run once the shutdown has begun.

### Documents

A document is a file Alfred delivered (the `deliver` tool, see Agent sandbox), known by its workspace path; `workbench/documents.json` holds the documents with their versions and annotations (see State and files). A version is a commit of the workspace's history, named by its full commit id, with the reason it exists: `delivered` (a delivery), `revised` (the end of a revision run), `changed` (the end of any other run, or the startup commit) and `undone`. The newest version is the document's current one. The owner annotates a version in the app, on a passage (Markdown and text documents) or on the whole document (any kind), and submits a batch of up to 50 annotations at once with `document.revise` (see Command API). Alfred revises the document in place and answers each annotation.

- **Accepting a batch.** `DocumentCommands.revise` is `reviseDocument` of the agent handler. It refuses the batch, and records nothing, when the day's spend cap is reached (409 `today's spend cap is reached`), when Alfred is shutting down (409), and for the document store's reasons: 404 `no such document`, 409 `the document has changed since; reload it` for a version that is not the current one, 409 `a revision of this document is queued or running` while an earlier batch is, and 400 for a passage on a document that is neither Markdown nor text. A refused batch leaves no annotation and no run, not even a failed one: the run's id is drawn first, the store takes the batch against it, and the run's record is created only once the store has. An accepted batch is stored with the run's id (every annotation `submitted`, in the owner's order), the run is recorded as `queued` (kind `revision`, `documentId`, the document's task if it has one, title `修订「<document title>」`), and the answer is 202 with the run id and the annotations.
- **One at a time, beside the chat.** A revision run waits in the queue task runs use, in the order it arrived, and one run beside the chat (a task's or a revision's) runs at a time. It neither waits for the chat nor stops it. `/status` lists the one in progress and how many wait.
- **Unattended.** A revision run is a run of kind `revision`. It goes through the same `execute` and `agentOptions` as a task run and is unattended in the same way (see Tasks): a new session with `persistSession: false`, no `AskUserQuestion` and no task tools, background `Agent` calls denied, `memory/`, `skills/` and every `ALFRED.md` read-only. Its spend counts toward the day and the daily cap, not the chat session. If the cap has been reached when its turn comes, it does not start: it ends failed, its annotations go back, and one message says so.
- **Model and cap.** For a task's document, the task's model and per-run cap (`maxBudgetUsd`). For any other, the model of the run that made the document's first `delivered` version (its record names the model by id, mapped back to `sonnet`, `opus` or `haiku`), or `sonnet` when that run is unknown or ran on a model that is none of these; and the default task cap, $2 (`DEFAULT_TASK_BUDGET_USD`).
- **The first message** says the run is a revision of the document (title and id) and that the owner is not watching (ask no questions, state assumptions in the replies; memory, skills and rules are read-only; no background subagents), gives the document's path, title, kind and the version annotated, and says to revise it in place under the same path, not to write a copy and not to deliver it (Alfred posts the revised version itself). Then it lists the batch in the owner's order: for each annotation its id, whether it is on a passage or the whole document, for a passage the quote with the text before and after it, and the comment, each as a JSON string so a line break in a comment cannot pass for the list. It asks the agent to answer every annotation with `reply_annotation`, including those it decides not to act on (say why) and to state its assumptions in the reply, and to end with a short final message saying what changed.
- **Replies.** `reply_annotation` (`mcp__alfred__reply_annotation`, `{annotationId, reply}`) is offered to revision runs only: not to the chat, a task run or a subagent (the subagent guard denies it). It answers one annotation of the run's batch through the document store: the annotation becomes `resolved` with the reply, trimmed (up to 4,000 characters), and the tool tells the agent how many annotations still wait. The store's refusals come back as tool errors that name the reason: an unknown id, an annotation of another run, one already answered or sent back, a blank reply, a reply over the limit. Like Alfred's other tools it does nothing once the run is stopped.
- **The end.** When the query ends, in this order: (1) the files the run wrote are committed as `Run <run id>: 修订「<title>」`, as at the end of any run, and the revised document's version becomes a `revised` version of the run, while any other document the commit changed gets a `changed` one; a run that changed nothing makes no version, and a run lost at a shutdown commits nothing; (2) `finishRevision` sends the annotations the run did not answer back to the owner, as `unanswered` for a run that ended well, `stopped` for a stopped one and `failed` for a failed or lost one (an answered annotation stays resolved with its reply, whatever happened later); (3) the run is recorded as `done`, `stopped`, `failed` or `lost`; (4) one message with the run's id (and the document's task, if any) and the document's file, at its version now, which is the new one or the current one when nothing changed, is posted. It pushes like any reply. It reads `修订了「<title>」：<n> 条已回复`, then `，<m> 条退回` when some went back, then a blank line and Alfred's final message; or `修订「<title>」已停止`; or `修订「<title>」失败：<reason>` for an error result, the run's budget cap or a thrown error. A run lost at a shutdown posts nothing, and the owner's next message names it.
- **Stopping.** `run.stop` or `/stop <run id>` with the run's id aborts a live revision run, and takes a queued one out of the queue; either way it ends `stopped`, its annotations go back with `stopped`, and its message says so. A shutdown ends the live run, and every queued one, as `lost`, and their annotations go back with `failed`. A start that finds a revision run still marked live or queued (a crash) marks it lost as it does any run, and sends its annotations back with `failed`, so a document never stays locked by a batch no run will answer.
- **Undo.** `DocumentCommands.undo` (`src/documents/commands.ts`) undoes a document's latest revision, named by the run that made it. It is refused, and changes nothing, with 404 `no such document`; 404 `no such revision of this document` when no `revised` version of the document has that run; 409 `only the latest revision can be undone` when the document is not at that version (a later revision or an undo has replaced it, and a revision is undone once); 409 `a revision of this document is queued or running`; and 409 `files changed since the revision: <paths>` when a file the revision changed differs from its content at the revision's commit, whether the change is committed or not. Otherwise every file the revision changed goes back to its content at the revision's parent commit (`Versions.restore`) and is committed as `Undo revision <run id>`, with the commit forced in whatever its type, since the history already held those files. Every document among them gets an `undone` version naming the run in `undoes` (and no run of its own), and the batch's annotations go back to the owner as `undone`, the answered ones keeping their replies. The answer is 200 with the document. The timeline gets no message: the app learns of the undo from `document.updated` and `annotation.updated`. A failure before the commit puts the revision's files back, records nothing and answers 500 with the error. The undo and `document.revise` share one lane, so an undo's checks and restore never interleave with a batch being recorded or with another undo.
- **The chat hears of it.** Each revision run that posted a message is kept in the owner's record (`revisionDeliveries` in `agent-state.json`): the document's title, id and path, the run id, the time, how it ended, how many annotations were answered and how many went back, and the first line of Alfred's final message or the reason it failed; the 20 newest are kept. The owner's next message to the chat gets a section listing them, as data, in its prompt, and the list is cleared, as with task deliveries.

### Ideas

An idea is a suggestion Alfred makes from memory and recent conversations, for the owner to take up as a task or turn down. `workbench/ideas.json` holds the ideas in every state, written on every change by the idea store, its only writer (see State and files). The app reads them with `GET /api/ideas` and answers them with the idea commands (see Command API).

- **States.** An idea is `open` until the owner accepts it (`accepted`, with the `taskId` of the task it made), rejects it (`rejected`, with a reason and an optional note), or leaves it unanswered for 7 days, when it is `archived`. Only an open idea can be answered. The store keeps every open idea and the 200 closed ones updated last.
- **Accepting.** `idea.accept` makes a task with origin `idea`, from the title, brief, model and budget the owner confirmed. With a schedule the task runs on it, like any task (see Tasks). Without one it is a one-time task due 60 seconds after it is accepted: the scheduler takes due runs every 30 seconds, so the run starts within about a minute and a half, through the ordinary scheduled path. The check, the task's creation and the acceptance run with no await between them, so two accepts of one idea cannot make two tasks.
- **Rejecting.** `idea.reject` records the reason and the note on the idea and changes nothing else. They stay in `ideas.json`; nothing writes them to long-term memory.
- **Archiving.** `startArchiving` (`src/ideas/archive.ts`) archives the open ideas created 7 days or more ago, once at start and then every hour, and logs one line naming them. `run` starts it with the API and stops it when the API has closed.
- **Generation.** A generation is one short model call that reads the owner's memory, recent conversation, tasks, documents and earlier ideas, and adds up to three ideas to the store; zero is a good answer. It runs once a day at `ALFRED_IDEAS_AT` (Daily generation, below) and whenever the owner asks (`idea.generate`, the app's button). It is `generateIdeas` of the agent handler, with the code that is not the handler's in `src/ideas/generate.ts`. While one is queued or running, `GET /api/ideas` carries its `generatingRunId`, and a second is refused (see Command API). It never runs tools and never touches the workspace, so it does not use the lane that task runs and revision runs share and does not take the memory lock: it runs beside the chat and beside a task or revision run, and a memory scan does not hold it up.
  - **The inputs** (`collectInputs`) are data about the owner, not instructions, and only what the owner and Alfred said: never tool calls, tool results or fetched pages, so a page cannot plant an idea. Each generation reads:
    - the memory index, with the cap the system prompt has (200 lines or 8 KB, most recently updated first), read from the memory files; nothing is written to the workspace;
    - the `message.created` events of the last 7 days that have text, the owner's and Alfred's (a task run's or a revision's message is Alfred's), oldest first, each flattened to one line and cut to 500 characters, with its local date and who wrote it. When they pass 20,000 characters in all the oldest are left out and the newest kept;
    - the active and paused tasks: title, status, schedule in words, model, per-run cap and the first 300 characters of the brief;
    - the documents whose first `delivered` version is at most 14 days old: title and path;
    - the ideas: the open ones (title, kind, the first 300 characters of the brief), the 50 rejected last (title, reason, note), the 20 accepted last and the 20 archived last (titles). "Last" is by `updatedAt`, the time of the answer or the archiving;
    - the cost of the 20 task and revision runs that ended `done` last, from `runs.jsonl`, with their model and cost, so that estimates rest on what runs actually spent.
  - **The prompt.** Alfred's own system prompt (not the agent's) and one user message that holds the inputs in tagged blocks (`memory-index`, `conversation`, `tasks`, `documents`, `open`, `rejected`, `accepted`, `archived`, `reference-costs`), each marked as data, with text that would open or close one of the tags defused. The system prompt asks for research or writing Alfred can do on its own, with its tools, for this owner; says zero ideas is a good answer and three the most; asks for Simplified Chinese, a `why` of one sentence on why now and for this owner, and a self-contained brief (it runs unattended in a fresh session that sees no conversation) that says what to deliver; allows `recurring` only when the value recurs, with a daily, weekly or every-N-hours schedule in the owner's time zone, which it names; allows research and writing only, never anything outward (messages, purchases, sign-ups, posts); forbids repeating an open, accepted or archived idea or anything like a rejected one, except that one rejected as `not-now` may return when circumstances changed; asks for the cheapest model that does the job (`haiku` or `sonnet`, `opus` only for long writing) and an estimate of one run's cost from the reference costs; and asks for each idea's provenance (memory names, conversation dates, task or document titles).
  - **The call** is `query` with Sonnet (`MODELS.sonnet`), no tools (`tools: []`), `settingSources: []`, the state directory as `cwd`, `persistSession: false`, `permissionMode: "dontAsk"`, `maxTurns: 3`, Alfred's environment, and `maxBudgetUsd` `IDEAS_BUDGET_USD` ($0.20, a constant in `src/agent/config.ts`, not a setting: a typical generation costs $0.05 to $0.10, and the 1-hour cache write makes $0.10 too tight). The answer is structured output: `{"ideas": [{"title", "why", "brief", "kind", "schedule", "model", "estimateUsd", "provenance"}]}`, at most three. `schedule` is `{"kind": "daily", "time": "HH:MM"}`, `{"kind": "weekly", "days": [1-7], "time": "HH:MM"}`, `{"kind": "interval", "hours": n}` or `null` for a `once` idea: the contract's schedules, without `once`.
  - **The result** is parsed with zod, and only the first three ideas are read. An idea that does not map onto an `IdeaDraft` (no schedule on a recurring idea, a schedule on a `once` one, a `once` schedule, a field the contract refuses, such as a title over 80 characters) is logged with the reason (`dropping idea <n>: …`) and left out, and the others are kept; the store drops what its schema refuses as well. A result that is not a success (an error result, or a success flagged as an error), no result, or an answer that is not shaped like the above, fails the run, and the cost so far is charged. The provenance is for the log only: it is not stored on the idea and not part of the contract.
  - **The run.** `generateIdeas` refuses first (503, then 409 for a shutdown, the cap and a generation in progress, in that order), then records a run of kind `ideas` (title `想法`, the model's id for Sonnet; the workbench's card calls it `想法`, as it calls a scan `记忆扫描`), marks it in the store (`startGeneration`), answers 202 with the run id, and generates without being waited for. It posts no message, pushes nothing and leaves the chat alone: the app learns of it from `idea.updated` and `run.updated`. The run ends `done` with the ideas added to the store under its id, or `failed` with the reason, or `lost`; the store's `finishGeneration` is called either way, and before the run is recorded as ended, so a client told the run ended finds no `generatingRunId`.
  - **Spend.** The call's cost is on the run's record and goes into the owner's day and total, as a task run's does, so it counts toward `ALFRED_DAILY_BUDGET_USD`: once the cap is reached there is no generation that day, and a generation that spends the last of it is the day's last. It does not count toward the chat session. A failed call is charged what it cost.
  - **Shutdown** aborts a live generation, which ends `lost` and adds nothing even if its call had an answer. A generation a crash cut short is marked lost at the next start, like any run, and the idea store clears its `generatingRunId`. Neither is named in the owner's next message, as a lost memory scan is not.
  - **The log** has, for each generation: `ideas inputs run=<id> memories=<n> messages=<n> tasks=<n> documents=<n> open=<n> rejected=[<id>,…] accepted=<n> archived=<n>` (what it read, with the ids of the rejected ideas it was given); one line per idea added, `ideas added run=<id> idea=<id> title="…" provenance="…"`; and the end, `ideas done run=<id> cost=$… added=<n>`, or `ideas failed run=<id> cost=$…: <reason>`, or `ideas lost run=<id> …`.
- **Daily generation** (`src/ideas/schedule.ts`). `ALFRED_IDEAS_AT` is a time of day, `HH:MM`, `08:00` by default, in the process's time zone (the owner's, `TZ`, as task times are); empty turns the daily generation off (the app's button still works), and anything else fails at startup with a message. `run` checks at startup and then every minute (the timer does not keep the process alive and is stopped at shutdown). The day's generation is due once the local time reaches `ALFRED_IDEAS_AT` on a day that has not had its scheduled generation.
  - A due generation at most 6 hours late (`MISSED_RUN_MS`, as for tasks) starts once; a later one is skipped and logged.
  - It is also skipped, and logged, with 5 or more open ideas. A skip for lateness or for the open ideas finishes the day.
  - When `generateIdeas` refuses (the cap is reached, a generation runs, Alfred is closing) the day is not finished: the reason is logged once, and the next check tries again, until a generation starts or the day is skipped for lateness.
  - The day is recorded as done once a generation starts or the day is skipped, in `$STATE_DIR/ideas-schedule.json` (`{"lastDay": "YYYY-MM-DD"}`), so a restart does not run it twice. A file that cannot be read counts as no record.
  - `scripts/app-dev.ts` starts it only with `--ideas-at <HH:MM>`, so a development stack does not spend on its own.

### Agent sandbox

- Built-in tools: `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, `Skill` for skills, and `Agent` and `TaskStop` for subagents (above). No shell.
- Custom tools: `deliver` (deliver a workspace file to the owner in the app, as a document; images arrive as images; an HTML report is sent as it is, and the app opens it in a sandbox where inline scripts and SVG charts work, with no network), `move_file` (move or rename inside the workspace; deleting means moving into `.trash/`), `render_pdf` (Markdown or HTML to A4 PDF) and `generate_image` (MiniMax `image-01` through `mmx`). A revision run (see Documents) has one more, `reply_annotation` (answer one annotation of its batch, with a reply); no other run is offered it, and a subagent's call is denied. Each one stops when its run is stopped and when its own call is interrupted by `/stop`: a `deliver` or `move_file` not yet done does nothing, `render_pdf` closes its browser, and `generate_image` kills its `mmx` process group. A delivery that has started runs to the end.
- **Delivering a document.** After its checks (inside the workspace, a file, at most 100 MB) and before the send, `deliver` commits the file, whatever its type, as `Deliver <path> (run <run id>)` in the workspace's history (see State and files) and registers it in the document store (`src/documents/register.ts`): the document's kind comes from the file's extension, its title from the first level-1 or level-2 heading of a Markdown file or the `<title>` of an HTML file (else the file name), and it records the run and, for a task's run, the task. Its version is that commit, or, when the file is as the history already holds it, the version it is already at, so delivering a file again without changing it adds no version. The send then carries the document: the message's file names `documentId` and `version`. A file over 20 MB is sent with no document. If committing or registering fails, the file is still sent, with no document, a warning is logged, and the tool still answers that the file was delivered. `move_file` tells the store after a move, which moves the document at the old path (or each document under a moved directory) to the new one. Subagents cannot call `deliver`.
- **Commits at the end of a run.** When a chat run, a task run or a background subagent run ends (done, stopped or failed; a run lost at a shutdown commits nothing, and the next start picks up what it left), Alfred commits the files that run wrote and the paths it moved files away from, as `Run <run id>: <run title>`, and the documents among the files the commit changed get a `changed` version at it; for a revision run (see Documents) the document it revises gets a `revised` one. A version a delivery of the same run recorded is not recorded again. A run that wrote nothing makes no commit. The commit comes after the run's last reply and notice, and a failure of it is logged and touches neither the replies nor the run's record. A background subagent commits its own files when it ends, and the run that started it commits only its own.
- PDF rendering uses Playwright's standalone Chrome Headless Shell in `~/.cache/alfred/ms-playwright/`, never the installed Chrome. Every request the page makes goes through a route handler that serves only the source itself plus images, stylesheets and fonts whose real path (symlinks followed) is inside the workspace. Other local files, iframes, objects and embeds, network URLs and every other scheme except `data:` are refused, and a CSP plus disabled JavaScript back this up. So a report can neither pull a file from outside the workspace into the PDF nor leak anything over the network. Reference workspace images by relative path (a report in `reports/` can embed `../images/<date>/cover.jpg`); charts must be inline SVG.
- `generate_image` runs `mmx` without a shell, in its own process group, from the Alfred process rather than the agent's Claude Code subprocess. `/stop` or the 10-minute timeout kills the whole group. It uses the user's own Token Plan key. Output paths must resolve inside the workspace. Existing files and paths a running call will write are never overwritten; the default is `images/<date>/<slug>.jpg`. A task may request at most 4 images per call and 8 in total. Failed and timed-out calls count, because MiniMax bills them too, and the tool never retries. `mmx` errors, quota errors included, reach the agent verbatim, and every call is logged.
- A `PreToolUse` hook confines every file path to the workspace, following symlinks; for a task run and a revision run it also keeps `memory/`, `skills/` and the `ALFRED.md` files read-only (see Tasks). Permission mode is `dontAsk`, so anything not listed is denied.
- No tool may use a `.git` path. The same hook denies, for reading and writing, any file path, `Glob` or `Grep` path, pattern or glob, and any `move_file`, `render_pdf`, `generate_image` or `deliver` path with a `.git` segment, in any case; names that only contain `.git` (`.gitignore`, `notes.github.md`) are fine. The workspace's history lives in a git dir outside the workspace (`workbench/versions.git`, see State and files), so no tool reaches it.
- The Claude Code subprocess gets a scrubbed environment and its own config dir, so it never loads the user's Claude Code settings, plugins or MCP servers. Claude Code's built-in auto memory is turned off (`autoMemoryEnabled: false`) for tasks and memory scans; long-term memory is Alfred's own (see above).
- Spend is capped per query at `ALFRED_MAX_BUDGET_USD` (default $10), follow-up turns and background subagents included; once it is reached, the task stops and any follow-up still waiting fails at once without spending. A scheduled task run has its own cap instead, the task's budget (see Tasks), and so has a revision run (see Documents). The daily cap `ALFRED_DAILY_BUDGET_USD` (default $20) stops new work for the rest of the day, task runs, revision runs and generations of ideas included. A run that ends without a result for its last turn (stopped, its task paused or ended, a revision stopped) is not recorded at $0: the responses it had no result for are estimated at the unit price each model's last result implied (`unitPrices` in `agent-state.json`), with cache writes weighted by TTL (a write whose TTL is not given counts as 1-hour) and $0.01 per web search. The estimate is marked as estimated on the run's record and counts toward the day's spend and the owner's total, not the chat session's running total. A model with no remembered price adds nothing, and the log says so. The unit price counts every cache write at the 1-hour rate, since every agent call caches for an hour (#125) and a result's `modelUsage` does not split writes by TTL, so a write that was 5-minute is priced high. Model round-trips are capped at 60 per turn, so a follow-up that starts a turn of its own gets a fresh 60.
- Residual risk: `WebFetch` can reach any URL, so a malicious page could try to make the agent leak workspace content through a request. Keep secrets out of the workspace.

## State and files

| Path | Content |
| --- | --- |
| `$XDG_STATE_HOME/alfred/` (default `~/.local/state/alfred/`, override with `ALFRED_STATE_DIR`) | `agent-state.json` (the owner's record, under the key `owner`: active and previous session, model, spend, the unit price of each model from the last results (`unitPrices`, which estimates an aborted run), and the task runs delivered and the revision runs ended since the owner's last message), `memory-scan.json` (transcript offsets and extraction spend), `ideas-schedule.json` (the last day whose scheduled generation of ideas started or was skipped, `{"lastDay": "YYYY-MM-DD"}`), `memory.lock` (held while a task or memory scan runs), `events/events.jsonl` (the append-only event log for clients: one line per durable event, ids increase, kept for good), `api/alfred.sock` (the command API's socket while Alfred runs); files are mode 600 |
| `$XDG_STATE_HOME/alfred/workbench/versions.git/` | the workspace's git history, mode 700: the git dir of a repository whose work tree is the workspace, so the workspace itself holds no `.git`. Text files are versioned, and so is any delivered file up to 20 MB whatever its type; other images, PDFs, audio and video, and `inbox/` and `.trash/`, are not. A tracked file that grows past 20 MB keeps its last version. The rules are also written to `info/exclude`, and the git commands run without the user's or the system's git config, hooks or GPG signing. Alfred commits in three places: on every delivery (`Deliver <path> (run <run id>)`), at the end of every run (`Run <run id>: <title>`, the files the run wrote and the paths it moved files away from; see Agent sandbox), and when it starts (`Changes found at startup`: whatever changed while it was not running, such as files the owner edited on the host). Each commit gives the documents among its files a version |
| `$XDG_STATE_HOME/alfred/{account,sync,context-tokens}.json` | what the retired WeChat bot kept; nothing reads them any more, and they can stay or be deleted |
| `$XDG_STATE_HOME/alfred/claude/` | isolated Claude Code config dir: agent session transcripts used for resume |
| `$XDG_STATE_HOME/alfred/workspace-plugin/` | the `workspace` skills plugin: a manifest and the `skills` symlink into the workspace, recreated at startup |
| `$XDG_STATE_HOME/alfred/workbench/` | what the workbench reads: `runs.jsonl` (one line per finished run, kept for good), `runs/<id>.json` (live and recent runs with their steps, kept 30 days), `status.json` (heartbeat), `tasks.json` (the owner's tasks with their schedules, next runs, skips and last run, written on every change by the task store, its only writer), `ideas.json` (the owner's ideas in every state and the generation in progress, written on every change by the idea store, its only writer), `documents.json` (the owner's documents, with their versions, annotations and replies, written on every change by the document store, its only writer; when it does not exist yet, the first start of a version that has documents makes the files earlier outbound app messages delivered into documents, see below), `alfred.log` (the log, rotated at 5 MB to `alfred.log.1`) |
| `$ALFRED_WORKBENCH_STATE` (default `$XDG_STATE_HOME/alfred/app/`) | `devices.json`: the app's paired devices, each with its id, name, creation and revocation times and the SHA-256 of its token, never the token; a device that has registered for push also has `push`, its APNs registration (the APNs device token and the environment, as `POST /api/push` stored it); the directory is mode 700 and the file 600, rewritten atomically. The workbench re-reads it when it changes. `push-cursor.json`: the id of the last event the push dispatcher handled |
| `~/Alfred/` (override with `ALFRED_WORKSPACE`) | `ALFRED.md` (workspace rules), `inbox/`, `reports/` (a task's reports go in `reports/tasks/<task id>/`), `notes/`, `images/`, `memory/` (long-term memory), `skills/` (the owner's skills), `.trash/` |
| `$XDG_CACHE_HOME/alfred/ms-playwright/` (default `~/.cache/…`, override with `PLAYWRIGHT_BROWSERS_PATH`) | Chrome Headless Shell for PDF rendering |

At start, `node src/cli.ts run` opens the workspace's history and the document store before it starts the API and the scheduler (`startDocuments` in `src/documents/startup.ts`), and gives the one `Versions` and the one `DocumentStore` to the handler and its tools:

- It creates the git dir when it is missing, and commits the workspace as it is under the rules when the repository has no commit yet.
- It commits whatever changed while Alfred was not running as `Changes found at startup`, and gives the documents among those files a `changed` version (with no run).
- When `documents.json` does not exist yet, it imports the files delivered before documents: every file named in an outbound `app` message of the event log that still exists in the workspace as a regular file, is at most 20 MB and is not under a `.git` directory is committed in one commit, `Import files delivered before documents` (forced in, so PDFs and images go in too; files the first commit already holds add nothing to it), and registered in event-log order as a document at that commit, with the time and run (and task) of the message that delivered it. A file named by several messages is one document; messages on the retired `wechat` channel and messages from the owner are skipped. The import runs once: from then on `documents.json` exists, and a start only commits what changed.
- A failure, whether the repository cannot be opened or the documents file is unreadable, is logged and leaves Alfred running without documents: files are then delivered as plain files and no run commits, until the next start.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ALFRED_LOG` | `info` | `debug` logs the agent's stderr |
| `ALFRED_MAX_BUDGET_USD` | `10` | spend cap per query, follow-up turns and background subagents included |
| `ALFRED_DAILY_BUDGET_USD` | `20` | spend per day (owner's time zone), scheduled task runs and generations of ideas included, after which no new task, scheduled run, background subagent or generation of ideas starts; must be a finite number > 0 |
| `ALFRED_SESSION_IDLE_HOURS` | `4` | idle hours after which the next task starts a new session; `0` disables rotation, empty means the default, anything else that is not a finite number >= 0 fails at startup |
| `ALFRED_COMPACT_TOKENS` | `100000` | context size in tokens at which Claude Code compacts the session (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`); `0` leaves Claude Code's own window, empty means the default, anything else that is not 0 or a whole number of at least 20000 fails at startup; Claude Code's minimum is 100000, so a smaller value acts as 100000 |
| `ALFRED_ANTHROPIC_API_KEY` | none, required | Anthropic API key for tasks and memory scans; inherited `ANTHROPIC_*` variables are ignored |
| `ALFRED_MMX_BIN` | `$CLAUDE_CONFIG_DIR/skills/mmx/bin/mmx` (`~/.claude/…` when unset) | `mmx` executable for `generate_image`; if it is missing, the tool returns an error |
| `ALFRED_MEMORY_SCAN_MINUTES` | `60` | interval between background memory scans; `0` turns automatic scans off (`npm run memory-scan` still works); empty means the default, anything else that is not a finite number of minutes from 0 to 35791 fails at startup |
| `ALFRED_MEMORY_SCAN_BUDGET_USD` | `0.1` | spend cap for one memory scan; must be a finite number > 0 |
| `ALFRED_IDEAS_AT` | `08:00` | the time of day (24-hour `HH:MM`, in the process's time zone) of the daily generation of ideas (see Ideas); empty turns the daily generation off (the app's button still works), anything else fails at startup |
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
src/agent/          Agent SDK handler (intake queue, routing, stop), structured questions, live task input, options, workspace guard, ALFRED.md rules, skill plugins, custom tools, revision runs' prompt and notes, image generation, session lifecycle, long-term memory, persisted state
src/files.ts        file name, date and text helpers
src/pdf.ts          Markdown/HTML to PDF rendering
src/runs.ts         run ids and records, the heartbeat: what the workbench reads
src/documents/      versions of the workspace in git, the document store (the only writer of workbench/documents.json), the registering of delivered files as documents, what Alfred does about them at start, and the API's document commands over the handler
src/ideas/          the owner's ideas: the idea store (the only writer of workbench/ideas.json), the API's idea commands, archiving, the generation of ideas (inputs, prompt, call and mapping) and its daily schedule
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
node scripts/handler-smoke.ts documents        # on haiku, a three-line note is delivered and then revised and delivered again: one document with two delivered versions, whose commits name their runs
node scripts/handler-smoke.ts revision         # on haiku, a note is delivered and annotated twice on a passage and once on the whole document, through the command API: the revision run makes a revised version, answers all three annotations, and posts its message
node scripts/handler-smoke.ts prompt "text"    # one message through the real handler, then the spend per model
node scripts/app-dev.ts --port 8787            # a local Alfred for the app in the simulator: the handler behind the command API, the workbench on 127.0.0.1 with a paired device
```

The handler smoke script sends its messages through the command API and prints every message event (`[event]`: channel, direction, run id, the start of the text); a reply to the owner is such an event. The agent smoke script marks lines from inside a subagent with `[sub <id>]`, prints the SDK's `task_*` messages and the subagents still running after each tool result, and ends with the spend per model. `[first-request]` gives the first request's input tokens, to compare the prompt prefix across changes.

- `scripts/app-dev.ts` runs the real handler on the app channel with the task store, behind the command API (task commands included) on `$ALFRED_STATE_DIR/api/alfred.sock`, and the workbench on `127.0.0.1:<port>` (default 8787) without the Access check. It needs `ALFRED_STATE_DIR`, `ALFRED_WORKSPACE` and `ALFRED_ANTHROPIC_API_KEY`, and refuses to start without the first two, so point them at new scratch directories. `--model` (default `haiku`) sets the model. `--seed-ideas` writes the sample ideas when `ideas.json` does not exist yet. `--ideas-at <HH:MM>` starts the daily generation of ideas at that local time; without it the stack never generates ideas on its own, and only the app's button (`idea.generate`) does, which calls Sonnet (at most $0.20 a generation). On the first start it pairs a device named `simulator` and prints the pairing as one `[pairing]` line, plus a QR code. A later start says so, and `--repair` revokes that device and pairs a new one. Stored events print as `[event]`, message deltas and steps as `[live]`. Only the messages you send reach the model, the tasks that fall due or that you run (`task.run`), and the generations of ideas you ask for (`idea.generate`) or `--ideas-at` starts; `/status` costs nothing.

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
