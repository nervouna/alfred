---
name: deploy
description: Operate the deployed Alfred on its podman host over SSH. Covers updating it after a merge, restarting, rolling back, reading logs, checking whether a task is running, replacing the Anthropic key or the mmx config, and pairing or revoking the app. Use when the user says 部署、上线、更新线上、重启 Alfred、回滚、看日志、换 key、配对 app、撤销设备, or after merging a PR that should go live.
---

# Operating the deployed Alfred

Alfred runs on a Linux host as a rootless podman Quadlet, set up as in the README's "Run in a container (Linux)" section. `deploy/update.sh` does the routine work on the host; this skill says when to run what.

## The host

- The SSH alias for the host's Alfred user, and anything else specific to that host, are in the project memory, not in this public repo. If memory has none, ask the user. Below, `$HOST` stands for that alias.
- Everything runs as that unprivileged user. Never use root for Alfred, and leave other services on the host alone.
- Write remote paths relative to the remote home (`alfred/deploy/update.sh`) or inside single quotes. An unquoted `~` or `$HOME` is expanded by the local shell to the workstation's home.

## Update after a merge

```bash
ssh $HOST alfred/deploy/update.sh
```

- It pulls, builds, and restarts only when the image or the Quadlet changed. A docs-only merge ends with "Alfred already runs this build".
- Before restarting it waits, up to 15 minutes, for a running task or memory scan to finish. A task's query stays open while its background subagents run, so the wait can run out. If it gives up, nothing was restarted, and it lists the live runs: tell the user which ones, and run it again later. `--force` restarts anyway. Alfred stops its tasks cleanly on the way down, records them as lost, and names them in the owner's next message, so use it only when the user agrees to lose those runs. Never restart with `systemctl` or `podman` directly to save time. Run the script in the background or with a long timeout.
- If `deploy/alfred.container` changed, the script stops and prints the diff against the installed Quadlet. Read the diff, then rerun with `--install-quadlet` to replace it. The installed copy should never carry host edits: host settings (`TZ`, `ALFRED_WORKBENCH`, `ALFRED_WORKBENCH_URL`, …) live in drop-ins under `~/.config/containers/systemd/alfred.container.d/`, which survive `--install-quadlet`. If the diff shows a host edit in the installed file, move it into a drop-in first. `--keep-quadlet` keeps the installed copy for this run only.
- `--restart` restarts the current build, e.g. after changing a secret. `--rollback` goes back to the image that ran before the last update.

## Health and logs

```bash
ssh $HOST 'systemctl --user is-active alfred; journalctl --user -u alfred -n 60 --no-pager -o cat'
```

- Each task logs `agent run start` and `agent run done` (cost, duration, tools). `render_pdf`, `generate_image`, `send_file` and memory scans log their own lines.
- A start without a matching done means a task is running.
- `memory lock still held by …; running the task anyway` means the task waited minutes for the lock. If no other task or memory scan was running, the lock is stale. The bot takes over locks left by a killed container (#20), so look for another process holding it, e.g. a manual `memory-scan`. `update.sh --restart` removes a stale lock.

## Secrets

Podman reads secrets when the container starts, so run `update.sh --restart` after changing one.

- **Anthropic key.** Never ask the user to paste it into the chat. Open a terminal tab for them with:

  ```bash
  ssh -t $HOST 'read -rsp "Anthropic API key: " KEY && echo && printf %s "$KEY" | podman secret create --replace alfred_anthropic_api_key - >/dev/null && echo saved'
  ```

  `printf %s` keeps the trailing newline out. An env secret keeps its bytes as they are, and a newline breaks the key.
- **mmx config.** Pipe the workstation's file, `$MMX_CONFIG_DIR/config.json` or `~/.mmx/config.json`:

  ```bash
  ssh $HOST podman secret create --replace alfred_mmx_config - < /path/to/mmx/config.json
  ```

  To check it, run `ssh $HOST podman exec alfred mmx quota show`. Ignore `mmx auth status`: it reports "Not authenticated" even when calls work.

## Workbench

The read-only workbench and its `cloudflared` run in the `workbench` pod, set up as in the README's "Workbench" section. The tunnel hostname, the Access team domain, AUD tag and owner email belong in project memory and `~/.config/alfred/workbench.env` on the host, never in this repo.

- `update.sh` restarts the workbench after an update. It does not wait for a task, because the workbench only reads. If the installed workbench Quadlets differ from `deploy/`, the same `--install-quadlet` and `--keep-quadlet` choice applies.
- Health and logs: `ssh $HOST 'systemctl --user is-active workbench workbench-tunnel; journalctl --user -u workbench -n 40 --no-pager -o cat'`. `workbench refused … : <reason>` lines are requests without a valid Access token.
- When the tunnel or Access is down, use the socket: `ssh -N -L 8787:/home/<user>/data/workbench-socket/workbench.sock $HOST`, then open `http://localhost:8787`.
- On the first deploy, check:
  - the public URL redirects to the Access login, and inside the pod a request without a valid token gets 403: `podman exec workbench node -e 'fetch("http://127.0.0.1:8787/").then((r) => console.log(r.status))'`;
  - writing inside the container fails: `podman exec workbench sh -c 'touch /x /tmp/x /data/state/workbench/x /workspace/x'`;
  - a request with the app's service token and a paired device's bearer gets 204 from `/api/ping` through the public URL. Pair a throwaway device for it and revoke it afterwards.

## Pairing the app

The owner pairs a phone by scanning a QR code that holds the server's address, the Access service token and a new device token, so run it in a terminal tab the user can see, and never paste its output into the chat:

```bash
ssh -t $HOST 'podman exec -it workbench node src/cli.ts pair --name <device name>'
```

List devices with `podman exec workbench node src/cli.ts devices` and lock one out with `devices revoke <id>`; a revoke applies to the next request. `podman exec workbench node src/cli.ts apns-test "<text>"` sends one push to every registered device and prints APNs's answer.

## Don't

- Run a second Alfred (`npm start`, another container) against the same state dir while the Quadlet runs. Two processes would write the same state and event log.
- Copy a state dir from another machine onto a running deployment. It rewinds the event log the app resumes from.
