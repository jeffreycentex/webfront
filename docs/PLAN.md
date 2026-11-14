# Webfront — build plan

Personal homepage app: bookmarks, post-its, shopping list, calendars, wiki.
Single user, local-first (full offline editing with sync), reached over Tailscale, hosted in a Proxmox LXC.

## Decisions (from Q&A)

| Topic | Decision |
|---|---|
| Users | One account. No sharing or permissions model. |
| Network | Tailscale. `tailscale serve` terminates HTTPS at `https://webfront.<tailnet>.ts.net` (HTTPS is required for the service worker and passkeys). |
| Offline | Full offline read and write on every device; changes sync when the server is reachable. |
| Calendars | Read-only ICS feeds (Outlook published link, Google secret iCal address), fetched and cached by the server, merged view. |
| Sign-in | Username/password with a long-lived per-device session, plus optional passkeys. |
| Credential hints | Username and a hint only, never real passwords. Masked until clicked. Stored unencrypted. |
| Wiki | Markdown with live preview, `[[page links]]`, backlinks. |
| Devices | Desktop-first (Windows/Mac browsers), responsive and installable on phone. |
| Visual style | Compact and data-rich but colourful: small type and tight rows, with per-category colours, sticky-note post-its and coloured tags; keyboard-first, light and dark themes. |
| Bookmark layout | Compact category columns of icon + name rows; type anywhere to filter, Enter opens the top match. |
| Extras | Web search bar, save-this-page bookmarklet, to-do list, homelab service status tiles. |
| Imports | None for v1 beyond restoring the app's own JSON export. |

## Architecture

```
Browser (PWA)                                LXC container
┌──────────────────────────────┐            ┌─────────────────────────────┐
│ React UI                     │            │ tailscale serve (HTTPS)     │
│   ↕ live queries             │            │   ↓                         │
│ IndexedDB (Dexie)  ← source  │  push/pull │ Node server (Hono)          │
│   of truth for the UI        │ ─────────► │   auth, sync, ICS, favicons │
│ Outbox of pending changes    │ ◄───────── │   ↓                         │
│ Service worker (app shell)   │    SSE     │ SQLite file + attachments   │
└──────────────────────────────┘            └─────────────────────────────┘
```

- **Monorepo** (npm workspaces, TypeScript everywhere)
  - `packages/shared` — zod schemas for every entity and the sync protocol. The single contract both sides import.
  - `apps/server` — Hono on Node 22, `better-sqlite3`, SQL migrations, `@node-rs/argon2`, `@simplewebauthn/server`, `node-ical`. Also serves the built web app.
  - `apps/web` — React + Vite, `vite-plugin-pwa` (Workbox), Dexie, Tailwind, CodeMirror 6, `markdown-it` + DOMPurify, MiniSearch, dnd-kit.
- **Local-first data flow.** The UI only ever reads and writes IndexedDB. A sync engine pushes an outbox of changes and pulls everything after its last cursor. The server pokes open tabs over SSE so other devices update within a second or two.
- **Sync rules.** Client-generated UUIDv7 ids; soft deletes (tombstones); the server assigns a monotonically increasing sequence number per change, which is the pull cursor. Conflicts are per-field last-writer-wins using a hybrid logical clock. Wiki page bodies get a three-way text merge against the last synced revision; if that fails, both versions are kept and the page is flagged.
- **Auth.** Argon2id password hash, HttpOnly session cookie (90-day sliding), passkey registration/login with the Tailscale hostname as RP ID, login rate limiting, CSRF protection on mutations. First run shows a one-time "create account" screen.
- **Offline access.** The app shell loads from the service worker cache. A device that has signed in before opens straight into its local copy when the server is unreachable. An optional idle lock screen is a convenience lock only: local data is not encrypted, so device security rests on the OS login and disk encryption.
- **Calendars.** Server fetches each feed every 15 minutes, expands recurring events for a rolling window (30 days back, 180 ahead), and exposes them as a read-only synced collection, so the agenda works offline.

## Features

**Design language.** Compact, data-rich and colourful. 13px base type and tight row heights so a lot fits on screen, with colour carrying meaning and personality: every bookmark category, shopping list, wiki section and calendar feed has its own colour (picked from a 12-colour palette tuned for both light and dark themes) shown as a tinted header and left edge; post-its are real sticky-note colours; tags are coloured chips; service status, due dates and sync state use green/amber/red. Density comes from spacing, not from greyness: no large empty cards or oversized padding. Everything reachable by keyboard; shortcuts shown in tooltips and a `?` cheat sheet. Phone layout switches to a bottom tab bar with larger touch targets.

