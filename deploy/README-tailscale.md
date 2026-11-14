# Tailscale setup for Webfront

Webfront listens on `127.0.0.1:8787` only. `tailscale serve` terminates HTTPS on
the tailnet and proxies to it, so nothing is exposed to your LAN or the internet.

## 1. Proxmox host: pass /dev/net/tun into the container

Unprivileged LXC containers have no tun device by default. On the **Proxmox host**
(not in the container), with the container stopped or about to be restarted,
append to `/etc/pve/lxc/<id>.conf`:

```
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
```

Then `pct reboot <id>`. Check inside the container: `ls -l /dev/net/tun` should
show `crw-rw-rw- ... 10, 200`. If the host node is missing, run `modprobe tun` on
the host (and add `tun` to `/etc/modules`). Tailscale runs as root inside the
container, so no ownership mapping is needed because the host device is mode 0666.

## 2. Install and log in

Inside the container, as root:

```
/opt/webfront/current/deploy/tailscale-setup.sh --hostname webfront
```

It installs Tailscale from the official apt repository, enables `tailscaled`,
runs `tailscale up` (open the printed URL to approve the machine) and then
`tailscale serve --bg --https=443 http://127.0.0.1:8787`. The serve
configuration is stored by `tailscaled` and comes back after every reboot.

## 3. Admin console (once per tailnet)

At https://login.tailscale.com/admin/dns:

1. Enable **MagicDNS**.
2. Under **HTTPS Certificates**, click **Enable HTTPS**.

Without HTTPS enabled, `tailscale serve` fails with a certificate error.
Optionally disable key expiry for the machine (Machines > ... > Disable key
expiry) so the server does not drop off the tailnet after 180 days.

## 4. PUBLIC_ORIGIN and passkeys

Your address is `https://<hostname>.<tailnet>.ts.net` (shown by the script and by
`tailscale serve status`). Put exactly that in `/etc/webfront/webfront.env`:

```
PUBLIC_ORIGIN=https://webfront.tail1234.ts.net
```

then `systemctl restart webfront`. The passkey relying-party ID is the hostname of
this origin. **If you later rename the machine or the tailnet, the hostname
changes and every registered passkey stops working** (password sign-in still
works; re-register passkeys afterwards). The service worker and offline copies are
also bound to the origin, so each device starts a fresh local copy. Choose the
name once.

## Useful commands

```
tailscale status
tailscale serve status
tailscale serve reset        # remove the proxy
```
