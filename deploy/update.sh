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
#   --install-quadlet    replace the installed Quadlet with deploy/alfred.container
#   --keep-quadlet       keep an installed Quadlet that differs from the repo's
set -euo pipefail

repo=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
state_dir=${ALFRED_HOST_STATE_DIR:-$HOME/data/state}
quadlet=${XDG_CONFIG_HOME:-$HOME/.config}/containers/systemd/alfred.container
unit=alfred
image=localhost/alfred:latest
previous=localhost/alfred:previous

mode=update
wait_s=900
quadlet_choice=
while [ $# -gt 0 ]; do
  case $1 in
    --restart) mode=restart ;;
    --rollback) mode=rollback ;;
    --stop) mode=stop ;;
    --wait) wait_s=${2:?--wait needs a number of seconds}; shift ;;
    --install-quadlet) quadlet_choice=install ;;
    --keep-quadlet) quadlet_choice=keep ;;
    -h | --help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "update.sh: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
die() { printf 'update.sh: %s\n' "$*" >&2; exit 1; }

running_image() { podman inspect "$unit" --format '{{.Image}}' 2>/dev/null || true; }

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

wait_until_idle() {
  local deadline=$((SECONDS + wait_s)) told=
  while :; do
    case $(lock_state) in
      free) return ;;
      stale)
        say "Removing a lock left by an earlier container: $(cat "$state_dir/memory.lock")"
        rm -f "$state_dir/memory.lock"
        return ;;
    esac
    [ "$SECONDS" -lt "$deadline" ] ||
      die "still busy after ${wait_s}s ($(cat "$state_dir/memory.lock")); nothing was restarted, run again later"
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
    ;;

  update)
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

    if git -C "$repo" symbolic-ref -q HEAD >/dev/null; then
      git -C "$repo" pull --ff-only --quiet
    else
      say "HEAD is detached; building the checked-out commit as it is."
    fi
    say "Code: $(git -C "$repo" log --oneline -1)"
    podman build --quiet -t "$image" "$repo" >/dev/null

    current=$(running_image)
    built=$(podman image inspect "$image" --format '{{.Id}}')
    if [ "$current" = "$built" ] && [ -z "$quadlet_changed" ]; then
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
    podman image prune -f >/dev/null
    ;;
esac
