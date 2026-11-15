#!/usr/bin/env bash
# Update Webfront in place with automatic rollback. Run as root.
#   webfront-update                    pull the source checkout recorded at install time
#   webfront-update --src /path/dir    use another checkout (git pull if it is a repo)
#   webfront-update --tarball f.tar.gz unpack a release tarball
#   webfront-update --no-pull          rebuild the checkout as it is
set -euo pipefail

APP_DIR=/opt/webfront
ENV_FILE=/etc/webfront/webfront.env
KEEP_RELEASES=2
SRC=""; TARBALL=""; PULL=1

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --src) SRC="${2:?}"; shift 2 ;;
    --tarball) TARBALL="${2:?}"; shift 2 ;;
    --no-pull) PULL=""; shift ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ "$(id -u)" -eq 0 ] || die "run as root"
export PATH="/usr/local/bin:$PATH"
[ -r "$ENV_FILE" ] || die "$ENV_FILE not found; run install.sh first"
set -a; . "$ENV_FILE"; set +a
PORT="${PORT:-8787}"

if [ -z "$TARBALL" ] && [ -z "$SRC" ]; then
  [ -r /etc/webfront/source ] && SRC="$(cat /etc/webfront/source)"
  [ -n "$SRC" ] || die "no source known; pass --src or --tarball"
fi
if [ -n "$TARBALL" ]; then
  [ -r "$TARBALL" ] || die "cannot read $TARBALL"
else
  [ -d "$SRC" ] || die "source directory missing: $SRC"
  if [ -n "$PULL" ] && [ -d "$SRC/.git" ]; then
    log "git pull in $SRC"
    git -c safe.directory="$SRC" -C "$SRC" pull --ff-only
  fi
fi

health() {
  for _ in $(seq 1 30); do
    curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/health" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

CUR="$(readlink -f "$APP_DIR/current")"
[ -d "$CUR" ] || die "no current release"

log "Backing up first"
BACKUP_OUT="$("$CUR/deploy/backup.sh")" || die "backup failed; not updating"
echo "$BACKUP_OUT"

REL_ID="$(date +%Y%m%d-%H%M%S)"
REL="$APP_DIR/releases/$REL_ID"
mkdir "$REL"
trap '[ -n "${DONE:-}" ] || rm -rf "$REL"' EXIT

log "Unpacking release $REL_ID"
if [ -n "$TARBALL" ]; then
  top="$(tar -tzf "$TARBALL" | sed -n '1s#/.*##p')"
  if tar -tzf "$TARBALL" | grep -x "$top/package.json" >/dev/null; then
    tar -xzf "$TARBALL" -C "$REL" --strip-components=1
  else
    tar -xzf "$TARBALL" -C "$REL"
  fi
else
  tar -C "$SRC" -cf - --no-anchored --exclude=node_modules \
    --anchored --exclude=./.git --exclude=./data --exclude=./test-results --exclude=./playwright-report \
    --exclude=./apps/web/dist --exclude=./apps/server/dist --exclude=./packages/shared/dist . \
    | tar -C "$REL" -xf -
fi
[ -f "$REL/package.json" ] || die "release is missing package.json"

(
  cd "$REL"
  # --include=dev: the env file sets NODE_ENV=production, which would otherwise make npm
  # skip the build tools (tsc, vite).
  log "npm ci"
  npm ci --include=dev --no-audit --no-fund
  log "npm run build"
  npm run build
  [ -f apps/server/dist/index.js ] || { echo "build output missing" >&2; exit 1; }
) || die "build failed; the running version is untouched"
chown -R root:root "$REL"; chmod -R go-w "$REL"; chmod -R a+rX "$REL"

log "Switching to $REL_ID"
ln -sfn "$CUR" "$APP_DIR/previous"
ln -sfn "$REL" "$APP_DIR/current.new"
mv -T "$APP_DIR/current.new" "$APP_DIR/current"
DONE=1
for u in webfront.service webfront-backup.service webfront-backup.timer; do
  install -m 0644 "$REL/deploy/$u" "/etc/systemd/system/$u"
done
systemctl daemon-reload
systemctl restart webfront.service

if health; then
  log "Healthy. Update complete."
  mapfile -t OLD < <(ls -1dt "$APP_DIR"/releases/*/ | tail -n +$((KEEP_RELEASES + 1)))
  for d in "${OLD[@]:-}"; do
    d="${d%/}"; [ -n "$d" ] || continue
    [ "$d" = "$REL" ] || [ "$d" = "$CUR" ] || rm -rf "$d"
  done
  exit 0
fi

warn "Health check failed; rolling back to $(basename "$CUR")"
ln -sfn "$CUR" "$APP_DIR/current.new"
mv -T "$APP_DIR/current.new" "$APP_DIR/current"
systemctl restart webfront.service
if health; then
  warn "Rolled back; the old version is running. The failed build is kept at $REL"
  warn "If the new version changed the database schema, restore the pre-update backup: webfront-restore <archive above>"
  warn "(webfront-restore marks the restore so devices reload it; never copy webfront.db back by hand without webfront-restore --new-epoch)"
  exit 1
fi
die "rollback also failed. Inspect: journalctl -u webfront -n 80. Backup: $BACKUP_OUT"
