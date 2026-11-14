import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearLocalData, clearDeviceState } from './runtime';
import { createTestClient, createTestServer, sync, type TestClient } from './test/harness';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  vi.unstubAllGlobals();
});

async function pair() {
  const s = await createTestServer();
  cleanups.push(() => s.close());
  const a = createTestClient(s);
  const b = createTestClient(s);
  cleanups.push(() => a.close());
  cleanups.push(() => b.close());
  return { s, a, b };
}

describe('LocalStore.transaction', () => {
  it('accepts a plain arrow returning a promise with a deep async chain', async () => {
    const { a } = await pair();
    const tick = () => new Promise<void>((r) => queueMicrotask(r));
    const deep = async (n: number): Promise<void> => {
      if (n === 0) {
        await a.local.put('tasks', { title: 'deep', sortKey: 'a0' });
        return;
      }
      await tick();
      await deep(n - 1);
    };
    // `() => helper()` used to throw PrematureCommitError.
    await a.local.transaction(() => deep(5));
    expect((await a.local.list('tasks')).map((t) => t.title)).toEqual(['deep']);
  });

  it('rolls back when the function rejects', async () => {
    const { a } = await pair();
    await expect(
      a.local.transaction(async () => {
        await a.local.put('tasks', { title: 'x', sortKey: 'a0' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await a.local.list('tasks')).toEqual([]);
  });
});

describe('onPullApplied', () => {
  it('fires after a pulled page is stored, naming the changed collections', async () => {
    const { a, b } = await pair();
    const seen: string[][] = [];
    const seenRecords: number[] = [];
    b.local.onPullApplied(async (names) => {
      seen.push(names);
      seenRecords.push((await b.local.list('tasks')).length); // already durable
    });
    await a.local.put('tasks', { title: 'one', sortKey: 'a0' });
    await a.local.put('postits', { text: 'p', sortKey: 'a0' });
    await sync(a);
    await sync(b);
    expect(seen).toHaveLength(1);
    expect([...seen[0]!].sort()).toEqual(['postits', 'tasks']);
    expect(seenRecords).toEqual([1]);
    // Nothing new to pull: no notification.
    await sync(b);
    expect(seen).toHaveLength(1);
  });

  it('stops notifying after unsubscribe', async () => {
    const { a, b } = await pair();
    const fn = vi.fn();
    const off = b.local.onPullApplied(fn);
    off();
    await a.local.put('tasks', { title: 'one', sortKey: 'a0' });
    await sync(a);
    await sync(b);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('clearing device state', () => {
  it('clearLocalData removes webfront.* keys and the wiki attachment cache, keeps theme/sidebar', async () => {
    const store = new Map<string, string>([
      ['webfront.wiki.draft.abc', '1'],
      ['webfront.shopping.lastList', 'x'],
      ['webfront.calendar.hiddenFeeds', '[]'],
      ['wf.theme', 'dark'],
      ['wf.sidebar', 'collapsed'],
      ['other.key', 'keep'],
    ]);
    vi.stubGlobal('localStorage', {
      get length() {
        return store.size;
      },
      key: (i: number) => [...store.keys()][i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    // Create the wiki attachment database.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('webfront-wiki-attachments', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('pending', { keyPath: 'localId' });
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
    expect((await indexedDB.databases()).map((d) => d.name)).toContain('webfront-wiki-attachments');

    await clearLocalData();

    expect([...store.keys()].sort()).toEqual(['other.key', 'wf.sidebar', 'wf.theme']);
    expect((await indexedDB.databases()).map((d) => d.name)).not.toContain(
      'webfront-wiki-attachments',
    );
    await expect(clearDeviceState()).resolves.toBeUndefined();
  });

  it('clearLocalData deletes the service worker caches holding private API responses', async () => {
    const names = new Set(['wf-attachments', 'wf-favicons', 'workbox-precache-v2-x']);
    vi.stubGlobal('caches', {
      delete: async (name: string) => names.delete(name),
    });
    await clearLocalData();
    // The app shell precache stays (offline sign-in screen); private caches are gone.
    expect([...names]).toEqual(['workbox-precache-v2-x']);
    vi.unstubAllGlobals();
  });
});

export type { TestClient };
