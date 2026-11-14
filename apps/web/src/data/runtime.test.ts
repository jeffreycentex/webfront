import 'fake-indexeddb/auto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  _dbForTests,
  clearLocalData,
  patch,
  put,
  reader,
  registerFieldResolvers,
  startSync,
  stopSync,
  syncNow,
  transaction,
} from './index';
import { getLocal } from './runtime';
import { createTestServer } from './test/harness';

describe('@/data runtime (singletons, leader lock, HTTP transport)', () => {
  afterAll(async () => {
    await stopSync();
    vi.unstubAllGlobals();
  });

  it('writes locally without sync, then syncs once started, and clears on sign-out', async () => {
    const s = await createTestServer();
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      s.app.request(input as string, init),
    );

    const rec = await put('tasks', { title: 'local first', sortKey: 'a0' });
    await patch('tasks', rec.id, { notes: 'n' });
    await transaction(async () => {
      await put('settings', { value: { a: 1 } }, { id: 'test.thing' });
    });
    expect((await reader.list('tasks')).map((t) => t.title)).toEqual(['local first']);
    expect(await _dbForTests().table('_outbox').count()).toBe(2);
    expect(s.ctx.records.get('tasks', rec.id)).toBeUndefined();

    registerFieldResolvers('wikiPages', { body: ({ winner }) => winner });

    await startSync();
    await syncNow();
    expect(s.ctx.records.get('tasks', rec.id)).toMatchObject({ title: 'local first', notes: 'n' });
    expect(s.ctx.records.get('settings', 'test.thing')?.value).toEqual({ a: 1 });
    const status = await getLocal().readStatus();
    expect(status).toMatchObject({ state: 'idle', pendingChanges: 0, rejectedChanges: 0 });

    await clearLocalData();
    expect(await reader.list('tasks')).toEqual([]);
    expect(await _dbForTests().table('_outbox').count()).toBe(0);
    // Server data is untouched by a local clear.
    expect(s.ctx.records.get('tasks', rec.id)).toBeDefined();
    await s.close();
  });
});
