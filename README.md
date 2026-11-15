# Webfront

A single-user, local-first personal homepage that replaces your browser's new-tab page: bookmarks in compact category columns, post-its, a shopping list and to-dos, merged read-only calendar feeds, a Markdown wiki with `[[links]]` and backlinks, and homelab service status tiles. Every device keeps a full offline copy in IndexedDB and syncs to a small Node server when it can reach it. It is installable as a PWA on Windows, macOS and phones, and reached privately over Tailscale.

Stack: npm workspaces (`packages/shared`, `apps/server` with Hono and SQLite, `apps/web` with React and Vite). See `docs/PLAN.md` for the design.

## Local development

Requires Node 22 or newer.

```
npm install
npm run dev        # server on :8787 and Vite dev server on :5173
npm test
npm run build
```

In development, data is kept in `./data` and the origin is `http://localhost:5173`. The first visit shows the create-account screen.

## Deploying to Proxmox (LXC + Tailscale)

The server runs natively under systemd in an unprivileged Debian 13 container; data lives in `/var/lib/webfront`; Tailscale provides HTTPS.

### 1. Create the container

In Proxmox, create a CT from the Debian 13 template with:

- Unprivileged: yes. Features: nesting enabled (needed by some systemd sandboxing).
- 1 vCPU, 512 MB RAM (plus 256 MB swap), 4 GB disk. The first `npm ci` and build is the peak; 1 GB RAM makes it faster if you have it.
- Network: DHCP or a static address with outbound internet access. No port forwarding is needed.

### 2. Pass the tun device to the container

On the **Proxmox host**, append to `/etc/pve/lxc/<id>.conf`:

```
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
```

Then `pct reboot <id>`. Details and checks: [deploy/README-tailscale.md](deploy/README-tailscale.md).

### 3. Install Webfront

Inside the container as root, copy the project in (`git clone`, or `scp` a tarball) and run the installer:

```
apt-get update && apt-get install -y git
git clone <your repo> /root/webfront && cd /root/webfront
./deploy/install.sh --origin https://webfront.<tailnet>.ts.net
```

If you do not know your tailnet name yet, run it without `--origin`; the service stays stopped until you set `PUBLIC_ORIGIN` in `/etc/webfront/webfront.env`. With a tarball use `--tarball webfront.tar.gz`. The installer is safe to re-run.

It installs Node 22 (checksum-verified from nodejs.org), creates the locked-down `webfront` user, builds the app into `/opt/webfront/releases/<timestamp>` (symlinked as `current`), writes `/etc/webfront/webfront.env` (mode 600), and enables the service and the nightly backup timer.

Environment written to `/etc/webfront/webfront.env`: `NODE_ENV=production`, `HOST=127.0.0.1`, `PORT=8787`, `DATA_DIR=/var/lib/webfront`, `WEB_DIST_DIR`, `LOG_LEVEL=info`, `TRUST_PROXY=true`, `PUBLIC_ORIGIN`.

Optional: `PUSHOVER_APP_TOKEN` and `PUSHOVER_USER_KEY` (30 letters and digits each) for service outage alerts. Usually you enter these in Settings, Notifications instead, where they are stored in the server's database (and therefore in backups). Values in the env file take precedence, are never written to the database, and show as "set in the server's env file" in Settings; restart the service after changing them. See "Pushover notifications" in `docs/SECURITY.md` for what is sent to Pushover.

### 4. Tailscale

```
/opt/webfront/current/deploy/tailscale-setup.sh --hostname webfront
```

Approve the machine via the printed URL. In the Tailscale admin console (DNS page) enable **MagicDNS** and **HTTPS Certificates** first. `PUBLIC_ORIGIN` must equal the resulting `https://<hostname>.<tailnet>.ts.net`. The passkey ID is that hostname, so renaming the machine or tailnet later invalidates passkeys. Full notes: [deploy/README-tailscale.md](deploy/README-tailscale.md).

### 5. First run

Open `https://webfront.<tailnet>.ts.net` from any device on your tailnet. The first visit shows a one-time **create account** screen: choose a username and a strong password. Optionally add a passkey in settings afterwards.

### 6. Install the app on your devices

Install the Tailscale client and sign in to the same tailnet on each device first.

