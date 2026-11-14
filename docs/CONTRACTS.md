# Webfront: contracts and conventions

Read this together with `docs/PLAN.md` before starting any task. It is the developer guide for
everyone building on the Task 1 scaffold. **Rule one: edit only the files your task owns.** If you
need a change in a file you do not own, keep working around it and list the change you need in
your report.

## Commands

All from the repo root (Node >= 22; `.npmrc` disables audit, fund and update checks).

| Command                           | What it does                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------ |
| `npm install`                     | Install all workspaces                                                                     |
| `npm run dev`                     | Server (`tsx watch`, port 8787) and Vite (port 5173, proxies `/api` to 8787) together      |
| `npm run build`                   | `packages/shared` (tsc) → `apps/server` (tsc → `dist/`) → `apps/web` (vite → `dist/`)      |
| `npm start`                       | Run the built server (`node apps/server/dist/index.js`), which also serves `apps/web/dist` |
| `npm run typecheck`               | `tsc --noEmit` in every workspace                                                          |
| `npm test`                        | Vitest across all three workspaces (`vitest.config.ts` projects)                           |
| `npm run format` / `format:check` | Prettier                                                                                   |

Run one workspace with `-w`, e.g. `npm test -w apps/server` or `npx vitest run --project shared`.
`build`, `typecheck` and `test` must all pass before you finish.

How `@webfront/shared` resolves: typecheck, Vite, Vitest and `tsx` use its TypeScript source (tsconfig
`paths` / Vite `alias`), so no build is needed during development. Only the production server
(`node dist/...`) uses `packages/shared/dist`, so `npm run build` builds shared first.

## Folder ownership

