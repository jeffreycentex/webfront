#!/usr/bin/env bash
# Webfront installer for a fresh Debian 13 (trixie) container. Run as root.
# Safe to re-run: it reuses existing users, config and data, and builds a new
# release each time.
#
#   ./deploy/install.sh [--origin https://webfront.<tailnet>.ts.net]
#                       [--tarball webfront.tar.gz] [--port 8787]
#
# Source of the app: the checkout this script lives in, or --tarball.
set -euo pipefail

APP_USER=webfront
APP_DIR=/opt/webfront
DATA_DIR=/var/lib/webfront
CONF_DIR=/etc/webfront
ENV_FILE="$CONF_DIR/webfront.env"
NODE_MAJOR=22
NODE_PREFIX=/usr/local/lib/nodejs
KEEP_RELEASES=2

ORIGIN="${WEBFRONT_ORIGIN:-}"
PORT="${WEBFRONT_PORT:-8787}"
TARBALL=""

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --origin)  ORIGIN="${2:?--origin needs a value}"; shift 2 ;;
    --port)    PORT="${2:?--port needs a value}"; shift 2 ;;
    --tarball) TARBALL="${2:?--tarball needs a path}"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run as root"
[ -r /etc/os-release ] && . /etc/os-release
if [ "${ID:-}" != "debian" ]; then warn "tested on Debian 13; found ${PRETTY_NAME:-unknown}"; fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
if [ -n "$TARBALL" ]; then
  [ -r "$TARBALL" ] || die "cannot read tarball: $TARBALL"
elif [ ! -f "$SRC_DIR/package.json" ] || [ ! -d "$SRC_DIR/apps/server" ]; then
  die "run this from a Webfront checkout, or pass --tarball"
fi

case "$PORT" in ''|*[!0-9]*) die "--port must be a number" ;; esac

# --- 1. OS packages ----------------------------------------------------------
log "Installing OS packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl xz-utils tar gzip sqlite3 git openssl >/dev/null

# --- 2. Node.js 22 from nodejs.org, checksum verified ------------------------
node_ok() {
  command -v node >/dev/null 2>&1 &&
    [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge "$NODE_MAJOR" ]
}

install_node() {
  local arch tmp base ver file
  case "$(dpkg --print-architecture)" in
    amd64) arch=x64 ;;
    arm64) arch=arm64 ;;
    *) die "unsupported architecture $(dpkg --print-architecture)" ;;
  esac
  tmp="$(mktemp -d)"
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  log "Resolving latest Node ${NODE_MAJOR}.x"
  curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"
  file="$(awk -v a="linux-$arch.tar.xz" '$2 ~ a"$" {print $2; exit}' "$tmp/SHASUMS256.txt")"
  [ -n "$file" ] || die "no Node tarball found for $arch"
  ver="${file#node-}"; ver="${ver%%-linux-*}"
  log "Downloading $file"
  curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/$file" "$base/$file"
  log "Verifying SHA-256"
  (cd "$tmp" && grep -F " $file" SHASUMS256.txt | sha256sum -c - >/dev/null) \
    || die "checksum mismatch for $file"
  mkdir -p "$NODE_PREFIX"
  rm -rf "${NODE_PREFIX:?}/node-$ver"
  mkdir "$NODE_PREFIX/node-$ver"
  tar -xJf "$tmp/$file" -C "$NODE_PREFIX/node-$ver" --strip-components=1
  ln -sfn "$NODE_PREFIX/node-$ver" "$NODE_PREFIX/current"
  for b in node npm npx corepack; do ln -sfn "$NODE_PREFIX/current/bin/$b" "/usr/local/bin/$b"; done
  rm -rf "$tmp"
}

if node_ok; then
  log "Node $(node -v) already installed"
else
  install_node