- **Windows (Chrome or Edge):** open the address, then the install icon in the address bar (or menu, Apps, Install this site as an app).
- **macOS:** Chrome or Edge as above; Safari 17+: File, Add to Dock.
- **Phone:** Android Chrome: menu, Install app. iPhone Safari: Share, Add to Home Screen. Keep the Tailscale app connected (or on "always on") for sync.

### 7. Use it as your home and new-tab page

- **Home page:** Chrome/Edge: Settings, Appearance (or On startup), set the home page to your Webfront address and show the Home button. Firefox: Settings, Home, Custom URLs.
- **New tab:** browsers cannot point the new-tab page at a URL natively. Chrome and Edge: use a small "new tab redirect" extension and set it to your address; Firefox: a "new tab override" add-on. Alternatively install the PWA and pin it, and use the in-app search bar.

### 8. Phone alerts for service outages (optional)

Webfront can notify your phone through [Pushover](https://pushover.net) when a service bookmark goes down and when it recovers. In Pushover, create an application (any name, e.g. "Webfront") to get an API token, and copy your user key from the Pushover dashboard. Enter both in Settings, Notifications, turn alerts on, save, and press **Send test**. A service counts as down after two failed checks in a row; alerts fire once per change, several services failing together produce one message, and nothing is sent for services that were already down when they were first checked. The container needs outbound HTTPS to `api.pushover.net`.

## Backup, restore, update

- **Nightly backup** (03:15, timer `webfront-backup.timer`): a consistent SQLite online backup plus attachments, as `webfront-<timestamp>.tar.gz` in `/var/lib/webfront/backups`, kept 14 days. Run one now with `webfront-backup`. Check the schedule with `systemctl list-timers webfront-backup.timer`.
- **Custom destination or retention:** set `BACKUP_DIR=/mnt/backups` and `BACKUP_RETENTION_DAYS=30` in `/etc/webfront/webfront.env`. If the destination is outside `/var/lib/webfront`, mount it into the container and run `systemctl edit webfront-backup.service` adding `[Service]` / `ReadWritePaths=/mnt/backups`. It must be writable by the `webfront` user. For real safety also copy backups off the container (a Proxmox bind mount or `proxmox-backup` of the CT).
- **Restore:** `webfront-restore /var/lib/webfront/backups/webfront-YYYYmmdd-HHMMSS.tar.gz`. It validates the archive, asks you to type `restore`, stops the service, moves current data to `/var/lib/webfront/pre-restore-<timestamp>`, restores, restarts and checks health.
- **Update:** `webfront-update` (pulls the checkout used at install, `git pull --ff-only`), or `webfront-update --tarball new.tar.gz`. It takes a backup, builds a new release alongside the old one, switches, restarts and checks `/api/health`. If the check fails it switches back to the previous release. Database migrations only move forward; if a failed update had already migrated the database, run `webfront-restore` with the backup it printed. The last two releases are kept.

## Troubleshooting

- **Logs:** `journalctl -u webfront -f`; backups: `journalctl -u webfront-backup`. Quick check: `curl http://127.0.0.1:8787/api/health`.
- **Service will not start, config error:** the server prints the invalid variable (usually `PUBLIC_ORIGIN` still `CHANGE-ME`, or not `https://`). Edit `/etc/webfront/webfront.env`, `systemctl restart webfront`.
- **`status=226/NAMESPACE`:** enable the container's Nesting feature in Proxmox, or remove the failing sandbox directive from `/etc/systemd/system/webfront.service` (then `systemctl daemon-reload`).
- **Service worker / install button missing:** these only work over HTTPS (or localhost). Use the `ts.net` address, not the container IP or plain `http://`. Confirm `tailscale serve status` shows the proxy.
- **Passkey errors:** `PUBLIC_ORIGIN` must match the hostname in the browser's address bar exactly.
- **`tailscaled` fails / "/dev/net/tun" missing:** the host-side `lxc.*` lines above are absent or the container was not rebooted.
- **Clock skew:** login sessions, passkeys, HTTPS certificates and calendar sync all need a correct clock. Containers share the host clock, so fix NTP on the Proxmox host (`timedatectl`, `chronyc tracking`). Also check phones are on automatic time.
- **`npm ci` fails building `better-sqlite3`:** the installer retries after adding `build-essential` and `python3`; check network access to npm and GitHub.
