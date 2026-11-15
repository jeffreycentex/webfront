#!/usr/bin/env bash
# Restore Webfront from a backup archive. Run as root.
#   webfront-restore /var/lib/webfront/backups/webfront-YYYYmmdd-HHMMSS.tar.gz [--yes]
#   webfront-restore --new-epoch [--yes]
# Stops the service, moves current data aside (not deleted), restores, marks the database as
# restored (a new sync epoch), restarts.
#
# The restored database is authoritative: every device that syncs afterwards sees the new
# epoch, discards its local copy and its unsynced changes (set aside on the device, offered as
# a JSON download) and downloads the restored data. Without the new epoch devices would push
# their newer local state (including deletions) back onto the restored database.
#
# --new-epoch only marks the CURRENT database as restored (stop, new epoch, start). Use it after
# putting a database file in place by hand (e.g. copying an old webfront.db back), which
# otherwise keeps the epoch it had and is NOT treated as a restore by the devices.
set -euo pipefail

# The restore marker. Keep identical to RESTORE_EPOCH_SQL in apps/web/src/data/test/harness.ts
# and migration 020 (key `sync_epoch`, 32 lowercase hex chars). Constant SQL: no interpolation.
EPOCH_SQL="INSERT INTO meta (key, value) VALUES ('sync_epoch', lower(hex(randomblob(16)))) ON CONFLICT(key) DO UPDATE SET value = excluded.value;"

# read_epoch DB -> prints the stored epoch (empty if none).
read_epoch() {
  sqlite3 -bail "$1" ".timeout 10000" "SELECT value FROM meta WHERE key = 'sync_epoch';"
}

# write_epoch DB -> writes a fresh epoch, verifies it, prints it. Non-zero exit on any failure.
# Idempotent (each run just writes another fresh value). Leaves no -wal/-shm files behind, so
# the file can be moved and chowned on its own.
write_epoch() {
  local db="$1" before after
  [ -f "$db" ] || { echo "write_epoch: no database at $db" >&2; return 1; }
  before="$(read_epoch "$db" 2>/dev/null || true)"
  sqlite3 -bail "$db" ".timeout 10000" "$EPOCH_SQL" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null ||
    { echo "write_epoch: sqlite3 failed on $db" >&2; return 1; }
  after="$(read_epoch "$db")" || { echo "write_epoch: cannot read the epoch back" >&2; return 1; }
  if ! [[ "$after" =~ ^[0-9a-f]{32}$ ]]; then
    echo "write_epoch: unexpected epoch value '$after'" >&2; return 1
  fi
  if [ "$after" = "$before" ]; then
    echo "write_epoch: the epoch did not change" >&2; return 1
  fi
  printf '%s\n' "$after"
}

# Sourced (tests): only define the functions above.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then return 0; fi

ENV_FILE=/etc/webfront/webfront.env
if [ -r "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
DATA_DIR="${DATA_DIR:-/var/lib/webfront}"
PORT="${PORT:-8787}"
ARCHIVE=""; YES=""; NEW_EPOCH_ONLY=""
for arg in "$@"; do
  case "$arg" in
    --yes) YES=1 ;;
    --new-epoch) NEW_EPOCH_ONLY=1 ;;
    -*) echo "restore: unknown option $arg" >&2; exit 2 ;;
    *) [ -z "$ARCHIVE" ] || { echo "restore: more than one archive given" >&2; exit 2; }; ARCHIVE="$arg" ;;
  esac
done

die() { echo "restore: $*" >&2; exit 1; }
usage() {
  echo "usage: $0 <backup.tar.gz> [--yes]"
  echo "       $0 --new-epoch [--yes]   (mark the current database as restored)"
  echo "available:"; ls -1t "$DATA_DIR"/backups/webfront-*.tar.gz 2>/dev/null | head -10
}
[ "$(id -u)" -eq 0 ] || die "run as root"
command -v sqlite3 >/dev/null || die "sqlite3 is not installed"

DEVICES_WARNING="Every device will DISCARD changes it has not synced yet (they are set aside on that device
and can be downloaded there as JSON) and reload its data from the restored database."