fi
# The unit and scripts expect node at /usr/local/bin/node.
[ -x /usr/local/bin/node ] || ln -sfn "$(command -v node)" /usr/local/bin/node
export PATH="/usr/local/bin:$PATH"
log "Using Node $(node -v), npm $(npm -v)"

# --- 3. User and directories -------------------------------------------------
if ! id "$APP_USER" >/dev/null 2>&1; then
  log "Creating system user $APP_USER"
  useradd --system --user-group --home-dir "$DATA_DIR" --no-create-home \
    --shell /usr/sbin/nologin "$APP_USER"
  passwd -l "$APP_USER" >/dev/null 2>&1 || true
fi
install -d -m 0750 -o "$APP_USER" -g "$APP_USER" "$DATA_DIR" "$DATA_DIR/attachments" "$DATA_DIR/backups"
install -d -m 0755 "$APP_DIR" "$APP_DIR/releases"
install -d -m 0750 -o root -g "$APP_USER" "$CONF_DIR"

# --- 4. Build a new release --------------------------------------------------
REL_ID="$(date +%Y%m%d-%H%M%S)"
REL="$APP_DIR/releases/$REL_ID"
log "Creating release $REL_ID"
mkdir "$REL"
cleanup_failed() { [ -n "${REL_OK:-}" ] || { warn "install failed; removing partial release $REL"; rm -rf "$REL"; }; }
trap cleanup_failed EXIT

if [ -n "$TARBALL" ]; then
  top="$(tar -tzf "$TARBALL" | sed -n '1s#/.*##p')"
  if tar -tzf "$TARBALL" | grep -x "$top/package.json" >/dev/null; then
    tar -xzf "$TARBALL" -C "$REL" --strip-components=1
  else
    tar -xzf "$TARBALL" -C "$REL"
  fi
else
  # node_modules is excluded at any depth; everything else only at the top level,
  # so source folders that happen to be called "data" or "dist" are kept.
  tar -C "$SRC_DIR" -cf - --no-anchored --exclude=node_modules \
    --anchored --exclude=./.git --exclude=./data --exclude=./test-results --exclude=./playwright-report \
    --exclude=./apps/web/dist --exclude=./apps/server/dist --exclude=./packages/shared/dist . \
    | tar -C "$REL" -xf -
fi
[ -f "$REL/package.json" ] || die "release is missing package.json"

build_release() {
  cd "$REL"
  log "npm ci (this can take a few minutes)"
  if ! npm ci --include=dev --no-audit --no-fund; then
    warn "npm ci failed; installing build tools for native modules and retrying"
    apt-get install -y -qq --no-install-recommends build-essential python3 >/dev/null
    rm -rf node_modules
    npm ci --include=dev --no-audit --no-fund
  fi
  log "npm run build"
  npm run build
  [ -f apps/server/dist/index.js ] || die "build did not produce apps/server/dist/index.js"
  [ -d apps/web/dist ] || warn "apps/web/dist not found; the web UI will not be served"
}
build_release
cd /
chown -R root:root "$REL"
chmod -R go-w "$REL"
chmod -R a+rX "$REL"

# --- 5. Configuration (never overwritten) -------------------------------------
if [ -f "$ENV_FILE" ]; then
  log "Keeping existing $ENV_FILE"
  if [ -n "$ORIGIN" ]; then
    warn "--origin ignored: edit PUBLIC_ORIGIN in $ENV_FILE to change it (this invalidates passkeys)"
  fi
