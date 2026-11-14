# Webfront security review (Task 12)

Review date: 2026-11-14. I reviewed the code itself (server, web app, shared schemas, deployment
scripts), not the earlier task reports. This file covers the threat model, what I reviewed, every
finding with its severity, what I fixed (with file references), and the risks that remain
accepted.

## Threat model

- **One owner, one account.** No other users, no sharing.
- **Network.** The Node server listens on `127.0.0.1` inside a Proxmox LXC. `tailscale serve`
  terminates HTTPS on `https://<host>.<tailnet>.ts.net` and proxies to it. Every device on the
  owner's tailnet can reach it; the public internet cannot (no Funnel). The ts.net hostname is
  not secret: its TLS certificate is in public Certificate Transparency logs.
- **Attackers considered.**
  1. Any web page the owner visits in a browser that holds a Webfront session (CSRF, cross-site
     navigation, clickjacking, the bookmarklet's query string).
  2. Another device or service on the tailnet, including a compromised homelab web UI. Every
     `*.<tailnet>.ts.net` host is _same-site_ with Webfront, because `ts.net` is a public
     suffix and the registrable domain is `<tailnet>.ts.net`.
  3. Hostile content the app processes: remote pages, favicons, ICS feeds, an imported JSON
     file, and Markdown in notes and wiki pages.
  4. A compromised `webfront` service account, which the root-run maintenance scripts must not
     trust.
- **Out of scope (accepted, documented in PLAN.md).** An attacker with the unlocked device.
  The browser keeps a full unencrypted local copy, and the idle lock is a convenience only.
  Credential _hints_ are stored unencrypted; real passwords are never stored.
- **Deliberate behaviour that is not a vulnerability.** The server makes outbound requests to
  owner-supplied URLs, private addresses included (favicons, page titles, dead-link checks,
  service checks, ICS feeds). The controls are that only the signed-in owner can trigger them,
  that other sites cannot drive them, and that what comes back is bounded.

## What was reviewed

| Area                     | Files                                                                                    | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Auth                     | `apps/server/src/features/auth/**`                                                       | Setup-once is race-free (single-row `CHECK (id = 1)` plus `ON CONFLICT DO NOTHING`). Session token is 32 random bytes; only SHA-256 is stored. Cookie is `HttpOnly`, `Secure` on https, `SameSite=Lax`, `Path=/api`, 90-day sliding. CSRF token is HMAC(token), compared in constant time. Origin is checked on every mutation (exempt routes: setup, login and passkey login, which are still Origin-checked). Requests with no Origin are accepted only without `Sec-Fetch-Site` or with same-origin/none. Rate limiting: per IP 5 free attempts then exponential up to 15 min, global 30; pessimistic `begin()`. Client IP is the right-most `X-Forwarded-For` entry, correct behind exactly one proxy that appends (tailscale serve). Passkeys: challenges are hashed, single-use, expire after 5 min, registration is bound to the session, login challenges are capped at 100, origin/RP ID are checked, UV is required, the counter is handled by SimpleWebAuthn, the user handle is checked. Password change requires the current password and is rate-limited. Revocation emits `session.revoked`, and the SSE handler closes that session's streams. **One finding (F3).** |
| Every route              | all `register()` functions                                                               | All routes use `ctx.requireAuth` except `/api/health` and the public auth endpoints (`status`, `setup`, `login`, `logout`, `passkeys/login/*`). Inputs are zod-validated. Errors never include stack traces or internal messages (500s are generic). All SQL is parameterised (no string-built SQL anywhere). Attachment ids are `^[0-9a-f]{64}$`, so no path traversal. Static serving cannot escape `dist` (regression test added). **Body limits were missing on two routes (F5).**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Attachments and favicons | `features/attachments/**`, `features/favicons/**`                                        | Types come from magic bytes, never from Content-Type. SVG is refused for attachments; SVG favicons are rejected if they contain script, event handlers or `javascript:`. Both are served with `nosniff`, a sandboxing CSP and `CORP: same-origin`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Outbound fetchers        | `favicons/httpClient.ts`, `services/checker.ts`, `calendar/fetchFeed.ts`                 | http(s) only, re-checked on every redirect (so a redirect to `file:`, `gopher:` or similar is refused), at most 5 redirects, hard timeouts, byte caps (256 KB pages, 128 KB icons, 10 MB ICS). URL credentials are stripped. `Accept-Encoding: identity` for the custom client. undici `fetch` for ICS decompresses, but the cap is counted on decompressed bytes while streaming, so a decompression bomb stops at 10 MB. Error text never contains the URL, and ICS URLs are never logged (access logs record the path without the query). What is reflected to the owner: page title (200 chars), sniffed icon bytes, status codes, final redirect URL. **Other sites could drive the fetchers (F3).** No CORS headers anywhere.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Sync                     | `features/sync/**`, `packages/shared/src/registry.ts`                                    | Auth on every route. Every pushed field is validated against the collection schema, unknown fields are rejected, writes to server-owned collections are rejected (`read_only`), clock drift is capped, and the merged record is re-validated. 500 changes per push. **No byte limit on the push body (F5).** SSE: one listener per stream, closed on revoke, heartbeat 25 s; there is no cap on streams per session (accepted, A7).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Web: HTML from content   | `wiki/markdown.ts`, `bookmarks/renderMarkdown.ts`, `calendar/text.ts`, `postits/text.ts` | markdown-it runs with `html: false` and DOMPurify runs after it; `javascript:`/`vbscript:`/`data:` links are dropped by both. Wiki links resolve to app routes only. Calendar descriptions and locations are reduced to plain text and rendered as React text, with only http(s) auto-linked. Post-it auto-links are http(s)/`www.` only. External links get `rel="noopener noreferrer"`. **Hook leak between the two DOMPurify users (F7).**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Web: URLs from data      | bookmarks, dashboard search, command palette                                             | **Stored bookmark URLs were opened without a scheme check (F1).** Search-engine templates are validated to http(s) in the shared setting schema.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `/capture` bookmarklet   | `bookmarks/CapturePage.tsx`, `model.ts`                                                  | Query parameters are attacker-controlled. Title is rendered as text. URL goes through `normaliseUrl` (http(s) only). A hostile page can open `/capture` itself, but nothing is written without the owner pressing Save. The window cannot be framed. **The editable address field was not re-validated on save (part of F1).**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Service worker           | `apps/web/vite.config.ts`                                                                | The precache holds only the app shell. Runtime caches exist only for `/api/favicons` and `/api/attachments/`. `navigateFallback` excludes `/api/`. **The two runtime caches outlived sign-out (F4).**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| JSON import              | `settings/dataTransfer.ts`                                                               | Each record is validated with the shared schemas; only writable collections are imported; nothing is deleted. **A hostile file could plant `javascript:` bookmarks (F1).**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Headers                  | `app.ts`, `http/static.ts`                                                               | `secureHeaders` gave nosniff, `Referrer-Policy: no-referrer` (so external sites do not learn the ts.net host or paths), COOP/CORP same-origin, HSTS and `X-Frame-Options: SAMEORIGIN`. **There was no CSP and no Permissions-Policy, and an inline script blocked a strict CSP (F2).**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Deployment               | `deploy/**`, `README.md`                                                                 | Service binds `127.0.0.1`. systemd sandboxing is strong (`ProtectSystem=strict`, `NoNewPrivileges`, empty capability set, `UMask=0077`). Env file is root:root 0600. Data dir is 0750. Backups are written with umask 077. Node download is checksum-verified. `tailscale serve` (not Funnel). **`restore.sh` validation could be bypassed (F6).** Judgement calls are in A11.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Dependencies             | `npm audit --omit=dev`                                                                   | **0 vulnerabilities** in production dependencies. With dev dependencies included: 6 (2 low, 4 moderate), all in the build toolchain (`vite-plugin-pwa` → `workbox-build` → `glob`/`minimatch`/`@rollup/plugin-node-resolve` → `deepmerge`). They run only at build time on trusted input. The only fix offered is a breaking downgrade of `vite-plugin-pwa`, so I did not upgrade.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## Findings and fixes

Severities are for this deployment and threat model.

### F1. Medium: a stored non-http(s) bookmark URL could run script in the app's origin

`z.url()` accepts any scheme (`javascript:`, `data:`, `vbscript:`, `file:`). The bookmark form
normalised URLs, but other paths store them unchecked: JSON import, the capture window's editable
address field, and any client pushing to `/api/sync/push`. Such a URL was then opened unchecked:

- dashboard search Enter → `window.location.assign(url)` (same tab, runs in the Webfront origin);
- command palette and the Bookmarks page "Enter opens the top match" → `window.open(url)`;
- bookmark anchors (React 19 blocks `javascript:` in `href` but not `data:`).

A `javascript:` URL running in the app origin can read every local record, call the API with
the CSRF token and exfiltrate the data. The realistic trigger is importing a crafted export
file and then opening the bookmark.

Fixed:

- `packages/shared/src/urls.ts`: new `safeHttpUrl()`, exported from the package index.
- Anchors render without `href` unless the URL is http(s): `bookmarks/BookmarkRow.tsx`,
  `BookmarkDetails.tsx`, `ServicesWidget.tsx`.
- Openers refuse non-http(s): `bookmarks/BookmarksPage.tsx` (`openUrl`),
  `dashboard/SearchBar.tsx` (`openExternal`), `app/CommandPalette.tsx`, and the
  bookmarks search provider (`bookmarks/search.ts`) no longer hands out unsafe hrefs.
- Import treats the file as hostile: a bookmark (or its HTTP service check) with a non-http(s)
  URL is skipped as invalid (`settings/dataTransfer.ts`).
- The capture window re-validates the edited address on save (`bookmarks/CapturePage.tsx`).
- Defence in depth: the new CSP has no `'unsafe-inline'` for scripts, so navigating to a
  `javascript:` URL is blocked even if a path is missed (F2).
- Tests: `packages/shared/src/urls.test.ts`, `bookmarks/BookmarkColumns.test.tsx`,
  `BookmarkDetails.test.tsx`, `CapturePage.test.tsx` (new), `dashboard/dashboard.test.tsx`,
  `app/app.test.tsx`, `settings/dataTransfer.test.ts`.

Not changed: the shared schema still accepts any scheme. Tightening `urlField` would make
existing records fail validation on the server (`parseRow` drops them) and in clients. The
render-time guard is the control.

### F2. Medium: no Content-Security-Policy, and an inline script prevented one

Fixed:

- `apps/server/src/http/static.ts`: every non-API response carries `APP_CSP`:
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`.
  `'unsafe-inline'` for styles is needed for React `style` props (palette colours), CodeMirror's
  injected styles and the small `<style>` in `index.html`. Markdown output has `style`
  attributes stripped. `img-src` allows remote images because wiki pages may embed them.
- The theme no-flash snippet moved from an inline `<script>` in `apps/web/index.html` to
  `apps/web/public/theme-init.js` (still a blocking classic script, still precached).
  Comments were updated in `src/lib/theme.ts` and `src/app/App.tsx`. The built `index.html` has
  no inline script, and the bundle contains no `eval`/`new Function`. The bookmarklet runs on
  other sites, and the settings link that holds it cancels its own click, so the CSP does not
  affect it.
- `apps/server/src/app.ts`: API responses without their own CSP get
  `default-src 'none'; frame-ancestors 'none'`. Attachments and favicons keep their sandboxing
  CSP. `X-Frame-Options: DENY`, and a `Permissions-Policy` turns off camera, microphone,
  geolocation, payment, USB, serial, Bluetooth, HID, MIDI, display capture and topics. Clipboard
  and WebAuthn keep their default `self`.
- Tests: `http/static.test.ts` (CSP on shell and assets, none on /api, plus a path-traversal
  test), `auth/auth.test.ts` (API headers), `apps/web/src/lib/indexHtml.test.ts` (no inline
  script or handlers in `index.html`), and e2e: each Playwright test fails on any CSP violation
  in the console.

### F3. Medium: other sites could make the server fetch internal URLs (blind SSRF via CSRF)

The session cookie is `SameSite=Lax`, which still sends it on top-level cross-site GET
navigations. On a tailnet, every other `*.<tailnet>.ts.net` host is same-site, so it is also
sent on that host's subresource requests (`<img>`). `GET /api/favicons?url=` and
`GET /api/favicons/title?url=` make the server fetch the given URL. Any web page the owner
visits could therefore make the Webfront server send GET requests to arbitrary LAN addresses
(router admin pages, IoT devices) with the owner's session. The hostname is discoverable from
CT logs. Responses could not be read cross-origin, so the attack is blind, but GET side effects
on LAN devices are real.

Fixed: `apps/server/src/features/auth/request.ts` (`fetchSiteAllowed`) and the global /api
middleware in `features/auth/index.ts` refuse any `/api` request (all methods) that the browser
marks `Sec-Fetch-Site: cross-site` or `same-site`, with 403 `csrf_failed`. Same-origin requests
and user-initiated ones (`none`) still work. Clients that send no fetch metadata (curl, very old
browsers) are allowed, and the Origin and CSRF checks still cover their mutations. Test:
`auth/auth.test.ts` ("rejects cross-site and same-site GETs too"), plus the e2e test
`auth.spec.ts`.

### F4. Low/Medium: private cached API responses survived sign-out

The service worker's `wf-attachments` cache (wiki images) and `wf-favicons` cache (icons of
private hosts), plus the HTTP cache (`private, max-age=…`), were not cleared by sign-out, even
though sign-out clears IndexedDB.

Fixed: `apps/web/src/data/runtime.ts` (`clearDeviceState`, `PRIVATE_CACHES`) deletes both caches
on sign-out. `POST /api/auth/logout` sends `Clear-Site-Data: "cache"` so the browser drops this
origin's HTTP cache. The precached app shell stays, so the sign-in screen still loads offline.
Tests: `data/integration.test.ts`, `auth/auth.test.ts`.

### F5. Low: no body size limit on `POST /api/sync/push` and `POST /api/services/check-links`

Only the owner could exploit this (auth and CSRF apply before the body is read), but one large
body could exhaust the 400 MB memory limit. Fixed: 32 MB for push (`MAX_PUSH_BODY_BYTES`; the
client batches at about 4 MB, and the largest legitimate single change is about 24 MB as JSON)
and 256 KB for check-links, both answering 413 (`features/sync/index.ts`,
`features/services/index.ts`). Tests: `sync/sync.test.ts`, `services/services.test.ts`.

### F6. Medium (deployment): `restore.sh` archive validation could be bypassed

`restore.sh` ran under `set -o pipefail` and checked the archive listing with
`printf … | grep -q …`. When the listing is longer than a pipe buffer, `grep -q` exits at its
first match and the writer dies of SIGPIPE. The pipeline then fails, so the `if` sees "no match",
and the unsafe-path and unexpected-entry checks pass. I reproduced this with 50,000 entries. The
script also accepted symlink and hard-link entries (e.g. `attachments -> /etc`). The backups
directory is writable by the `webfront` user, so a compromised service could leave a crafted
archive for root to restore.

Fixed in `deploy/restore.sh`: the checks use `grep … >/dev/null` (reads all input), and a new
check refuses any entry that is not a regular file or directory (`tar -tv` type column). The same
`grep -q` false negative in `install.sh` and `update.sh` (`--tarball` handling: a
false-negative made a valid tarball fail as "missing package.json") is fixed the same way. All
three scripts pass `bash -n`; the new checks were exercised against good and malicious archives
by hand.

### F7. Low: the two Markdown renderers shared DOMPurify hooks

Bookmark notes and the wiki both added hooks to the _default_ DOMPurify instance, so whichever
loaded second also ran the other's hooks. For example, after viewing bookmark notes, internal
wiki links got `target="_blank"`. I found no security impact, but sanitiser behaviour depended on
load order. Fixed: `bookmarks/renderMarkdown.ts` uses its own instance (`DOMPurify(window)`).
Test: `bookmarks/renderMarkdown.test.ts`.

## Accepted risks and judgement calls

- **A1. First-run window.** Until the account exists, anyone on the tailnet can create it.
  Setup is race-free, but first come, first served. Create the account right after
  `tailscale-setup.sh`; restricting the container with a Tailscale ACL closes this (and A2).
- **A2. Whole-tailnet reach.** Every tailnet device (and every node shared into it) can try to
  sign in. Mitigations: Argon2id, rate limiting, passkeys. Recommended: a Tailscale ACL that
  allows `tag:webfront:443` only from the owner's devices.
- **A3. Local data and the offline lock.** The local copy is unencrypted, and the lock screen
  keeps a PBKDF2 (150k iterations) verifier of the password in `localStorage`, which can be
  attacked offline from a copied browser profile. Documented as a convenience lock. Device
  security rests on OS login and disk encryption.
- **A4. Outbound requests to private addresses** are by design (see the threat model). Owner
  only, bounded, and no longer drivable cross-site (F3).
- **A5. Schemas accept any URL scheme** (see F1); guarded at render and open time.
- **A6. Session-only re-authentication.** A stolen session cookie can register a passkey
  (no password prompt), and passkeys survive a password change. Password change revokes other
  sessions only when the box is ticked. Low (requires the cookie, which is HttpOnly and
  CSRF-protected). Possible hardening: require the current password for passkey registration
  and offer "revoke passkeys" on password change.
- **A7. SSE streams are not capped per session.** Only the owner can open them.
- **A8. `TRUST_PROXY=true` (default)** trusts the right-most `X-Forwarded-For`. This is
  correct behind `tailscale serve` on localhost. If someone binds `HOST=0.0.0.0` without a
  proxy, clients could spoof their per-IP rate-limit key (the global limit still holds); set
  `TRUST_PROXY=false` in that case. The e2e servers run with `TRUST_PROXY=false`.
- **A9. Remote images in wiki pages** load directly from the remote host (no referrer is sent).
  This reveals the viewer's IP to that host, which is the owner's own choice of content.
- **A10. The app shell, bundles and source maps are public** (unauthenticated static files).
  They contain no secrets.
- **A11. Deployment.**
  - `install.sh`/`update.sh` run `npm ci` (dependency lifecycle scripts) as root, and
    `update.sh` runs `git pull` as root with `-c safe.directory=` on the checkout recorded at
    install. If that checkout is owned by a less trusted user, that user could get code run as
    root (git config/hooks, package scripts). Recommendation (not changed, because the
    install/update flow cannot be tested here): build as an unprivileged user and keep the
    source checkout root-owned.
  - `restore.sh` opens an untrusted SQLite file as root for `PRAGMA integrity_check`
    (SQLite's attack surface on hostile files). Low; only archives the owner names are
    restored.
  - The export file contains ICS secret URLs and credential hints in clear text; the UI says
    so.
- **A12. The capture window can be opened by any page** with its own URL and title pre-filled;
  saving needs the owner's Save (or Enter in the focused title field). It cannot be framed, so
  no clickjacking.
- **A13. `Clear-Site-Data: "cache"`** may take a moment in some Chrome versions. It only affects
  this origin's cache, on sign-out.

## Tests added for this review

Server: `http/static.test.ts` (+2), `auth/auth.test.ts` (+1 test, extra header and
Clear-Site-Data assertions), `sync/sync.test.ts` (+1), `services/services.test.ts` (+1).
Shared: `urls.test.ts` (new, 2). Web: `bookmarks/BookmarkColumns.test.tsx` (+1),
`bookmarks/BookmarkDetails.test.tsx` (+1), `bookmarks/CapturePage.test.tsx` (new, 2),
`bookmarks/renderMarkdown.test.ts` (+1), `dashboard/dashboard.test.tsx` (+1), `app/app.test.tsx`
(+1), `settings/dataTransfer.test.ts` (+1), `data/integration.test.ts` (+1),
`lib/indexHtml.test.ts` (new, 2). End-to-end (`e2e/`, see that folder): security-relevant
checks for headers, cross-site rejection, 401 when signed out, CSP-clean pages, Markdown script
injection and safe link attributes.