wait_healthy() {
  for _ in $(seq 1 30); do
    curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/health" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

confirm() {
  [ -n "$YES" ] && return 0
  read -r -p "Type 'restore' to continue: " ans
  [ "$ans" = "restore" ] || die "aborted"
}

if [ -n "$NEW_EPOCH_ONLY" ]; then
  [ -z "$ARCHIVE" ] || die "--new-epoch takes no archive"
  DB="$DATA_DIR/webfront.db"
  [ -f "$DB" ] || die "no database at $DB"
  echo "This marks the current database in $DB as restored."
  echo "$DEVICES_WARNING"
  confirm
  echo "Stopping webfront"
  systemctl stop webfront.service
  # Checkpoint the service's WAL into the main file first (no-op without one).
  EPOCH="$(write_epoch "$DB")" || die "could not write the restore marker; the service is STOPPED. Fix the error above and rerun, then: systemctl start webfront"
  chown webfront:webfront "$DB"
  for f in "$DB-wal" "$DB-shm"; do [ -e "$f" ] && chown webfront:webfront "$f"; done
  echo "New sync epoch: $EPOCH"
  echo "Starting webfront"
  systemctl start webfront.service
  wait_healthy || die "service did not become healthy. Check: journalctl -u webfront -n 50"
  echo "Done. Devices will reload their data from this database on their next sync."
  exit 0
fi

[ -n "$ARCHIVE" ] || { usage; exit 2; }
[ -r "$ARCHIVE" ] || die "cannot read $ARCHIVE"

# Validate the archive before touching anything.
LIST="$(tar -tzf "$ARCHIVE")" || die "not a valid archive"
# No `grep -q` in these pipelines: with pipefail, grep exiting at the first match can kill the
# writer with SIGPIPE on a long listing, and the failed pipeline would hide the match.
if printf '%s\n' "$LIST" | grep -E '^/|(^|/)\.\.(/|$)' >/dev/null; then die "archive contains unsafe paths"; fi
printf '%s\n' "$LIST" | grep -x 'webfront.db' >/dev/null || die "archive has no webfront.db"
if printf '%s\n' "$LIST" | grep -Ev '^(webfront\.db|attachments(/.*)?)$' >/dev/null; then
  die "archive has unexpected entries"
fi
# Regular files and directories only: a symlink or hard link (e.g. attachments -> /etc) could
# point the service, or this root-run script, outside the data directory. The backups directory
# is writable by the service user, so do not trust an archive just because it is in there.
TYPES="$(tar -tvzf "$ARCHIVE" | cut -c1 | sort -u | tr -d '\n')"
case "$TYPES" in *[!d-]*) die "archive contains links or special files" ;; esac
STAGE="$(mktemp -d "$DATA_DIR/.restore.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
tar -xzf "$ARCHIVE" -C "$STAGE" --no-same-owner
[ "$(sqlite3 "$STAGE/webfront.db" 'PRAGMA integrity_check;')" = "ok" ] || die "database in archive is corrupt"
# Mark the staged copy first: if the marker cannot be written, stop before touching anything
# (a restore without it would silently let devices push their old state back).
write_epoch "$STAGE/webfront.db" >/dev/null || die "could not write the restore marker into the backup copy; nothing was changed"

echo "This will REPLACE the current Webfront data in $DATA_DIR with:"
echo "  $ARCHIVE"
echo "Current data is moved to $DATA_DIR/pre-restore-<timestamp>, not deleted."
echo "$DEVICES_WARNING"
confirm

echo "Stopping webfront"
systemctl stop webfront.service
ASIDE="$DATA_DIR/pre-restore-$(date +%Y%m%d-%H%M%S)"
mkdir "$ASIDE"
for f in webfront.db webfront.db-wal webfront.db-shm attachments; do
  [ -e "$DATA_DIR/$f" ] && mv "$DATA_DIR/$f" "$ASIDE/"
done
mv "$STAGE/webfront.db" "$DATA_DIR/webfront.db"
if [ -d "$STAGE/attachments" ]; then mv "$STAGE/attachments" "$DATA_DIR/attachments"; else mkdir "$DATA_DIR/attachments"; fi

# The restored database now in place gets its own fresh marker before the service starts. The
# staged copy already carries a new one, so if this second write fails the restore is still
# authoritative; the check below makes sure of that either way.
if EPOCH="$(write_epoch "$DATA_DIR/webfront.db")"; then
  echo "New sync epoch: $EPOCH"
else
  EPOCH="$(read_epoch "$DATA_DIR/webfront.db" 2>/dev/null || true)"
  OLD_EPOCH="$(read_epoch "$ASIDE/webfront.db" 2>/dev/null || true)"
  if ! [[ "$EPOCH" =~ ^[0-9a-f]{32}$ ]] || [ "$EPOCH" = "$OLD_EPOCH" ]; then
    die "the restored database has no new restore marker; the service is STOPPED. Run: webfront-restore --new-epoch (previous data is in $ASIDE)"
  fi
  echo "warning: rewriting the marker in place failed; using the one written to the staged copy ($EPOCH)" >&2
fi

chown -R webfront:webfront "$DATA_DIR/webfront.db" "$DATA_DIR/attachments" "$ASIDE"
for f in "$DATA_DIR/webfront.db-wal" "$DATA_DIR/webfront.db-shm"; do
  [ -e "$f" ] && chown webfront:webfront "$f"
done
chmod 0640 "$DATA_DIR/webfront.db"

echo "Starting webfront"
systemctl start webfront.service
if wait_healthy; then
  echo "Restored and healthy. Previous data kept in $ASIDE (delete it when you are satisfied)."
  echo "Devices replace their data with the restored data on their next sync."
  exit 0
fi
die "service did not become healthy; previous data is in $ASIDE. Check: journalctl -u webfront -n 50"
