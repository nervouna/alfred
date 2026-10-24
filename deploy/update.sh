#!/usr/bin/env bash
# Update Alfred on its podman host: pull, build, then restart once no task is
# running. Run it from the repo checkout as the user that owns the Quadlet.
#
#   deploy/update.sh               pull, build, restart if the image or the Quadlet changed
#   deploy/update.sh --restart     restart the current build
#   deploy/update.sh --rollback    switch back to the image that ran before the last update
#   deploy/update.sh --stop        stop Alfred, e.g. for a new QR login
#
#   --wait SECONDS       how long to wait for a running task (default 900)
#   --force              restart without waiting; live runs are lost and named
#                        in the owner's next message
#   --install-quadlet    replace installed Quadlets that differ from deploy/
#   --keep-quadlet       keep installed Quadlets that differ from the repo's
#
# When the workbench pod is installed (workbench.pod next to alfred.container),
# an update also installs its changed Quadlets and restarts it on a new image.
set -euo pipefail

repo=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
state_dir=${ALFRED_HOST_STATE_DIR:-$HOME/data/state}
systemd_dir=${XDG_CONFIG_HOME:-$HOME/.config}/containers/systemd
quadlet=$systemd_dir/alfred.container
workbench_units="workbench.pod workbench.container workbench-tunnel.container"
unit=alfred
image=localhost/alfred:latest
previous=localhost/alfred:previous

mode=update
wait_s=900
force=
quadlet_choice=
while [ $# -gt 0 ]; do
  case $1 in
    --restart) mode=restart ;;
    --rollback) mode=rollback ;;
    --stop) mode=stop ;;
    --wait) wait_s=${2:?--wait needs a number of seconds}; shift ;;
    --force) force=1 ;;
    --install-quadlet) quadlet_choice=install ;;
    --keep-quadlet) quadlet_choice=keep ;;
    -h | --help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "update.sh: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
die() { printf 'update.sh: %s\n' "$*" >&2; exit 1; }

running_image() { podman inspect "${1:-$unit}" --format '{{.Image}}' 2>/dev/null || true; }

workbench_installed() { [ -f "$systemd_dir/workbench.pod" ]; }

# The workbench only reads, so it restarts without waiting for a task.
update_workbench() {
  if [ -n "$workbench_changed" ]; then
    for u in $workbench_units; do install -m644 "$repo/deploy/$u" "$systemd_dir/$u"; done
    systemctl --user daemon-reload
    say "Installed the repo's workbench Quadlets."
  fi
  systemctl --user restart workbench.service
  [ -z "$workbench_changed" ] || systemctl --user restart workbench-tunnel.service
  say "The workbench runs image $(running_image workbench | cut -c1-12)."
}

# Tasks and memory scans hold $state_dir/memory.lock. A lock taken before the
# container started is left over from a killed one; its pid proves nothing,
# because the new container reuses the same low pids.
lock_state() {
  local lock=$state_dir/memory.lock since started
  [ -f "$lock" ] || { echo free; return; }
  [ "$(podman inspect "$unit" --format '{{.State.Running}}' 2>/dev/null)" = true ] || { echo stale; return; }
  since=$(sed -n 's/.*"since":"\([^"]*\)".*/\1/p' "$lock")
  [ -n "$since" ] || { echo busy; return; } # still being written
  started=$(podman inspect "$unit" --format '{{.State.StartedAt.Unix}}')
  if [ "$(date -d "$since" +%s)" -ge "$started" ]; then echo busy; else echo stale; fi
}

