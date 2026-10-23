---
name: deploy
description: Operate the deployed Alfred on its podman host over SSH. Covers updating it after a merge, restarting, rolling back, reading logs, checking whether a task is running, replacing the Anthropic key or the mmx config, and redoing the WeChat QR login. Use when the user says 部署、上线、更新线上、重启 Alfred、回滚、看日志、换 key、重新扫码登录, or after merging a PR that should go live.
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
- Before restarting it waits, up to 15 minutes, for a running task or memory scan to finish. A restart kills a running task and the user never gets the reply, so never restart with `systemctl` or `podman` directly to save time. Run the script in the background or with a long timeout. If it gives up, nothing was restarted. Run it again later.
- If `deploy/alfred.container` changed, the script stops and prints the diff against the installed Quadlet. The installed copy may carry host edits such as `TZ`. Read the diff, then rerun with `--install-quadlet` to replace it or `--keep-quadlet` to keep it, editing the installed file by hand if it needs the new lines.
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

## WeChat login

A new login is needed when iLink rejects the bot token or the owner changes. The scanner becomes the owner of a newly bound bot. The login shows a QR code and may ask for a number shown on the phone, so run it in a terminal tab the user can see:

1. `ssh $HOST alfred/deploy/update.sh --stop`
2. `ssh -t $HOST 'podman run --rm -it --userns=keep-id:uid=1000,gid=1000 -v "$HOME/data/state:/data/state" localhost/alfred:latest node src/cli.ts login'`
3. `ssh $HOST systemctl --user start alfred`

## Don't

- Run a second Alfred (`npm start`, an echo container) against the same state dir while the Quadlet runs. Two processes take messages from each other.
- Copy a state dir from another machine onto a running deployment. It rewinds the poll cursor.
