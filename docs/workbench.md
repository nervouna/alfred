# Workbench

A read-only web view of Alfred's work, and the app's way in (`/api/`). Code: `src/workbench/` (`server.ts` routes, `access.ts`, `devices.ts`, `forward.ts`, `push.ts`, `apns.ts`, `pairing.ts`), started by `node src/cli.ts workbench`.

## Pages

- **Read-only.** Every page answers only `GET`. They read `$STATE_DIR/workbench/` (`runs.jsonl` for good, `runs/<id>.json` with the step timeline for 30 days, `status.json` as the heartbeat, `alfred.log`), the transcripts under `claude/projects/` and the workspace. Nothing a page does reaches Alfred, and Alfred never reads from the workbench.
- **Confined.** Output is escaped, Markdown has no raw HTML, paths stay inside the workspace, `.git` is hidden, and HTML and SVG download instead of opening outside the report viewer.
- **Runs** have a short id (`k7m2qa`) shown on their card. A reply from a run that wrote files ends with the id, or a card link when `ALFRED_WORKBENCH_URL` is set. An id pasted into a message adds that run's title, status and files to the prompt.
- **HTML reports** open in a sandboxed frame without `allow-same-origin`. Inline scripts and styles run so charts draw, but `REPORT_CSP` blocks every request, so a report can neither read the workbench nor send anything out. Workspace images are inlined as `data:` URIs. With `ALFRED_WORKBENCH=on` (or a URL), the agent is told reports can be read here.

## Access

Two listeners share one handler.

- **TCP** (`ALFRED_WORKBENCH_LISTEN`, default `127.0.0.1:8787`) is for the Cloudflare tunnel. Every request needs a `Cf-Access-Jwt-Assertion` that this process checks itself (RS256 signature from the team's keys, AUD, issuer, expiry, the owner's email), so a request that arrives some other way gets nothing. It needs `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` and `ALFRED_WORKBENCH_OWNER_EMAIL`, or it does not start.
- **Unix socket** (`ALFRED_WORKBENCH_SOCKET`, 0600) needs no Access token. It is the fallback for an SSH tunnel (the deploy skill has the command).
- **Service token.** The app's Access service token is a JWT whose `common_name` is `CF_ACCESS_SERVICE_CLIENT_ID` and which has no email. It is accepted on `/api/` only, and refused everywhere if that variable is unset. Pages take the owner's JWT only.
- `workbench --dev` serves loopback only, with no Access check; `/api/` still wants a device token.

## The app's API

`/api/` takes `GET` and `POST` and answers errors as `{"error": "…"}`. Two checks come first: the Access JWT on the tunnel (403), then on every listener a paired, unrevoked device's bearer token (401). Routes are in `apiRoute` (`server.ts`), shapes in `src/api/schema.ts`.

- **Forwarded** to Alfred's socket by `forward.ts`: `POST /api/commands`, `POST /api/uploads` and `GET /api/events` take what [the command API](api.md) takes. A command is checked with `parseCommand` first, so only what Alfred would accept goes on, and the workbench holds no Alfred secret. While the socket cannot be reached the answer is 503 and the app retries.
- **Read here:** `GET /api/runs`, `/api/runs/<id>`, `/api/tasks`, `/api/tasks/<id>`, `/api/ideas`, `/api/documents`, `/api/documents/<id>`, `/api/rules` (the root `ALFRED.md` with its version; 413 over 64 KB), `/api/memories` (the long-term memories with their versions, in the order of the system prompt's index), `/api/settings` and `/api/files/<path>` (a workspace file under `Content-Security-Policy: sandbox`; `?version=<commit>` reads it from the workspace's history).
- **`GET /api/settings`** answers the effective settings and `spentTodayUsd`, the owner's local day's spend by the rule of the overview page's "today" (runs that started today, subagents left out). The settings come from `workbench/settings.json`, which the settings store rewrites at startup and on every change: this process does not see Alfred's environment, so it cannot work the values out itself. While the file is missing, unreadable or does not fit, the answer is 503.
- **Also:** `GET /api/ping` (204) and `POST /api/push`, which stores the device's APNs registration.

## Pairing and devices

- `node src/cli.ts pair [--name <name>] [--json]` creates a device and shows one QR code with the server URL (`ALFRED_WORKBENCH_URL`: an `https://` origin, `http://` only on loopback), the Access service token and the new device's token, so one scan sets the app up. On the host: `podman exec -it workbench node src/cli.ts pair --name <name>`.
- `devices` lists them and `devices revoke <id>` locks one out. The workbench re-reads `devices.json` when it changes, so the next request is refused with no restart. The file keeps only each token's SHA-256: a token lost with its phone cannot be read back, so revoke and pair again.

## Push

`notificationFor` (`push.ts`) is the one rule: an outbound app message and a question Alfred asks notify, nothing else does. The title is `Alfred`; the body is the text cut to 100 characters, `文件：<name>` for a file-only message, `Alfred 想问你：…` for a question. The payload carries `eventId` and `runId` so the app opens the right place.

- A dispatcher in the workbench follows Alfred's `/events` from the cursor in `push-cursor.json`. With no cursor it starts after the latest event, so old events never push; the cursor is saved after each event, so a restart pushes nothing twice.
- Delivery is best effort. A token APNs reports dead (410, or 400 `BadDeviceToken`) is removed from its device; any other refusal is logged, not retried. A `development` registration goes to APNs's sandbox, a `production` one to production.
- With any of the four `ALFRED_APNS_*` variables missing, push is off and the log names it ([Configuration](../README.md#configuration)). `node src/cli.ts apns-test [text]` sends one test notification to every registered device.

## Host setup

The workbench and a dedicated `cloudflared` run in their own pod (`deploy/workbench.pod`, `workbench.container`, `workbench-tunnel.container`) from the Alfred image, so `deploy/update.sh` restarts them. The container mounts only what it shows, read-only; the writable paths are the socket directory and `~/data/workbench-app` (`devices.json`).

1. In Cloudflare, create a remotely managed tunnel whose public hostname points at `http://localhost:8787`, and an Access application on that hostname that allows only your email. For the app, create a service token (Zero Trust, Access, Service Auth) and add a Service Auth policy that includes it to the application.
2. On the host:

   ```bash
   mkdir -p ~/data/state/workbench ~/data/state/api ~/data/state/claude/projects ~/data/workbench-socket ~/data/workbench-app ~/.config/alfred
   read -rs TOKEN && printf %s "$TOKEN" | podman secret create workbench_tunnel_token - && unset TOKEN   # the tunnel token
   podman secret create alfred_apns_key <path to AuthKey_<key id>.p8>
   # write ~/.config/alfred/workbench.env with the variables listed at the top of deploy/workbench.container
   install -m644 deploy/workbench.pod deploy/workbench.container deploy/workbench-tunnel.container ~/.config/containers/systemd/
   systemctl --user daemon-reload && systemctl --user start workbench-pod
   ```

3. Set `Environment=ALFRED_WORKBENCH=on` for Alfred in a drop-in such as `alfred.container.d/workbench.conf` (under `[Container]`), never in `alfred.container`, then `systemctl --user daemon-reload` and `deploy/update.sh --restart`. Add `ALFRED_WORKBENCH_URL=https://<hostname>` there to put card links in replies, only when the device that opens them gets through the Access sign-in; unset, replies carry the run id only.
4. Pair the app as above.
