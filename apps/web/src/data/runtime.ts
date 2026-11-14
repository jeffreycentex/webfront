import type Dexie from 'dexie';
import type { CollectionName } from '@webfront/shared';
import { createDatabase, DB_NAME } from './db';
import { SyncEngine } from './engine';
import { LocalStore, type FieldResolverSource, type RecordResolver } from './local';
import { createHttpTransport } from './transport';

/**
 * App-wide singletons: the local store (opened lazily on first use, so reads and writes work
 * before and without sync) and the sync engine, which runs in ONE tab at a time.
 *
 * Leader election uses the Web Locks API: the tab holding `webfront-sync-leader` runs the
 * loop; other tabs see its effects through Dexie live queries (IndexedDB is shared) and
 * forward "I wrote something" / "sync now" / "start" over a BroadcastChannel. Without Web
 * Locks every tab runs its own loop, which is wasteful but safe: pushes are idempotent, acks
 * remove only the exact stamps sent, and pulls merge idempotently.
 */

const LOCK_NAME = 'webfront-sync-leader';
const CHANNEL_NAME = 'webfront-sync';

type Message = { type: 'write' | 'sync' | 'start' | 'stop' };

let local: LocalStore | null = null;
let engine: SyncEngine | null = null;
let channel: BroadcastChannel | null = null;
let wantSync = false;
let isLeader = false;
let releaseLeadership: (() => void) | null = null;
let waitAbort: AbortController | null = null;

export function getLocal(): LocalStore {
  if (!local) {
    local = new LocalStore(createDatabase(DB_NAME));
    local.onLocalWrite(() => {
      if (isLeader) engine?.trigger('write');
      else post({ type: 'write' });
    });
    ensureChannel();
  }
  return local;
}

function getEngine(): SyncEngine {
  engine ??= new SyncEngine(getLocal(), createHttpTransport());
  return engine;
}

function ensureChannel(): void {
  if (channel || typeof BroadcastChannel === 'undefined') return;
  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (event: MessageEvent<Message>) => {
    if (!isLeader || !engine) return;
    switch (event.data?.type) {
      case 'write':
        engine.trigger('write');
        break;
      case 'sync':
        engine.trigger('manual');
        break;
      case 'start':
        if (wantSync) void engine.start();
        break;
      case 'stop':
        void engine.stop();
        break;
    }
  };
}

function post(message: Message): void {
  try {
    channel?.postMessage(message);
  } catch {
    // Channel closed; nothing to notify.
  }
}

async function lead(onStarted: () => void): Promise<void> {
  isLeader = true;
  try {
    if (wantSync) await getEngine().start();
  } finally {
    onStarted();
  }
  await new Promise<void>((release) => {
    releaseLeadership = release;
  });
  isLeader = false;
  releaseLeadership = null;
}

/** Open the local database and begin syncing (after sign-in or offline unlock). */
export async function startSync(): Promise<void> {
  wantSync = true;
  getLocal();
  if (isLeader) {
    await getEngine().start();
    return;
  }
  // Wake up the leader in case it halted (e.g. after a 401 that this tab just fixed).
  post({ type: 'start' });
  if (waitAbort) return; // already queued for leadership

  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) {
    isLeader = true;
    await getEngine().start();
    return;
  }

  const acquired = await new Promise<boolean>((resolve) => {
    locks
      .request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
        if (!lock) return resolve(false);
        await lead(() => resolve(true));
      })
      .catch(() => resolve(false));
  });
  if (acquired || !wantSync) return;

  // Another tab leads: queue up to take over when it closes.
  waitAbort = new AbortController();
  locks
    .request(LOCK_NAME, { signal: waitAbort.signal }, async () => {
      waitAbort = null;
      await lead(() => {});
    })
    .catch(() => {
      waitAbort = null;
    });
}

/** Stop syncing in this tab (sign-out). Local data and the outbox are kept. */
export async function stopSync(): Promise<void> {
  wantSync = false;
  waitAbort?.abort();
  waitAbort = null;
  await engine?.stop();
  if (!locksAvailable()) isLeader = false;
  releaseLeadership?.();
}

function locksAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.locks;
}

/** Push and pull now (forwarded to the leader tab if this tab is not it). */
export async function syncNow(): Promise<void> {
  if (isLeader && engine) await engine.syncNow();
  else post({ type: 'sync' });
}

/**
 * Sign-out: stop syncing everywhere and delete every local record, the outbox and sync
 * metadata (a new client id is created on next use). Irreversible: unsynced edits are lost,
 * so the shell should warn when `pendingChanges > 0`.
 */
export async function clearLocalData(): Promise<void> {
  post({ type: 'stop' });
  await stopSync();
  await getLocal().clear();
  await clearDeviceState();
}

/** Per-device `localStorage` keys that survive sign-out: they are preferences, not data. */
const DEVICE_STATE_PREFIX = 'webfront.';
const WIKI_ATTACHMENTS_DB = 'webfront-wiki-attachments';

/**
 * Remove device-local feature state that is not in the main database: every `webfront.*`
 * localStorage key (wiki drafts and queued snapshots, last shopping list, calendar legend...),
 * the wiki's offline attachment cache and the service worker's private API caches. Theme (`wf.theme`) and sidebar (`wf.sidebar`) use a
 * different prefix and stay. Best effort: storage can be blocked or the database held open.
 */
export async function clearDeviceState(): Promise<void> {
  try {
    if (typeof localStorage !== 'undefined') {
      const doomed: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(DEVICE_STATE_PREFIX)) doomed.push(key);
      }
      for (const key of doomed) localStorage.removeItem(key);
    }
  } catch {
    /* storage blocked */
  }
  try {
    if (typeof indexedDB !== 'undefined') {
      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(WIKI_ATTACHMENTS_DB);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        // Another tab still has it open: the delete completes once that tab closes it.
        req.onblocked = () => resolve();
      });
    }
  } catch {
    /* ignore */
  }
  try {
    // The service worker's runtime caches hold authenticated API responses (wiki images,
    // favicons fetched from private hosts): they must not outlive the session.
    if (typeof caches !== 'undefined') {
      await Promise.all(PRIVATE_CACHES.map((name) => caches.delete(name)));
    }
  } catch {
    /* ignore */
  }
}

/** Service-worker runtime caches with authenticated API responses (see vite.config.ts). */
export const PRIVATE_CACHES = ['wf-attachments', 'wf-favicons'] as const;

/**
 * Subscribe to "a pulled page was durably applied": called with the collections whose records
 * changed (never empty). Fires in the tab that runs the sync loop only.
 */
export function onPullApplied(listener: (collections: CollectionName[]) => void): () => void {
  return getLocal().onPullApplied(listener);
}

/**
 * Register merge hooks for a collection's fields, used when pulled records meet local ones
 * (e.g. the wiki's three-way `body` merge). Pass null to unregister.
 */
export function registerFieldResolvers(
  collection: CollectionName,
  resolvers: FieldResolverSource | null,
): void {
  getLocal().registerFieldResolvers(collection, resolvers);
}

/**
 * Register the record-level merge hook for a collection (one per collection; null removes
 * it). See the "Merge hooks" section at the top of `index.ts`.
 */
export function registerRecordResolver<N extends CollectionName>(
  collection: N,
  resolver: RecordResolver<N> | null,
): void {
  getLocal().registerRecordResolver(collection, resolver);
}

/** Tests only: the Dexie instance behind `@/data`. */
export function _dbForTests(): Dexie {
  return getLocal().db;
}