# Runs Alfred is working on, one "id title" per line, from the workbench's run files.
live_runs() {
  local f
  for f in "$state_dir"/workbench/runs/*.json; do
    [ -f "$f" ] || continue
    grep -qE '"status": "(running|queued)"' "$f" || continue
    printf '  %s %s\n' "$(basename "$f" .json)" "$(sed -n 's/^  "title": "\(.*\)",$/\1/p' "$f" | head -1)"
  done
}

wait_until_idle() {
  local deadline=$((SECONDS + wait_s)) told=
  if [ -n "$force" ]; then
    [ "$(lock_state)" = free ] || say "Not waiting (--force); these runs will be lost:"$'\n'"$(live_runs)"
    return
  fi
  while :; do
    case $(lock_state) in
      free) return ;;
      stale)
        say "Removing a lock left by an earlier container: $(cat "$state_dir/memory.lock")"
        rm -f "$state_dir/memory.lock"
        return ;;
    esac
    if [ "$SECONDS" -ge "$deadline" ]; then
      say "Still busy after ${wait_s}s ($(cat "$state_dir/memory.lock")). Live runs:"$'\n'"$(live_runs)" >&2
      die "nothing was restarted; run again later, or with --force to restart anyway"
    fi
    [ -n "$told" ] || say "Waiting for the running task or memory scan to finish: $(cat "$state_dir/memory.lock")"
    told=1
    sleep 10
  done
}

restart() {
  local t0
  t0=$(date +%s)
  systemctl --user restart "$unit"
  for _ in $(seq 60); do
    if journalctl --user -u "$unit" --since "@$t0" -o cat --no-pager 2>/dev/null | grep -q "Alfred running"; then
      say "Alfred is running image $(running_image | cut -c1-12)."
      return
    fi
    sleep 1
  done
  journalctl --user -u "$unit" --since "@$t0" -o cat --no-pager | tail -20 >&2 || true
  die "Alfred did not report running within 60s of the restart"
}

[ -f "$quadlet" ] || die "no Quadlet at $quadlet; install deploy/alfred.container first (see the README)"

case $mode in
  restart)
    wait_until_idle
    restart
    ;;

  stop)
    wait_until_idle
    systemctl --user stop "$unit"
    say "Alfred is stopped; start it again with: systemctl --user start $unit"
    ;;

  rollback)
    podman image exists "$previous" || die "no $previous image to roll back to"
    wait_until_idle
    podman tag "$previous" "$image"
    restart
    workbench_changed=
    if workbench_installed; then update_workbench; fi
    ;;

  update)
    # Pull first, so the Quadlets compared below are the ones this update brings.
    if git -C "$repo" symbolic-ref -q HEAD >/dev/null; then
      git -C "$repo" pull --ff-only --quiet
    else
      say "HEAD is detached; building the checked-out commit as it is."
    fi
    say "Code: $(git -C "$repo" log --oneline -1)"

    quadlet_changed=
    if ! cmp -s "$repo/deploy/alfred.container" "$quadlet"; then
      case $quadlet_choice in
        install) quadlet_changed=1 ;;
        keep) say "Keeping the installed Quadlet, which differs from deploy/alfred.container." ;;
        *)
          diff -u "$quadlet" "$repo/deploy/alfred.container" >&2 || true
          die "the installed Quadlet differs from deploy/alfred.container (diff above); rerun with --install-quadlet to replace it or --keep-quadlet to keep it" ;;
      esac
    fi
    workbench_changed=
    if workbench_installed; then
      for u in $workbench_units; do
        cmp -s "$repo/deploy/$u" "$systemd_dir/$u" && continue
        case $quadlet_choice in
          install) workbench_changed=1 ;;
          keep) say "Keeping the installed $u, which differs from deploy/$u." ;;
          *)
            diff -u "$systemd_dir/$u" "$repo/deploy/$u" >&2 || true
            die "the installed $u differs from deploy/$u (diff above); rerun with --install-quadlet to replace it or --keep-quadlet to keep it" ;;
        esac
      done
    fi

    podman build --quiet -t "$image" "$repo" >/dev/null

    current=$(running_image)
    built=$(podman image inspect "$image" --format '{{.Id}}')
    if [ "$current" = "$built" ] && [ -z "$quadlet_changed" ]; then
      if workbench_installed && { [ "$(running_image workbench)" != "$built" ] || [ -n "$workbench_changed" ]; }; then
        update_workbench
        exit 0
      fi
      say "Alfred already runs this build; nothing to restart."
      exit 0
    fi

    wait_until_idle
    if [ -n "$quadlet_changed" ]; then
      install -m644 "$repo/deploy/alfred.container" "$quadlet"
      systemctl --user daemon-reload
      say "Installed the repo's Quadlet."
    fi
    if [ -n "$current" ] && [ "$current" != "$built" ]; then
      podman tag "$current" "$previous"
    fi
    restart
    if workbench_installed; then update_workbench; fi
    podman image prune -f >/dev/null
    ;;
esac
