#!/usr/bin/env bash
# Consistent Webfront backup: SQLite online backup + attachments, one .tar.gz.
#
# Env (from /etc/webfront/webfront.env when readable, or the environment):
#   DATA_DIR               default /var/lib/webfront
#   BACKUP_DIR             default $DATA_DIR/backups
#   BACKUP_RETENTION_DAYS  default 14
# Runs as the webfront user from webfront-backup.timer; also fine as root.
set -euo pipefail

ENV_FILE=/etc/webfront/webfront.env
if [ -z "${DATA_DIR:-}" ] && [ -r "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
fi
DATA_DIR="${DATA_DIR:-/var/lib/webfront}"
BACKUP_DIR="${BACKUP_DIR:-$DATA_DIR/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
DB="$DATA_DIR/webfront.db"

die() { echo "backup: $*" >&2; exit 1; }
case "$RETENTION_DAYS" in ''|*[!0-9]*) die "BACKUP_RETENTION_DAYS must be a number" ;; esac
[ -f "$DB" ] || die "database not found: $DB"
command -v sqlite3 >/dev/null || die "sqlite3 is not installed"

umask 077
mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
STAGE="$(mktemp -d "$BACKUP_DIR/.stage.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
OUT="$BACKUP_DIR/webfront-$STAMP.tar.gz"

# .backup uses SQLite's online backup API, so it is safe while the server runs (WAL mode).
sqlite3 "$DB" ".timeout 30000" ".backup '$STAGE/webfront.db'"
[ "$(sqlite3 "$STAGE/webfront.db" 'PRAGMA integrity_check;')" = "ok" ] || die "integrity check failed on the backup copy"

if [ -d "$DATA_DIR/attachments" ]; then
  cp -a "$DATA_DIR/attachments" "$STAGE/attachments"
else
  mkdir "$STAGE/attachments"
fi

tar -C "$STAGE" -czf "$OUT.partial" webfront.db attachments
mv "$OUT.partial" "$OUT"

# Rotation (only our own files).
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'webfront-*.tar.gz' -mtime "+$RETENTION_DAYS" -delete
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'webfront-*.tar.gz.partial' -mtime +1 -delete

if [ "$(id -u)" -eq 0 ] && id webfront >/dev/null 2>&1 && [ "$BACKUP_DIR" = "$DATA_DIR/backups" ]; then
  chown webfront:webfront "$OUT"
fi
echo "backup: wrote $OUT ($(du -h "$OUT" | cut -f1))"