**Dashboard (home).** Meant to replace the browser's new-tab page. Search bar focused on load: it filters your own bookmarks, notes, tasks and wiki pages as you type, Enter opens the top match, and if nothing matches (or with `Ctrl/Cmd+Enter`) it goes to a configurable web search engine. Below it: bookmark category columns, service status row, post-its, today's agenda with due tasks, shopping list, recent wiki pages. Sections can be hidden and reordered in settings. Command palette on `Ctrl/Cmd+K`.

**Bookmarks.** Categories (nested one level) shown as compact columns of icon + name rows, tags, drag to reorder, favicon fetched and cached by the server, username + hint (masked, click to reveal, copy username), notes in Markdown, dead-link check on demand.

**Save-this-page bookmarklet.** A link dragged to the browser's bookmarks bar from settings. Clicking it on any page opens a small Webfront window pre-filled with that page's title and URL; pick a category and save.

**Service tiles.** Any bookmark can be flagged as a service. The server checks it every minute from inside the network (HTTP status or TCP port, self-signed certificates allowed) and the bookmark shows an up/down dot with last-change time. The dashboard has a compact status row of all services.

**To-do list.** Tasks with optional due date and notes, quick add, complete/reopen, overdue highlighting. Due and overdue tasks appear in the dashboard agenda alongside calendar events.

**Post-its.** Quick capture box, colours, pin, drag to arrange, archive rather than delete.

**Shopping list.** Multiple lists, quick add with autocomplete from past items, quantity and optional store section, check off, clear checked, big touch targets on phone.

**Calendar.** Feed manager (name, URL, colour), agenda and month views, merged across feeds, link out to the source calendar.

**Wiki.** Page tree, Markdown editor with live preview, `[[links]]` with autocomplete and create-on-click, backlinks, revision history with restore, pasted/dropped images (stored as attachments, cached for offline), full-text search.

**Settings.** Password change, passkeys, sessions/devices list with revoke, calendar feeds, full JSON export/import, sync status.

## Build tasks and model assignment

Opus gets the parts where a subtle mistake corrupts data or weakens security; Sonnet gets well-specified feature work. Each agent owns its own folders so parallel agents never edit the same files.

| # | Task | Model | Depends on |
|---|---|---|---|
| 1 | Scaffold monorepo, tooling, `packages/shared` schemas and sync protocol, DB migrations, feature registry stubs | Opus | — |
| 2 | Server auth: password, sessions, passkeys, rate limiting, CSRF, first-run setup | Opus | 1 |
| 3 | Sync engine: server push/pull/SSE, client Dexie stores, outbox, HLC merge, tests | Opus | 1 |
| 4 | App shell: PWA/service worker, layout, routing, theme, design system components, login and lock screens | Sonnet | 1 |
| 5 | Bookmarks (incl. favicon service, bookmarklet capture window, service health checker and status tiles) | Sonnet | 3, 4 |
| 6 | Post-its and to-do list | Sonnet | 3, 4 |
| 7 | Shopping list | Sonnet | 3, 4 |
| 8 | Wiki (editor, links, backlinks, revisions, three-way merge, attachments) | Opus | 3, 4 |
| 9 | Calendar (ICS fetcher, recurrence expansion, views) | Sonnet | 3, 4 |
| 10 | Dashboard, search bar with web-search fallback, command palette, settings, export/import | Sonnet | 5–9 |
| 11 | Deployment: LXC install script, systemd unit, `tailscale serve` setup, nightly SQLite backup, update script, README | Sonnet | 1 |
| 12 | End-to-end tests (Playwright, including offline edit → reconnect → sync on two browser contexts) and a security pass | Opus | 10 |

Order: 1 → (2, 3, 4, 11 in parallel) → (5, 6, 7, 8, 9 in parallel) → 10 → 12. I review each agent's output, run the build and tests between waves, and fix integration issues before starting the next wave.

## Deployment target

- Unprivileged Debian 13 LXC, 1 vCPU / 512 MB RAM / 4 GB disk is plenty.
- Native Node 22 service under systemd (no Docker inside the LXC), data in `/var/lib/webfront` (SQLite file + attachments).
- Tailscale inside the container (needs `/dev/net/tun` passed through in the Proxmox container config), `tailscale serve` for HTTPS.
- Nightly `sqlite3 .backup` with 14-day rotation; the directory is also easy to include in Proxmox Backup.

## Out of scope for v1

Storing real passwords, multi-user sharing, creating/editing calendar events, a browser extension (the bookmarklet covers one-click saving), importers for browser bookmarks or other apps' data, native mobile apps.
