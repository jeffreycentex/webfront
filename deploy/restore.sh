#!/usr/bin/env bash
# Restore Webfront from a backup archive. Run as root.
#   webfront-restore /var/lib/webfront/backups/webfront-YYYYmmdd-HHMMSS.tar.gz
# Stops the service, moves current data aside (not deleted), restores, restarts.
set -euo pipefail

ENV_FILE=/etc/webfront/webfront.env
if [ -r "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
DATA_DIR="${DATA_DIR:-/var/lib/webfront}"
ARCHIVE="${1:-}"
YES=""
[ "${2:-}" = "--yes" ] && YES=1

die() { echo "restore: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "run as root"
[ -n "$ARCHIVE" ] || { echo "usage: $0 <backup.tar.gz> [--yes]"; echo "available:"; ls -1t "$DATA_DIR"/backups/webfront-*.tar.gz 2>/dev/null | head -10; exit 2; }
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

echo "This will REPLACE the current Webfront data in $DATA_DIR with:"
echo "  $ARCHIVE"
echo "Current data is moved to $DATA_DIR/pre-restore-<timestamp>, not deleted."
if [ -z "$YES" ]; then
  read -r -p "Type 'restore' to continue: " ans
  [ "$ans" = "restore" ] || die "aborted"
fi

echo "Stopping webfront"
systemctl stop webfront.service
ASIDE="$DATA_DIR/pre-restore-$(date +%Y%m%d-%H%M%S)"
mkdir "$ASIDE"
for f in webfront.db webfront.db-wal webfront.db-shm attachments; do
  [ -e "$DATA_DIR/$f" ] && mv "$DATA_DIR/$f" "$ASIDE/"
done
mv "$STAGE/webfront.db" "$DATA_DIR/webfront.db"
if [ -d "$STAGE/attachments" ]; then mv "$STAGE/attachments" "$DATA_DIR/attachments"; else mkdir "$DATA_DIR/attachments"; fi
chown -R webfront:webfront "$DATA_DIR/webfront.db" "$DATA_DIR/attachments" "$ASIDE"
chmod 0640 "$DATA_DIR/webfront.db"

echo "Starting webfront"
systemctl start webfront.service
PORT="${PORT:-8787}"
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/health" 2>/dev/null; then
    echo "Restored and healthy. Previous data kept in $ASIDE (delete it when you are satisfied)."
    exit 0
  fi
  sleep 1
done
die "service did not become healthy; previous data is in $ASIDE. Check: journalctl -u webfront -n 50"
