#!/bin/sh
# The alfred-backup container's job (deploy/alfred-backup.container): back up
# Alfred's data with restic, apply the retention policy, check the repository,
# and record the outcome in /backup/status.json. Any failure exits non-zero, so
# the unit fails and the error is in `journalctl --user -u alfred-backup`.
#
# status.json: {"ok", "lastRun", "error"} for the last run, and
# {"lastSuccess", "snapshot", "files", "bytes", "added", "repoBytes"} from the
# last successful one, which a failed run keeps.
set -eu

host=alfred
status=/backup/status.json
out=/tmp/backup.json
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)

write_status() {
  prev=$(cat "$status" 2>/dev/null || echo '{}')
  printf '%s' "$prev" | jq -c "$@" >"$status.tmp" && mv "$status.tmp" "$status"
}

fail() {
  echo "alfred-backup: $1" >&2
  write_status --arg now "$now" --arg error "$1" '. + {ok: false, lastRun: $now, error: $error}' || true
  exit 1
}

# Exit code 10: the repository does not exist yet, so this is the first run.
rc=0
restic cat config >/dev/null 2>/tmp/err || rc=$?
case $rc in
  0) ;;
  10) restic init || fail "restic init failed" ;;
  *) cat /tmp/err >&2; fail "cannot open the repository (restic exit $rc)" ;;
esac

# Exit code 3 means a snapshot was made but some files could not be read:
# still a failure, since that snapshot is incomplete.
rc=0
restic backup --json --host "$host" \
  --exclude memory.lock --exclude '*.tmp' \
  --exclude /data/state/api --exclude /data/state/workspace-plugin \
  /data/state /data/workspace /data/workbench-app >"$out" || rc=$?
summary=$(jq -c 'select(.message_type == "summary")' "$out" 2>/dev/null || true)
[ "$rc" -eq 0 ] || fail "restic backup exited $rc"
[ -n "$summary" ] || fail "restic backup printed no summary"

restic forget --host "$host" --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune ||
  fail "restic forget --prune failed"
restic check --read-data-subset=10% || fail "restic check failed"
repo_bytes=$(restic stats --json --mode raw-data | jq -e '.total_size') || fail "restic stats failed"

write_status --arg now "$now" --argjson s "$summary" --argjson repo "$repo_bytes" '{
  ok: true, lastRun: $now, lastSuccess: $now,
  snapshot: $s.snapshot_id, files: $s.total_files_processed,
  bytes: $s.total_bytes_processed, added: $s.data_added, repoBytes: $repo
}' || fail "cannot write $status"
printf '%s' "$summary" | jq -r '"backup \(.snapshot_id[:8]): \(.total_files_processed) files, \(.total_bytes_processed) bytes, \(.data_added) added"'
