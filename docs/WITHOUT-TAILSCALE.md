# Running Webfront without Tailscale

The main guide in the README publishes Webfront over a Tailscale network. Tailscale is not built
into the app: it only does two jobs, and anything else that does the same two jobs works.

1. **It provides HTTPS.** `tailscale serve` terminates TLS and forwards to the app on
   `127.0.0.1:8787`.
2. **It decides who can reach the app.** Only devices on your tailnet can connect.

Without Tailscale you replace job 1 with a reverse proxy that has a TLS certificate, and you decide
for yourself how to handle job 2. The app's own configuration barely changes.

> **Status:** the setups below follow from how the server is configured, but only the Tailscale
> path has been run on a real system. Treat the proxy examples (Caddy, nginx, Nginx Proxy Manager) as a starting point and check them
> with the steps under "Check that it works".

## Why HTTPS is not optional

Plain `http://192.168.x.x:8787` will not work as a deployment, and the installer refuses an origin
that does not start with `https://`. Three things depend on a secure origin:

- **Offline mode and installing as an app.** Browsers only allow the service worker on HTTPS (or on
  `localhost`).
- **Passkeys.** WebAuthn requires HTTPS, and a passkey is tied to the hostname.
- **The session cookie.** In production it is marked `Secure`, so the browser will not send it over
  plain HTTP and you could not stay signed in.

## What to skip and what to change

In the README's "Deploying to Proxmox" section:

| Step                                    | Without Tailscale                                                                            |
| --------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1. Create the container                 | Same.                                                                                        |
| 2. Pass the tun device to the container | **Skip.** Only Tailscale needs `/dev/net/tun`.                                               |
| 3. Install Webfront                     | Same, but pass your own address: `./deploy/install.sh --origin https://webfront.example.com` |
| 4. Tailscale                            | **Skip.** Set up a reverse proxy instead (below).                                            |
| 5 onwards                               | Same, using your own address.                                                                |

Settings in `/etc/webfront/webfront.env` (restart with `systemctl restart webfront` after editing):

| Setting         | Tailscale value                     | What to use instead                                                                                                                                                                                    |
| --------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PUBLIC_ORIGIN` | `https://webfront.<tailnet>.ts.net` | The exact address you type in the browser: scheme and hostname, plus the port if it is not 443, and no trailing slash. For example `https://webfront.example.com` or `https://webfront.home.lan:8443`. |
| `HOST`          | `127.0.0.1`                         | Keep `127.0.0.1` when the proxy runs in the same container (recommended). Use `0.0.0.0` only when the proxy is on another machine, and then firewall port 8787 so that only the proxy can reach it.    |
| `PORT`          | `8787`                              | Unchanged, unless it clashes with something.                                                                                                                                                           |
| `TRUST_PROXY`   | `true`                              | `true` when exactly one proxy sits in front of the app. See "Proxies and the login rate limit".                                                                                                        |

Nothing else is Tailscale-specific. `DATA_DIR`, backups, updates and Pushover alerts work the same.

**`PUBLIC_ORIGIN` must match exactly.** The server rejects sign-in and every change from any other
origin, so a mismatch shows up as "403" or "csrf_failed" errors right after the page loads. The
passkey identity is the hostname in `PUBLIC_ORIGIN`: if you change the hostname later, existing
passkeys stop working and must be registered again (passwords keep working).

## Choose a setup

### A. Home network only, with a real domain (recommended)

You own a domain name and want a normal trusted certificate without opening any port to the
internet. Let's Encrypt can issue a certificate using a DNS challenge, which proves you control the
domain through your DNS provider's API, so nothing at home has to be reachable from outside.

1. Point a name at the container's LAN address in your home DNS (router, Pi-hole, AdGuard Home), or
   publish an ordinary DNS record whose value is the private address, for example
   `webfront.example.com → 192.168.1.50`.