else
  if [ -z "$ORIGIN" ] && [ -t 0 ]; then
    printf 'Public origin (https://<hostname>.<tailnet>.ts.net), or empty to set later: '
    read -r ORIGIN || ORIGIN=""
  fi
  ORIGIN="${ORIGIN%/}"
  if [ -n "$ORIGIN" ]; then
    case "$ORIGIN" in https://*) ;; *) die "origin must start with https://" ;; esac
  fi
  log "Writing $ENV_FILE"
  umask 077
  {
    echo "# Webfront configuration. Read by systemd (webfront.service); mode 600."
    echo "NODE_ENV=production"
    echo "HOST=127.0.0.1"
    echo "PORT=$PORT"
    echo "DATA_DIR=$DATA_DIR"
    echo "WEB_DIST_DIR=$APP_DIR/current/apps/web/dist"
    echo "LOG_LEVEL=info"
    echo "TRUST_PROXY=true"
    echo "# Must be the exact https://<host>.<tailnet>.ts.net users type. Passkeys are bound to its hostname."
    echo "PUBLIC_ORIGIN=${ORIGIN:-https://CHANGE-ME.tailnet-name.ts.net}"
    echo "# Optional backup settings (used by backup.sh):"
    echo "#BACKUP_DIR=$DATA_DIR/backups"
    echo "#BACKUP_RETENTION_DAYS=14"
  } > "$ENV_FILE"
fi
chown root:root "$ENV_FILE"
chmod 0600 "$ENV_FILE"
# systemd reads EnvironmentFile as root, so the service and the backup job work with mode 600.

# Remember where updates come from.
if [ -z "$TARBALL" ]; then printf '%s\n' "$SRC_DIR" > "$CONF_DIR/source"; fi

# --- 6. Activate release, units and helper commands --------------------------
PREV=""
[ -L "$APP_DIR/current" ] && PREV="$(readlink "$APP_DIR/current")"
ln -sfn "$REL" "$APP_DIR/current.new"
mv -T "$APP_DIR/current.new" "$APP_DIR/current"
[ -n "$PREV" ] && [ "$PREV" != "$REL" ] && ln -sfn "$PREV" "$APP_DIR/previous"
REL_OK=1

log "Installing systemd units"
for u in webfront.service webfront-backup.service webfront-backup.timer; do
  install -m 0644 "$REL/deploy/$u" "/etc/systemd/system/$u"
done
systemctl daemon-reload
for s in backup restore update; do
  ln -sfn "$APP_DIR/current/deploy/$s.sh" "/usr/local/sbin/webfront-$s"
done
chmod +x "$REL"/deploy/*.sh 2>/dev/null || true

# Prune old releases (keep current, previous and the newest few).
mapfile -t OLD < <(ls -1dt "$APP_DIR"/releases/*/ 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)))
for d in "${OLD[@]:-}"; do
  d="${d%/}"
  [ -n "$d" ] || continue
  [ "$d" = "$(readlink -f "$APP_DIR/current")" ] && continue
  [ "$d" = "$(readlink -f "$APP_DIR/previous" 2>/dev/null || true)" ] && continue
  rm -rf "$d"
done

systemctl enable webfront.service >/dev/null 2>&1
systemctl enable --now webfront-backup.timer >/dev/null 2>&1

if grep -q 'CHANGE-ME' "$ENV_FILE"; then
  warn "PUBLIC_ORIGIN is not set yet, so the service was NOT started."
  START_MSG="Edit PUBLIC_ORIGIN in $ENV_FILE, then: systemctl restart webfront"
else
  systemctl restart webfront.service
  log "Waiting for the health check"
  ok=""
  for _ in $(seq 1 30); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/health" 2>/dev/null; then ok=1; break; fi
    sleep 1
  done
  if [ -n "$ok" ]; then START_MSG="Service is running and healthy."
  else START_MSG="Service did not become healthy; see: journalctl -u webfront -n 50"; warn "$START_MSG"; fi
fi

cat <<MSG

Webfront $REL_ID installed.
  $START_MSG

Next steps:
  1. Tailscale + HTTPS:   $APP_DIR/current/deploy/tailscale-setup.sh
  2. Open your https://<host>.<tailnet>.ts.net address and create the account.
  3. Commands: webfront-update, webfront-backup, webfront-restore <archive>
  4. Logs: journalctl -u webfront -f

Config: $ENV_FILE   Data: $DATA_DIR   Backups: $DATA_DIR/backups (nightly)
MSG