| Task                   | Owns (create and edit freely)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Scaffold             | Root config, `packages/shared/src/{index,ids,hlc,record,sortKey,colours,registry}.ts`, `packages/shared/src/api/{common,sync}.ts`, `packages/shared/src/collections/common.ts`, `apps/server/src/{app,config,context,events,logger,index}.ts`, `apps/server/src/db/{database,migrate}.ts`, `apps/server/src/http/{errors,validate}.ts`, `apps/server/src/features/index.ts`, `apps/server/test/`, `apps/server/migrations/001–009`, `apps/web/src/features/{types,registry,context}.ts(x)`, `apps/web/src/data/types.ts`, this file |
| 2 Server auth          | `apps/server/src/features/auth/**`, `packages/shared/src/api/auth.ts`, migrations `010–019`                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 3 Sync engine          | `apps/server/src/features/sync/**`, `apps/server/src/db/recordRows.ts`, `apps/web/src/data/**` (except `types.ts`, see below), migrations `020–029`                                                                                                                                                                                                                                                                                                                                                                                 |
| 4 App shell            | `apps/web/src/{app,ui,auth,lib,styles}/**`, `apps/web/src/main.tsx`, `apps/web/index.html`, `apps/web/public/**`, `apps/web/vite.config.ts`, `apps/server/src/http/static.ts`                                                                                                                                                                                                                                                                                                                                                       |
| 5 Bookmarks            | `apps/web/src/features/bookmarks/**`, `apps/server/src/features/{services,favicons}/**`, `packages/shared/src/collections/{bookmarks,services}.ts`, migrations `040–049`, `060–069`                                                                                                                                                                                                                                                                                                                                                 |
| 6 Post-its, to-do      | `apps/web/src/features/{postits,tasks}/**`, `packages/shared/src/collections/notes.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 7 Shopping             | `apps/web/src/features/shopping/**`, `packages/shared/src/collections/shopping.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 8 Wiki                 | `apps/web/src/features/wiki/**`, `apps/server/src/features/attachments/**`, `packages/shared/src/collections/wiki.ts`, migrations `050–059`                                                                                                                                                                                                                                                                                                                                                                                         |
| 9 Calendar             | `apps/web/src/features/calendar/**`, `apps/server/src/features/calendar/**`, `packages/shared/src/collections/calendar.ts`, migrations `030–039`                                                                                                                                                                                                                                                                                                                                                                                    |
| 10 Dashboard, settings | `apps/web/src/features/{dashboard,settings}/**`, `packages/shared/src/collections/settings.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 11 Deployment          | `deploy/**`, `README.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 12 E2E and security    | `e2e/**` and Playwright config; fixes anywhere, coordinated by the integrator                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Contract files owned by Task 1 (`registry.ts`, `record.ts`, `hlc.ts`, `api/sync.ts`, server
`context.ts`/`events.ts`, web `features/types.ts`/`data/types.ts`) change only through the
integrator. Task 3 may need small changes to `data/types.ts`; request them in your report.

**Dependencies.** Everything named in PLAN.md is already installed (Dexie, dexie-react-hooks,
CodeMirror, markdown-it, DOMPurify, MiniSearch, dnd-kit, lucide-react, @simplewebauthn/\*,
@node-rs/argon2, node-ical). If you really need another package, install it with
`npm install -w <workspace> <pkg>` and name it in your report: `package.json` and the lockfile are
the one shared edit the integrator reconciles.

## The data model (packages/shared)

Every synced record is flat: the envelope plus domain fields.

```ts
{ id, createdAt, updatedAt, deleted, clocks: { title: '<hlc>', deleted: '<hlc>', … }, title, … }
```

- `id`: UUIDv7 from `newId()`. Settings use their key as id (`idKind: 'key'`); `serviceStatuses`
  use the bookmark id; calendar events get deterministic ids from the server.
- `deleted`: tombstone. It is a clocked field, so delete and undelete merge like any other field. Never
  hard-delete synced records.
- `clocks`: one HLC stamp per field (`hlc.ts`; a fixed-width string, so compare with `<`, never
  `localeCompare`). `mergeRecord(local, remote)` keeps, for each field, the value with the newer
  stamp. It is commutative, associative and idempotent (tested).
- `createdAt` and `updatedAt` are ISO strings. Merge keeps the earliest `createdAt` and the latest
  `updatedAt`. Neither is used for conflict resolution.
- Use `null` for "no value", never `undefined`/missing. Every field has a value in a stored record.
- Field schemas use `.default()` for optional-on-create fields. `FieldsInput<'x'>` is the create shape
  and `FieldsOf<'x'>` the stored shape. `parseRecord` fills defaults, so a field added later with a
  default is backwards compatible.
- Colours: `ColourKey` from the 12-key `COLOUR_KEYS`. Tags without an explicit colour use
  `colourForLabel(tag)`, and explicit tag colours live in the `tags.colours` setting.
- Ordering: `sortKey` (fractional index). Use `sortKeyBetween`, `sortKeyForIndex` and
  `compareBySortKey` (which breaks ties by id) from `sortKey.ts`. Post-its' "position" is a
  `sortKey` (grid order), not x/y.
- Booleans and nulls cannot be IndexedDB index keys, so filter on them in memory.

Collections (`registry.ts`): writable are `bookmarkCategories`, `bookmarks`, `postits`, `tasks`,
`shoppingLists`, `shoppingItems`, `wikiPages`, `wikiRevisions`, `calendarFeeds` and `settings`.
Server-owned (read-only for clients) are `calendarEvents` and `serviceStatuses`.

### Adding a collection or field

1. Add or extend the `z.object` of domain fields in `packages/shared/src/collections/<area>.ts` (your
   own file). Use `nullable().default(null)` or a default for every new field on an existing collection.
2. New collection only: add one `defineCollection({...})` entry in `registry.ts` with the name, fields,
   `writable`, `indexes` (Dexie syntax) and optionally `idKind` or `textMergeFields`. This is a Task 1
   file, so ask the integrator. Nothing else changes: the server stores every collection in the
   generic `records` table, and the Dexie layer builds stores by iterating `listCollections()`.
   Adding a store or index needs a new Dexie version (Task 3 derives it from the registry).

### Settings

`settings` records are `{ id: '<key>', value: <json> }`. Core keys are in `coreSettings`
(`collections/settings.ts`). Define feature-specific settings in your own folder with
`defineSetting('<feature>.<name>', schema, default)` and read them with `readSetting(def, raw)`.

## Sync protocol (`packages/shared/src/api/sync.ts`)

- `POST /api/sync/push` `{ clientId, changes: [{ collection, id, createdAt, fields: { f: { value, hlc } } }] }`
  returns a per-change `applied` (with `seq`), `unchanged` or `rejected` result, plus `maxSeq`.
  Pushes to server-owned collections, unknown fields, invalid values and stamps more than
  `MAX_CLOCK_DRIFT_MS` ahead are rejected.
- `GET /api/sync/pull?since=<seq>&limit=<n>` returns full records with `seq > since` in seq order, and
  `{ cursor, hasMore, serverId }`. If `serverId` changes (the database was restored), pull from 0
  and re-push.
- `GET /api/sync/events` is SSE: `hello` once, then `changed` pokes with `{ maxSeq, originClientId }`.
- The server assigns seq from `meta.records_seq` (it only ever increases). A record's seq is the
  seq of its latest accepted change. `clientId` is 16 hex chars and doubles as the HLC node id.
- Wiki `body` (`textMergeFields`): the server does plain LWW. The client does a three-way merge
  against `baseRevisionId` before pushing, or via a `fieldResolvers` hook in `mergeRecord`. On
  failure it keeps the other side in `conflict`.

## Server

### Feature modules

Each `apps/server/src/features/<name>/index.ts` exports `register(app, ctx)`. They are listed once in
`features/index.ts`, in this order: auth, sync, calendar, services, favicons, attachments.

```ts
export function register(app: App, ctx: AppContext) {
  const r = new Hono<AppEnv>();
  r.post('/feeds/:id/refresh', ctx.requireAuth, async (c) => { … return c.json({ ok: true }); });
  app.route('/api/calendar', r);
  const timer = setInterval(…); ctx.onClose(() => clearInterval(timer));
}
```

`AppContext` (`src/context.ts`):

| Member        | Use                                                                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config`      | Validated env (`config.ts`): `dataDir`, `dbPath`, `attachmentsDir`, `publicOrigin`, `rpId`, `trustProxy`, …                                                      |
| `db`          | SQLite wrapper (`db/database.ts`): `get/all/run/iterate/exec/transaction`. Statements are cached and booleans become 0/1. Never import `better-sqlite3` directly |
| `logger`      | JSON lines; `logger.child({ feature: 'x' })`. Never log secrets, cookies, tokens or ICS URLs                                                                     |
| `events`      | Typed bus (`events.ts`): `records.changed` (sync emits, SSE listens), `session.revoked` (auth emits)                                                             |
| `requireAuth` | Route middleware. Fails closed (401) until auth calls `ctx.installAuthGuard(guard)`                                                                              |
| `records`     | `RecordStore`: `writeAsServer`, `get`, `list`, `applyChanges`, `pull`, `maxSeq`, `serverId`. Throws 501 until sync calls `ctx.installRecordStore(store)`         |
| `onClose`     | Cleanup on shutdown                                                                                                                                              |

Auth installs its session-loading and CSRF middleware with `app.use('/api/*', …)` inside its
`register`, which runs before every other feature's routes. It sets `c.var.session` (`AuthSession`).
`/api/health` is registered first and stays public. Mutations must send `x-csrf-token` (`CSRF_HEADER`).

Server-owned writes (calendar, services) go through `ctx.records.writeAsServer(collection, [{ id, fields }])`,
never through raw SQL on `records`, so that seq, HLC stamps and SSE pokes stay correct.

### Errors and validation

Throw `AppError(status, code, message, details?)` or use the helpers (`badRequest`, `unauthorized`,
`notFound`, `conflict`, …) from `http/errors.ts`. A thrown `ZodError` becomes 400
`validation_error`, and unknown errors become 500 with no internals. The body is always the shared
`ApiError` shape. Parse input with `parseJson(c, schema)`, `parseQuery(c, schema)` and
`parseParams(c, schema)` from `http/validate.ts`. Add routes to `API` in `api/common.ts` (ask the
integrator) and use shared zod schemas for request and response shapes.

### Migrations

Migrations are `apps/server/migrations/NNN_name.sql`, plain SQL with no BEGIN/COMMIT. Each file
runs in its own transaction. Any unapplied number runs in ascending order, so gaps and late
lower numbers are fine. Never edit an applied file; add a new one. Use `STRICT` tables.

| Range   | Owner                            |
| ------- | -------------------------------- |
| 001–009 | core (Task 1): `meta`, `records` |
| 010–019 | auth (Task 2)                    |
| 020–029 | sync (Task 3)                    |
| 030–039 | calendar (Task 9)                |
| 040–049 | services (Task 5)                |
| 050–059 | attachments (Task 8)             |
| 060–069 | favicons (Task 5)                |
| 070–099 | integrator                       |

The core tables are `meta(key, value)`, seeded with `server_id` and `records_seq`, and
`records(collection, id, data JSON, clocks JSON, deleted, created_at, updated_at, seq)` with
primary key `(collection, id)`, a unique index on `seq` and an index on `(collection, deleted)`.
`db/recordRows.ts` converts between rows and records.

### Tests

Server tests use `test/helpers.ts`:
`const { app, ctx } = await createTestApp({ features: [{ name: 'x', register }], signedIn: true })`.
This gives an in-memory, migrated database and no network. Call `await app.request('/api/...')`. Put
feature tests next to the code (`src/features/<name>/*.test.ts`). Do not bind ports in tests.

## Web

### Feature descriptor

Each `apps/web/src/features/<name>/index.tsx` default-exports `defineFeature({...})`
(`features/types.ts`):

| Field              | Purpose                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | Folder name                                                                                                                                   |
| `routes`           | `RouteObject[]` inside the layout. Paths are relative (`'wiki/:slug'`); the home page uses `index: true`                                      |
| `bareRoutes`       | Routes without chrome (e.g. `/capture` for the bookmarklet)                                                                                   |
| `nav`              | `{ label, icon (lucide), path, order, shortcut }`                                                                                             |
| `dashboardWidgets` | `[{ id, title, component, order }]`. The id must be in `DASHBOARD_SECTION_IDS` (search, bookmarks, services, postits, agenda, shopping, wiki) |
| `searchProvider`   | `{ id, label, search(query, limit) → SearchResult[] }`, local data only and never throws                                                      |
| `settingsPanels`   | `[{ id, title, component, order }]`                                                                                                           |
| `commands`         | Command-palette entries `{ id, title, keywords, shortcut, run({ navigate }) }`                                                                |

`features/registry.ts` lists all eight features once. The shell, dashboard and settings read
everything through `useFeatures()` (`features/context.tsx`), never by importing other features.
Widget ownership: bookmarks and services belong to Task 5, postits to Task 6, shopping to Task 7,
agenda (calendar events plus due tasks) to Task 9, and wiki to Task 8. The search widget and the
section order belong to Task 10.

### Allowed imports for feature code

`@/data`, `@/ui`, `@/auth`, `@/lib/api`, `@webfront/shared`, `../types` (for `defineFeature`), files
in your own folder, React, react-router and npm packages. Never import another feature's folder,
`@/app`, Dexie or `features/registry`.

### Data layer (`@/data`, contract in `data/types.ts`)

```ts
const items = useCollection('shoppingItems', { where: { listId }, sort: compareBySortKey }); // undefined while loading
const page = useRecord('wikiPages', id);           // undefined loading, null missing
const n = useLiveData((db) => db.list('tasks').then((t) => t.length), []);
await put('tasks', { title: 'x', sortKey });      // create, returns the record
await patch('tasks', id, { completedAt: new Date().toISOString() });
await remove('tasks', id); await restore('tasks', id);
await transaction(async () => { … });             // atomic local batch
reader.list('bookmarks', { where: { categoryId } });  // non-hook reads (search providers)
useSyncStatus();                                  // { state, pendingChanges, lastSyncedAt, error }
```

Writes are local and offline-safe, and resolve without waiting for the network. Deleted records are
hidden by default. `startSync`, `stopSync` and `syncNow` are for the shell only. Until Task 3 lands,
reads return empty results and writes reject.

### UI, auth and API

- `@/ui`: `Button`, `Input`, `Panel` (tinted header and coloured left edge), `ColourDot`, `TagChip`,
  `Kbd`, `Spinner`, `EmptyState`, `PlaceholderPage`, plus `colourStyle(colour)` and `colourVar(colour)`.
  Palette CSS variables are `--wf-<key>` and `--wf-<key>-soft`, defined in `styles/index.css`. Never
  build Tailwind class names from colour keys; use `bg-[var(--c-soft)]` with `colourStyle`. Base
  type size is 13px, and dark mode uses the `.dark` class on `<html>`.
- `@/auth`: `useAuth()` returns `{ status, session, login, logout, setup, loginWithPasskey, refresh, lock, unlock }`.
- `@/lib/api`: `apiFetch(path, { method, body, schema })`. It throws `ApiRequestError` (status, code)
  or `NetworkError`, and adds the CSRF header once `setCsrfToken` has been called. Only for
  server-only actions; feature data goes through `@/data`.

## Conventions

- TypeScript strict with `noUncheckedIndexedAccess`, ESM everywhere, and Prettier (single quotes,
  width 100). Server and shared relative imports end in `.js` (NodeNext). Web imports have no
  extension (Bundler).
- Names: files `camelCase.ts`, React components `PascalCase.tsx`, collections `camelCase` plural, API
  error codes `snake_case`, setting keys `area.name`, SQL tables `snake_case`.
- Validate every external input with zod, at the HTTP boundary on the server and when reading
  pulled records on the client.
- Spell it "colour" in identifiers and UI text.
- No telemetry and no third-party calls, except fetching the user's own ICS feeds, favicons and
  service checks.

## Addenda after wave 2 (auth, sync, shell landed)

These override anything above that conflicts.

**Feature routes must be lazy.** `routes: [{ path: 'wiki/*', lazy: async () => ({ Component: (await import('./WikiPage')).WikiPage }) }]`.
Keep `index.tsx` tiny (descriptor, nav, lazy routes, lazy widgets via `React.lazy`) so the main bundle
stays small. Heavy libraries (CodeMirror, markdown-it) must only be imported from lazily loaded files.

**Styling.** Use the semantic token utilities, never raw Tailwind greys or `dark:` classes: `bg-bg`,
`bg-surface`, `bg-surface-2`, `border-line`, `text-fg`, `text-fg-2`, `text-fg-3`, `bg-accent`,
`text-accent-text`, `bg-accent-soft`, and `ok` / `warn` / `bad` with `-soft` and `-text` variants.
Palette colours: wrap with `style={colourStyle(colour)}` then `bg-[var(--c-soft)]`,
`text-[color:var(--c)]`, `border-[color:var(--c)]` (the `color:` hint is required for text and border).
Root font is 13px and breakpoints are in px (`sm` = 640px). Rows are 24px on desktop, 44px on phone;
use `List` / `ListRow` and `useIsPhone()` rather than re-deriving sizes. Look at `/dev/ui`
(`apps/web/src/app/dev/`) for every component in use before building screens.

**`@/ui` also exports** `IconButton`, `Textarea`, `Select`, `Field`, `Checkbox`, `Switch`, `Modal`,
`ConfirmDialog`, `Drawer`/`Sheet`, `Popover`, `DropdownMenu`, `Tooltip`, `Tabs`/`TabPanel`,
`useToast`, `ColourPicker`, `TagInput`, `normaliseTag`, `StatusDot`, `Badge`, `Shortcut`, `Skeleton`,
`PageHeader`, `Toolbar`, `List`/`ListRow`, `DragHandle`, `useHotkeys`, `useIsPhone`, `useOnline`,
`useShellActions` (`openPalette`, `openShortcuts`), `useTheme`, `formatRelativeShort`, `cx`. Read
`apps/web/src/ui/index.ts` for props. The command palette is global shell chrome: features only
supply `commands` and a `searchProvider`.

**Data layer behaviour (`@/data`).**
- Writes resolve once stored locally; only fields whose value changes are stamped.
- `patch` / `remove` / `restore` on a missing id reject with `DataError('not_found')`; writes to
  server-owned collections reject with `DataError('read_only')`; invalid values throw `ZodError`.
- `put` on settings needs `{ id: '<key>', value }`.
- Inside `transaction(fn)` only await `@/data` calls (awaiting fetch or timers commits early).
- `useCollection` re-runs only when `collection`, `where`, `limit`, `includeDeleted` or explicit
  `deps` change: put anything your `filter` / `sort` closes over into `deps`.
- `where` uses single-field indexes only; booleans, nulls and tag arrays filter in memory.
- Server modules: `ctx.records.get` returns tombstoned records; `writeAsServer` only stamps fields
  whose value changed and never undeletes unless you pass `deleted: false`.
- See `apps/web/src/data/README.md` (if present) for merge hooks.

**Auth and API.** Every mutating `/api/*` call needs the CSRF header; `apiFetch` adds it. Server
routes use `ctx.requireAuth`. Any request body over 64 KB under `/api/auth` is rejected; other
features set their own limits. A migration added by any feature must not assume it is the only one.

**Tests.** Web component tests opt in with `// @vitest-environment jsdom` at the top of the file and
may use Testing Library. Data-layer tests can use `fake-indexeddb/auto`.