2. Install Caddy in the container, in a build that includes the plugin for your DNS provider
   (Caddy's download page lets you add one, or use `xcaddy`).
3. `/etc/caddy/Caddyfile`:

   ```
   webfront.example.com {
       tls {
           dns cloudflare {env.CLOUDFLARE_API_TOKEN}
       }
       reverse_proxy 127.0.0.1:8787
   }
   ```

   Replace `cloudflare` and the token variable with your provider's plugin and credentials.

4. `PUBLIC_ORIGIN=https://webfront.example.com`.

Every device trusts the certificate with no extra setup, including phones.

### B. Home network only, no domain (Caddy's internal certificate authority)

Caddy can act as its own certificate authority. The catch is that every device must be told to
trust it, which is easy on a computer and fiddly on phones.

1. Give the container a name in your home DNS, for example `webfront.home.lan`.
2. `/etc/caddy/Caddyfile`:

   ```
   webfront.home.lan {
       tls internal
       reverse_proxy 127.0.0.1:8787
   }
   ```

3. `PUBLIC_ORIGIN=https://webfront.home.lan`.
4. Install Caddy's root certificate on each device. It is at
   `/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt` in the container. On Windows
   add it to "Trusted Root Certification Authorities"; on macOS add it to Keychain and set it to
   "Always Trust"; on iOS install the profile and then enable it under Settings → General → About →
   Certificate Trust Settings; on Android install it as a CA certificate (some Android browsers
   ignore user-installed CAs).

Until a device trusts the certificate, the page loads with a warning and offline mode, app install
and passkeys do not work on that device.

### C. Reachable from the internet

This works, but it changes the risk. The app was designed and security-reviewed for a private
network (see `docs/SECURITY.md`); on the public internet anyone can reach the sign-in page.

1. Create a public DNS record for your name pointing at your public address, and forward ports 80
   and 443 to the container.
2. `/etc/caddy/Caddyfile` (Caddy gets and renews the certificate by itself):

   ```
   webfront.example.com {
       reverse_proxy 127.0.0.1:8787
   }
   ```

3. `PUBLIC_ORIGIN=https://webfront.example.com`.

Before exposing it:

- **Create your account first, on the local network.** The first-run "create account" page is open
  to whoever reaches it first.
- **Use a long, unique password and add a passkey.** There is no separate two-factor step; sign-in
  attempts are rate limited per address and overall.
- **Remember what is stored.** Bookmark usernames and hints, notes and the wiki are readable by
  anyone who signs in.
- **Service checks reach your internal network.** The server fetches the addresses of bookmarks
  flagged as services, favicons and calendar feeds. That only happens for a signed-in user, but it
  is one more reason to protect the account.
- **Consider putting access control in front** instead: your proxy's own authentication, an
  identity-aware proxy such as Cloudflare Access or Authelia, or a VPN. If you do, read the next
  section.

### D. Another VPN (WireGuard, ZeroTier, and so on)

Treat it as setup A or B: the VPN replaces Tailscale's access control, and you still need a reverse
proxy with a certificate for the HTTPS part. Use a hostname that resolves over the VPN.

## nginx with Let's Encrypt

This is the most common arrangement: nginx terminates HTTPS with a Let's Encrypt certificate and
forwards to the app. It fits setup A (certificate by DNS challenge, nothing exposed) and setup C
(certificate by HTTP challenge, ports 80 and 443 reachable from the internet). You need a domain
name either way; Let's Encrypt does not issue certificates for bare IP addresses or names such as
`webfront.home.lan`.

### nginx in the same container as Webfront

Leave `HOST=127.0.0.1` in `/etc/webfront/webfront.env`.

1. Install nginx and certbot:

   ```
   apt-get install -y nginx certbot python3-certbot-nginx
   ```

2. Create `/etc/nginx/sites-available/webfront`:

   ```nginx
   server {
       listen 80;
       server_name webfront.example.com;

       client_max_body_size 40m;            # sync pushes up to 32 MB, images up to 10 MB

       location / {
           proxy_pass http://127.0.0.1:8787;
           proxy_http_version 1.1;
           proxy_set_header Host $host;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
           proxy_buffering off;             # live sync uses a long-lived event stream
           proxy_read_timeout 1h;
       }
   }
   ```

3. Enable it and get the certificate. Certbot edits the file to add the HTTPS listener, the
   certificate paths and the redirect from HTTP, and installs a renewal timer:

   ```
   ln -s /etc/nginx/sites-available/webfront /etc/nginx/sites-enabled/
   nginx -t && systemctl reload nginx
   certbot --nginx -d webfront.example.com
   ```

   `certbot --nginx` uses the HTTP challenge, so port 80 must be reachable from the internet for
   that name. To keep everything private (setup A), use a DNS challenge instead, for example with
   Cloudflare: `apt-get install -y python3-certbot-dns-cloudflare`, then
   `certbot certonly --dns-cloudflare --dns-cloudflare-credentials /root/cloudflare.ini -d webfront.example.com`,
   and add `listen 443 ssl;` with the two `ssl_certificate` lines to the server block yourself.

4. Set `PUBLIC_ORIGIN=https://webfront.example.com` and run `systemctl restart webfront`.

### nginx on another machine (including Nginx Proxy Manager)

If nginx already runs elsewhere on your network, the app has to listen on the network instead of
only on localhost.

1. In `/etc/webfront/webfront.env` set `HOST=0.0.0.0`, and restart the service.
2. Restrict port 8787 to the proxy. With the Proxmox firewall, add a rule on the container that
   accepts TCP 8787 from the proxy's address and drop the rest; or inside the container:

   ```
   apt-get install -y nftables
   nft add table inet webfront
   nft add chain inet webfront input '{ type filter hook input priority 0; }'
   nft add rule inet webfront input tcp dport 8787 ip saddr != 192.168.1.10 drop
   ```

   (replace `192.168.1.10` with the proxy's address, and save the rules to `/etc/nftables.conf` so
   they survive a reboot). This matters: the connection between proxy and app is plain HTTP, and
   anything that can reach port 8787 directly can also send a forged `X-Forwarded-For` header and
   so dodge the sign-in rate limit.

3. Point the proxy at `http://<container address>:8787` using the nginx `location` block above.

In **Nginx Proxy Manager**, add a Proxy Host:

| Tab      | Setting                                                                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Details  | Domain Names: `webfront.example.com`. Scheme: `http`. Forward Hostname / IP: the container's address. Forward Port: `8787`. Leave "Cache Assets" off. "Block Common Exploits" can stay on. |
| SSL      | Request a new SSL Certificate (use the DNS Challenge option if the name is not reachable from the internet). Turn on "Force SSL" and "HTTP/2 Support".                                     |
| Advanced | Paste: `client_max_body_size 40m; proxy_buffering off; proxy_read_timeout 1h;`                                                                                                             |

Nginx Proxy Manager sets `Host` and `X-Forwarded-For` itself. `PUBLIC_ORIGIN` is still the public
`https://` address, not the container's.

### Notes for any proxy

Whatever you use must do four things: terminate TLS, forward to port 8787, append the client address
to `X-Forwarded-For`, and not buffer responses (the event stream at `/api/sync/events`). Caddy does
all four by default. Do not let the proxy cache anything under `/api/`, and do not strip the
response headers the app sets (`Content-Security-Policy`, `Cache-Control`).

## Proxies and the login rate limit

With `TRUST_PROXY=true` the server takes the visitor's address from the last entry of
`X-Forwarded-For`, which is correct when exactly one proxy is in front of it.

- **Two proxies in a row** (for example Cloudflare in front of Caddy): the app sees the outer
  proxy's address for every visitor, so all sign-in attempts share one rate-limit bucket. Sign-in
  still works; a burst of failed attempts from anyone slows it down for everyone. Have the inner
  proxy pass on the real client address as the last `X-Forwarded-For` entry if your proxy supports
  it.
- **No proxy at all** (not a supported deployment, since HTTPS is required): set
  `TRUST_PROXY=false` so the header cannot be forged.

## Check that it works

1. In the container: `curl -s http://127.0.0.1:8787/api/health` returns `{"status":"ok",...}`.
2. In a browser, open your `https://` address. The padlock shows a valid certificate with no
   warning.
3. Create the account or sign in. If sign-in fails with a 403, `PUBLIC_ORIGIN` does not match the
   address bar exactly.
4. The header shows "Synced". Add a post-it on one device and watch it appear on another within a
   couple of seconds; if it only appears after a reload, the proxy is buffering the event stream.
5. The browser offers to install the app (address bar icon on desktop, "Add to Home Screen" on
   phone). Turn off the network and reload: the app still opens. If not, the certificate is not
   trusted on that device.
6. Settings → Account → add a passkey, sign out, and sign in with it.

## Moving an existing install off Tailscale

1. Set up the proxy and DNS first.
2. Edit `PUBLIC_ORIGIN` in `/etc/webfront/webfront.env` to the new address and run
   `systemctl restart webfront`.
3. Open the new address on each device and sign in with your password. A browser treats the new
   address as a different site, so each device downloads its data again; let every device finish
   syncing on the old address before you switch, because changes that were never synced stay behind
   in the old address's storage.
4. Register passkeys again and reinstall the app on each device.
5. Remove the Tailscale proxy with `tailscale serve reset` if you no longer want the old address.
