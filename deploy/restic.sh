#!/usr/bin/env bash
# Run restic against Alfred's backup repository, with the image, secrets and
# repository of deploy/alfred-backup.container. Run it as the Alfred host user:
#
#   deploy/restic.sh snapshots
#   deploy/restic.sh ls latest
#   deploy/restic.sh restore latest --target /restore
#
# /restore is $RESTORE_DIR on the host (default ~/restore), created if missing.
set -euo pipefail

repo=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
image=$(sed -n 's/^Image=//p' "$repo/deploy/alfred-backup.container")
restore_dir=${RESTORE_DIR:-$HOME/restore}
mkdir -p "$HOME/data/backup/cache" "$restore_dir"

tty=()
[ -t 0 ] && tty=(-it)
exec podman run --rm "${tty[@]}" \
  --env-file "${XDG_CONFIG_HOME:-$HOME/.config}/alfred/backup.env" \
  --env RESTIC_CACHE_DIR=/cache --env AWS_DEFAULT_REGION=auto \
  --secret alfred_backup_key_id,type=env,target=AWS_ACCESS_KEY_ID \
  --secret alfred_backup_secret_key,type=env,target=AWS_SECRET_ACCESS_KEY \
  --secret alfred_backup_password,type=env,target=RESTIC_PASSWORD \
  -v "$HOME/data/backup/cache:/cache" -v "$restore_dir:/restore" \
  --security-opt no-new-privileges --cap-drop all \
  "$image" "$@"
