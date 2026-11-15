import { newId } from '@webfront/shared';
import { onDataReset, patch, put, reader, registerRecordResolver, transaction } from '@/data';
import {
  createLocalStorageStore,
  createWikiResolver,
  reconcilePage,
  type BodyStateStore,
  type PendingSnapshot,
  type ReconcileIO,
} from './lib/bodySync';

/**
 * App wiring of the wiki body sync (see lib/bodySync.ts): the per-device BodyState store, the
 * `@/data`-backed IO, the record resolver registration and the background reconciler.
 * Imported by index.tsx so the resolver is registered at module load, before any pull.
 * Deliberately small: no markdown-it, CodeMirror or MiniSearch here.
 */

export const bodyStore: BodyStateStore = createLocalStorageStore();

export const wikiIO: ReconcileIO = {
  get: (id) => reader.get('wikiPages', id),
  patch: (id, changes) => patch('wikiPages', id, changes),
  snapshot: (s) => writeSnapshot(s),
  // The scope must be an async function that awaits (Dexie zone tracking).
  transaction: (fn) => transaction(async () => await fn()),
  newId: () => newId(),
  now: () => Date.now(),
};

function writeSnapshot(s: PendingSnapshot) {
  return put(
    'wikiRevisions',
    { pageId: s.pageId, title: s.title, body: s.body, parentRevisionId: null },
    { id: s.id },
  );
}

/* ------------------------------------------------- snapshots queued by the resolver */

const QUEUE_KEY = 'webfront.wiki.pendingSnapshots';
let queue: PendingSnapshot[] = loadQueue();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function loadQueue(): PendingSnapshot[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as PendingSnapshot[]) : [];
  } catch {
    return [];
  }
}

function saveQueue() {
  try {
    if (queue.length === 0) localStorage.removeItem(QUEUE_KEY);
    else localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // Storage full: the snapshots stay in memory until flushed.
  }
}

/** Write queued revision snapshots (outside the pull's transaction). */
export async function flushSnapshots(): Promise<void> {
  flushTimer = null;
  while (queue.length > 0) {
    const s = queue[0]!;
    try {
      const exists = await reader.get('wikiRevisions', s.id);
      if (!exists) await writeSnapshot(s);
    } catch (err) {
      console.warn('wiki: could not write a merge snapshot', err);
    }
    queue = queue.slice(1);
    saveQueue();
  }
}

function enqueueSnapshots(snaps: PendingSnapshot[]) {
  queue = [...queue, ...snaps];
  saveQueue();
  flushTimer ??= setTimeout(() => void flushSnapshots(), 0);
}

/* ---------------------------------------------------------------------- resolver */

let registered = false;

export function registerWikiResolver(): void {
  if (registered) return;
  registered = true;
  registerRecordResolver(
    'wikiPages',
    createWikiResolver({ store: bodyStore, newId: () => newId(), onSnapshots: enqueueSnapshots }),
  );
  // Local data was replaced (server restore) or wiped (sign-out): merge bases, draft backups
  // and queued snapshots describe the old pages and must not be merged onto the new ones.
  onDataReset(forgetDeviceState);
  if (queue.length > 0) flushTimer ??= setTimeout(() => void flushSnapshots(), 0);
}

/** Draft backups written by useBodyEditor (`webfront.wiki.draft.<id>`). */
const DRAFT_PREFIX = 'webfront.wiki.draft.';

function forgetDeviceState(): void {
  for (const id of bodyStore.keys()) bodyStore.delete(id);
  queue = [];
  saveQueue();
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(DRAFT_PREFIX)) doomed.push(key);
    }
    for (const key of doomed) localStorage.removeItem(key);
  } catch {
    // storage unavailable
  }
}

/* -------------------------------------------------------------------- reconciler */

const RECONCILE_INTERVAL_MS = 4000;
const STATE_TTL_MS = 30 * 86_400_000;
let reconcileTimer: ReturnType<typeof setInterval> | null = null;
let running: Promise<void> | null = null;
const listeners = new Set<(pageId: string, kind: string) => void>();

/** Notified when the reconciler merged or flagged a page (for a toast). */
export function onReconciled(fn: (pageId: string, kind: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Check every page this device has unconfirmed edits for. */
export function reconcileNow(): Promise<void> {
  running ??= (async () => {
    try {
      const now = Date.now();
      for (const id of bodyStore.keys()) {
        const state = bodyStore.get(id);
        if (!state) continue;
        if (!state.own) {
          if (now - state.updatedAt > STATE_TTL_MS) bodyStore.delete(id);
          continue;
        }
        try {
          const kind = await reconcilePage(wikiIO, bodyStore, id);
          if (kind === 'merged' || kind === 'conflict') for (const fn of listeners) fn(id, kind);
        } catch (err) {
          console.warn('wiki: reconcile failed', err);
        }
      }
    } finally {
      running = null;
    }
  })();
  return running;
}

export function startReconciler(): void {
  if (reconcileTimer || typeof window === 'undefined') return;
  reconcileTimer = setInterval(() => {
    if (document.visibilityState === 'visible') void reconcileNow();
  }, RECONCILE_INTERVAL_MS);
  void reconcileNow();
}
