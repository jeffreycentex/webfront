#!/usr/bin/env bash
# Install Tailscale in the Webfront container and publish the app over HTTPS.
# Run as root inside the container, after install.sh.
#
#   ./tailscale-setup.sh [--hostname webfront] [--port 8787]
#
# Prerequisite (on the Proxmox host, then reboot the container): pass /dev/net/tun
# through. See deploy/README-tailscale.md. Authentication is interactive: this
# script prints a login URL. Do not put auth keys on the command line.
set -euo pipefail

TS_HOSTNAME="${WEBFRONT_TS_HOSTNAME:-webfront}"
PORT=8787
ENV_FILE=/etc/webfront/webfront.env
[ -r "$ENV_FILE" ] && PORT="$(sed -n 's/^PORT=//p' "$ENV_FILE" | tail -1 || true)"
PORT="${PORT:-8787}"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --hostname) TS_HOSTNAME="${2:?}"; shift 2 ;;
    --port) PORT="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ "$(id -u)" -eq 0 ] || die "run as root"

if [ ! -c /dev/net/tun ]; then
  die "/dev/net/tun is missing. On the Proxmox host add to /etc/pve/lxc/<id>.conf:
  lxc.cgroup2.devices.allow: c 10:200 rwm
  lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
then restart the container (pct reboot <id>). See deploy/README-tailscale.md."
fi

if ! command -v tailscale >/dev/null 2>&1; then
  log "Adding the Tailscale apt repository (Debian trixie)"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends curl ca-certificates gnupg >/dev/null
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL --proto '=https' --tlsv1.2 https://pkgs.tailscale.com/stable/debian/trixie.noarmor.gpg \
    -o /usr/share/keyrings/tailscale-archive-keyring.gpg
  curl -fsSL --proto '=https' --tlsv1.2 https://pkgs.tailscale.com/stable/debian/trixie.tailscale-keyring.list \
    -o /etc/apt/sources.list.d/tailscale.list
  apt-get update -qq
  apt-get install -y -qq tailscale >/dev/null
fi

log "Starting tailscaled"
systemctl enable --now tailscaled
for _ in $(seq 1 15); do tailscale status >/dev/null 2>&1 && break; [ -S /run/tailscale/tailscaled.sock ] && break; sleep 1; done

if tailscale status --json 2>/dev/null | grep -q '"BackendState": *"Running"'; then
  log "Already logged in to a tailnet"
else
  log "Logging in. Open the URL below in a browser and approve this machine."
  tailscale up --hostname="$TS_HOSTNAME" --accept-dns=false
fi

DNS_NAME="$(tailscale status --json | sed -n 's/.*"DNSName": *"\([^"]*\)".*/\1/p' | head -1)"
DNS_NAME="${DNS_NAME%.}"

log "Publishing http://127.0.0.1:$PORT over HTTPS (persists across reboots)"
if ! tailscale serve --bg --https=443 "http://127.0.0.1:$PORT"; then
  die "tailscale serve failed. In the admin console enable MagicDNS and HTTPS Certificates (DNS page), then re-run."
fi
tailscale serve status || true

cat <<MSG

Done. Your app should be at:  https://${DNS_NAME:-<hostname>.<tailnet>.ts.net}

IMPORTANT: PUBLIC_ORIGIN in $ENV_FILE must be exactly that origin
(https://${DNS_NAME:-<hostname>.<tailnet>.ts.net}, no trailing slash, no port).
Passkeys are bound to this hostname. If it differs, edit it and run:
  systemctl restart webfront
MSG
