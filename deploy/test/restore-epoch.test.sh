#!/usr/bin/env bash
# Tests for the restore-marker (sync epoch) part of deploy/restore.sh, against temporary SQLite
# files. Needs bash and the sqlite3 CLI; no root, no systemd.
#   bash deploy/test/restore-epoch.test.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
MIGRATIONS="$ROOT/apps/server/migrations"
# shellcheck source=../restore.sh
. "$ROOT/deploy/restore.sh"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/wf-epoch-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
FAILS=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1" >&2; FAILS=$((FAILS + 1)); }
check() { local name="$1"; shift; if "$@"; then pass "$name"; else fail "$name"; fi; }
is_epoch() { [[ "$1" =~ ^[0-9a-f]{32}$ ]]; }

# A database as the server creates it (core migration, optionally 020), with one record.
make_db() {
  local db="$1" with020="$2"
  sqlite3 -bail "$db" < "$MIGRATIONS/001_core.sql"
  [ "$with020" = yes ] && sqlite3 -bail "$db" < "$MIGRATIONS/020_sync_epoch.sql"
  sqlite3 -bail "$db" "INSERT INTO records (collection, id, data, clocks, deleted, created_at, updated_at, seq)
    VALUES ('bookmarks', 'b1', '{}', '{}', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1);
    UPDATE meta SET value = '1' WHERE key = 'records_seq';"
}
fingerprint() {
  sqlite3 "$1" "SELECT group_concat(key || '=' || value, ',') FROM (SELECT key, value FROM meta WHERE key <> 'sync_epoch' ORDER BY key);
                SELECT group_concat(collection || '/' || id || '/' || seq || '/' || deleted, ',') FROM records;"
}

# 1. A current database: the epoch is replaced, nothing else changes, repeated runs keep working.
DB="$TMP/current.db"
make_db "$DB" yes
E0="$(read_epoch "$DB")"
check "migration 020 creates an epoch" is_epoch "$E0"
FP="$(fingerprint "$DB")"
E1="$(write_epoch "$DB")"
check "write_epoch prints a valid epoch" is_epoch "$E1"
check "write_epoch changes the epoch" [ "$E1" != "$E0" ]
check "the stored epoch is the printed one" [ "$(read_epoch "$DB")" = "$E1" ]
check "server_id, records_seq and records are untouched" [ "$(fingerprint "$DB")" = "$FP" ]
E2="$(write_epoch "$DB")"
check "running it again writes another fresh epoch (idempotent)" [ "$E2" != "$E1" ]
check "exactly one epoch row" [ "$(sqlite3 "$DB" "SELECT COUNT(*) FROM meta WHERE key = 'sync_epoch'")" = 1 ]

# 2. A backup taken before migration 020 existed: the marker is inserted, and the migration
#    that runs at the next start keeps it.
OLD="$TMP/pre020.db"
make_db "$OLD" no
check "a pre-020 backup has no epoch" [ -z "$(read_epoch "$OLD")" ]
E3="$(write_epoch "$OLD")"
check "write_epoch inserts one into a pre-020 backup" is_epoch "$E3"
sqlite3 -bail "$OLD" < "$MIGRATIONS/020_sync_epoch.sql"
check "migration 020 afterwards keeps restore.sh's value" [ "$(read_epoch "$OLD")" = "$E3" ]

# 3. A WAL-mode database (the server's): no WAL content is left behind, so moving and chowning
#    webfront.db alone is safe.
WAL="$TMP/wal.db"
make_db "$WAL" yes
sqlite3 "$WAL" "PRAGMA journal_mode = WAL;" >/dev/null
E4="$(write_epoch "$WAL")"
check "write_epoch works on a WAL database" is_epoch "$E4"
check "no WAL content left behind" [ ! -s "$WAL-wal" ]
cp "$WAL" "$TMP/copied.db"
check "a copy of the main file alone carries the new epoch" [ "$(read_epoch "$TMP/copied.db")" = "$E4" ]

# 4. Failures are loud (non-zero), never a silent restore without a marker.
check "fails for a missing file" bash -c ". '$ROOT/deploy/restore.sh'; ! write_epoch '$TMP/missing.db' 2>/dev/null"
sqlite3 "$TMP/nometa.db" "CREATE TABLE x (a);"
check "fails for a database without the meta table" bash -c ". '$ROOT/deploy/restore.sh'; ! write_epoch '$TMP/nometa.db' 2>/dev/null"
chmod 0444 "$DB"
check "fails for a read-only database" bash -c ". '$ROOT/deploy/restore.sh'; ! write_epoch '$DB' 2>/dev/null"
chmod 0644 "$DB"

# 5. The client test harness uses the same SQL (e2e/servers.mjs calls write_epoch itself).
HARNESS_SQL="$(sed -n "s/^export const RESTORE_EPOCH_SQL = \`\(.*\)\`;$/\1/p" "$ROOT/apps/web/src/data/test/harness.ts")"
check "harness RESTORE_EPOCH_SQL matches restore.sh" [ "$HARNESS_SQL" = "$EPOCH_SQL" ]

# 6. Usage paths of the script itself (no root needed to reach them).
if [ "$(id -u)" -ne 0 ]; then
  check "refuses to run without root" bash -c "! bash '$ROOT/deploy/restore.sh' x.tar.gz 2>/dev/null"
fi

if [ "$FAILS" -gt 0 ]; then echo "$FAILS failure(s)" >&2; exit 1; fi
echo "all restore-epoch tests passed"
