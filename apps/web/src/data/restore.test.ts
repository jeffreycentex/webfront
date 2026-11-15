import 'fake-indexeddb/auto';
import { ERROR_CODES, apiErrorSchema, type RecordChange } from '@webfront/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { OUTBOX, type OutboxEntry } from './db';
import { DataError, LocalStore, capSetAside, MAX_SET_ASIDE_CHANGES } from './local';
import type { DataResetEvent, SetAsideBatch } from './local';
import {
  backupServer,
  createTestClient,
  createTestServer,
  restoreServer,
  serverEpoch,
  sync,
  type TestClient,
  type TestServer,
} from './test/harness';

/**
 * Server restore is authoritative (epoch / restore marker): after `webfront-restore` every
 * device discards its synced data and outbox (setting the outbox aside) and pulls the
 * restored data. Uses the REAL server sync feature on a real SQLite file for backup/restore.
 */

const T0 = Date.parse('2026-11-14T10:00:00.000Z');

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function server(): Promise<TestServer> {
  const s = await createTestServer({ now: T0 });
  cleanups.push(() => s.close());
  return s;
}

async function restore(backup: string, opts: { newEpoch?: boolean } = {}): Promise<TestServer> {
  const s = await restoreServer(backup, { now: T0, ...opts });
  cleanups.push(() => s.close());
  return s;
}

function client(s: TestServer, name?: string): TestClient {
  const c = createTestClient(s, name ? { name } : {});
  cleanups.push(() => c.close());
  return c;
}

const outbox = (c: TestClient) => c.local.db.table(OUTBOX).toArray() as Promise<OutboxEntry[]>;
const bookmark = (title: string) => ({
  url: `https://example.com/${encodeURIComponent(title)}`,
  title,
  sortKey: 'a0',
});
const task = (title: string) => ({ title, sortKey: 'a0' });

/** Point the client at the restored server, as after `webfront-restore` restarts the service. */
async function reconnect(c: TestClient, s: TestServer): Promise<void> {
  c.server = s;
  c.sse?.onHello({ serverId: s.ctx.records.serverId(), epoch: serverEpoch(s), maxSeq: 0 });
  await sync(c);
}

describe('restoring a backup is authoritative', () => {
  it('the reported scenario: a bookmark deleted after the backup comes back everywhere', async () => {
    const s1 = await server();
    const c = client(s1);
    const bm = await c.local.put('bookmarks', bookmark('Keep me'));
    await sync(c);
    expect(s1.ctx.records.get('bookmarks', bm.id)?.deleted).toBe(false);
    const epochBefore = serverEpoch(s1);
    expect(await c.local.knownEpoch()).toBe(epochBefore);

    const backup = await backupServer(s1); // webfront-backup

    await c.local.remove('bookmarks', bm.id);
    await sync(c);
    expect(s1.ctx.records.get('bookmarks', bm.id)?.deleted).toBe(true); // tombstone on the server
    expect(await outbox(c)).toEqual([]);

    const s2 = await restore(backup); // webfront-restore (new epoch, same server_id)
    expect(s2.ctx.records.serverId()).toBe(s1.ctx.records.serverId());
    expect(serverEpoch(s2)).not.toBe(epochBefore);
    expect(s2.ctx.records.get('bookmarks', bm.id)?.deleted).toBe(false);

    await reconnect(c, s2);

    // Back locally, and the local tombstone is gone (not merely hidden).
    expect(await c.local.get('bookmarks', bm.id)).toMatchObject({ title: 'Keep me', deleted: false });
    expect(await c.local.get('bookmarks', bm.id, { includeDeleted: true })).toMatchObject({
      deleted: false,
    });
    // Still live on the server: nothing was pushed onto it.
    expect(s2.ctx.records.get('bookmarks', bm.id)).toMatchObject({ deleted: false });
    expect(s2.ctx.records.list('bookmarks', { includeDeleted: true }).every((r) => !r.deleted)).toBe(
      true,
    );
    expect(c.pushes.filter((p) => p.changes > 0 && p.epoch === serverEpoch(s2))).toEqual([]);
    expect(await outbox(c)).toEqual([]);
    expect(await c.local.knownEpoch()).toBe(serverEpoch(s2));
    expect(await c.local.cursor()).toBe(s2.ctx.records.maxSeq());
    expect(await c.local.restoreNotice()).toMatchObject({ setAside: 0, dropped: 0 });
    expect(c.engine.currentStatus.state).toBe('idle');

    // And sync carries on normally under the new epoch.
    await c.local.patch('bookmarks', bm.id, { title: 'Edited after restore' });
    await sync(c);
    expect(s2.ctx.records.get('bookmarks', bm.id)?.title).toBe('Edited after restore');
  });

  it('sets pending offline edits aside instead of pushing them, and they can be retrieved', async () => {
    const s1 = await server();
    const c = client(s1);
    const a = await c.local.put('tasks', task('a'));
    const b = await c.local.put('tasks', task('b'));
    await sync(c);
    const backup = await backupServer(s1);

    c.online = false;
    await c.local.patch('tasks', a.id, { title: 'a edited offline' });
    await c.local.remove('tasks', b.id);
    const created = await c.local.put('tasks', task('created offline'));
    await sync(c); // offline: nothing leaves the device
    expect(await outbox(c)).toHaveLength(3);

    const s2 = await restore(backup);
    c.online = true;
    await reconnect(c, s2);

    // Local data is the restored data.
    expect((await c.local.get('tasks', a.id))?.title).toBe('a');
    expect(await c.local.get('tasks', b.id)).toMatchObject({ deleted: false });
    expect(await c.local.get('tasks', created.id, { includeDeleted: true })).toBeUndefined();
    // The server got none of it.
    expect(s2.ctx.records.get('tasks', a.id)?.title).toBe('a');
    expect(s2.ctx.records.get('tasks', b.id)?.deleted).toBe(false);
    expect(s2.ctx.records.get('tasks', created.id)).toBeUndefined();
    expect(await outbox(c)).toEqual([]);

    // Set aside, with a timestamp, and announced.
    const batches = await c.local.setAsideChanges();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      at: new Date(T0).toISOString(),
      serverId: s1.ctx.records.serverId(),
      fromEpoch: serverEpoch(s1),
      toEpoch: serverEpoch(s2),
    });
    const byId = new Map(batches[0]!.changes.map((ch) => [ch.id, ch]));
    expect(byId.get(a.id)?.fields.title?.value).toBe('a edited offline');
    expect(byId.get(b.id)?.fields.deleted?.value).toBe(true);
    expect(byId.get(created.id)?.fields.title?.value).toBe('created offline');
    expect(await c.local.restoreNotice()).toMatchObject({ setAside: 3 });
    expect((await c.local.readStatus()).pendingChanges).toBe(0);

    await c.local.dismissRestoreNotice();
    expect(await c.local.restoreNotice()).toBeNull();
    expect(await c.local.setAsideChanges()).toHaveLength(1); // kept after dismissing
  });

  it('a second device behaves the same, and both converge on the restored data', async () => {
    const s1 = await server();
    const phone = client(s1, 'phone');
    const laptop = client(s1, 'laptop');
    const bm = await phone.local.put('bookmarks', bookmark('Shared'));
    await sync(phone);
    await sync(laptop);
    const backup = await backupServer(s1);

    await laptop.local.patch('bookmarks', bm.id, { title: 'Renamed on laptop' });
    await sync(laptop);
    await sync(phone);
    expect((await phone.local.get('bookmarks', bm.id))?.title).toBe('Renamed on laptop');
    laptop.online = false;
    await laptop.local.remove('bookmarks', bm.id); // pending when the restore happens
    await sync(laptop);

    const s2 = await restore(backup);
    await reconnect(phone, s2);
    laptop.online = true;
    await reconnect(laptop, s2);

    for (const c of [phone, laptop]) {
      expect(await c.local.get('bookmarks', bm.id)).toMatchObject({ title: 'Shared', deleted: false });
      expect(await outbox(c)).toEqual([]);
      expect(await c.local.knownEpoch()).toBe(serverEpoch(s2));
    }
    expect(s2.ctx.records.get('bookmarks', bm.id)).toMatchObject({ title: 'Shared', deleted: false });
    expect((await phone.local.restoreNotice())?.setAside).toBe(0);
    expect((await laptop.local.restoreNotice())?.setAside).toBe(1);
  });

  it('a push already queued when the restore happens is refused (409) and set aside', async () => {
    const s1 = await server();
    const c = client(s1);
    const rec = await c.local.put('tasks', task('v0'));
    await sync(c);
    const backup = await backupServer(s1);
    const s2 = await restore(backup);
    c.server = s2; // no hello: the client's next push still carries the old epoch
    await c.local.remove('tasks', rec.id);
    await c.engine.syncNow();

    expect(c.pushes.at(-2)).toEqual({ epoch: serverEpoch(s1), changes: 1 }); // refused
    expect(s2.ctx.records.get('tasks', rec.id)?.deleted).toBe(false);
    expect(await c.local.get('tasks', rec.id)).toMatchObject({ deleted: false });
    expect((await c.local.restoreNotice())?.setAside).toBe(1);
    expect(c.engine.currentStatus.state).toBe('idle');
  });

  it('a manual file copy without a new epoch is still caught when the seq went backwards', async () => {
    const s1 = await server();
    const c = client(s1);
    const rec = await c.local.put('tasks', task('v0'));
    await sync(c);
    const backup = await backupServer(s1);
    await c.local.patch('tasks', rec.id, { title: 'v1' });
    await c.local.put('tasks', task('more'));
    await sync(c);
    const s2 = await restore(backup, { newEpoch: false });
    expect(serverEpoch(s2)).toBe(serverEpoch(s1));
    await reconnect(c, s2);
    expect((await c.local.get('tasks', rec.id))?.title).toBe('v0');
    expect(s2.ctx.records.get('tasks', rec.id)?.title).toBe('v0');
  });
});

describe('upgrade and old clients', () => {
  it('first contact after the upgrade adopts the epoch and keeps local data and edits', async () => {
    const s = await server();
    const c = client(s);
    const rec = await c.local.put('tasks', task('v0'));
    await sync(c);
    // An existing device from before epochs: it knows the serverId but no epoch.
    await c.local.db.table('_meta').delete('epoch');
    await c.engine.stop();
    await c.local.patch('tasks', rec.id, { notes: 'offline before the upgrade' });
    const other = await c.local.put('tasks', task('new before the upgrade'));

    await sync(c);
    expect(await c.local.knownEpoch()).toBe(serverEpoch(s));
    expect(await c.local.restoreNotice()).toBeNull();
    expect(await c.local.setAsideChanges()).toEqual([]);
    expect(s.ctx.records.get('tasks', rec.id)?.notes).toBe('offline before the upgrade');
    expect(s.ctx.records.get('tasks', other.id)?.title).toBe('new before the upgrade');
  });

  it('first contact after the upgrade on a server whose seq went backwards is a restore', async () => {
    const s1 = await server();
    const c = client(s1);
    const rec = await c.local.put('tasks', task('v0'));
    await sync(c);
    const backup = await backupServer(s1);
    await c.local.patch('tasks', rec.id, { title: 'v1' });
    await sync(c);
    await c.local.db.table('_meta').delete('epoch');
    const s2 = await restore(backup);
    await reconnect(c, s2);
    expect((await c.local.get('tasks', rec.id))?.title).toBe('v0');
    expect(s2.ctx.records.get('tasks', rec.id)?.title).toBe('v0');
  });

  it("an old client's push (no epoch) is rejected with stale_epoch and applies nothing", async () => {
    const s = await server();
    // A valid change from a client store, so only the missing epoch is wrong.
    const old = client(s);
    const rec = await old.local.put('tasks', task('from an old tab'));
    const entry = (await outbox(old))[0]!;
    const change: RecordChange = {
      collection: 'tasks',
      id: rec.id,
      createdAt: rec.createdAt,
      fields: entry.fields,
    };
    const res = await s.app.request('/api/sync/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: await old.local.clientId(), changes: [change] }),
    });
    expect(res.status).toBe(409);
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe(ERROR_CODES.staleEpoch);
    expect(s.ctx.records.get('tasks', rec.id)).toBeUndefined();
    expect(s.ctx.records.maxSeq()).toBe(0);
  });
});

describe('reset mechanics', () => {
  it('the reset is atomic: a failure halfway changes nothing and the next sync completes it', async () => {
    const s1 = await server();
    const c = client(s1);
    const rec = await c.local.put('tasks', task('v0'));
    await sync(c);
    const backup = await backupServer(s1);
    await c.local.remove('tasks', rec.id);
    await sync(c);
    c.online = false;
    await c.local.put('tasks', task('pending'));
    const s2 = await restore(backup);

    for (const failAfter of [0, 3]) {
      await expect(
        c.local.resetForRestore({
          serverId: s2.ctx.records.serverId(),
          epoch: serverEpoch(s2),
          _failAfter: failAfter,
        }),
      ).rejects.toThrow('injected');
      expect(await c.local.knownEpoch()).toBe(serverEpoch(s1));
      expect(await c.local.cursor()).toBeGreaterThan(0);
      expect(await outbox(c)).toHaveLength(1);
      expect(await c.local.get('tasks', rec.id, { includeDeleted: true })).toMatchObject({
        deleted: true,
      });
      expect(await c.local.setAsideChanges()).toEqual([]);
      expect(await c.local.restoreNotice()).toBeNull();
      expect(await c.local.storedGeneration()).toBe(0);
    }

    c.online = true;
    await reconnect(c, s2);
    expect(await c.local.get('tasks', rec.id)).toMatchObject({ deleted: false });
    expect(await outbox(c)).toEqual([]);
    expect((await c.local.restoreNotice())?.setAside).toBe(1);
    expect(s2.ctx.records.list('tasks')).toHaveLength(1);
  });

  it('a pull interrupted after the reset resumes from where it stopped', async () => {
    const s1 = await server();
    const c = createTestClient(s1, { pullLimit: 1 });
    cleanups.push(() => c.close());
    for (let i = 0; i < 4; i++) await c.local.put('tasks', task(`t${i}`));
    await sync(c);
    const backup = await backupServer(s1);
    const s2 = await restore(backup);
    c.server = s2;
    c.failNext.pull = 1;
    c.failNext.afterServer = false;
    // The probe resets, then pages are pulled one at a time; fail one pull mid-way.
    c.sse!.onHello({ serverId: s2.ctx.records.serverId(), maxSeq: 4 });
    await c.engine.syncNow().catch(() => undefined);
    await c.engine.stop();
    await sync(c);
    expect(await c.local.list('tasks')).toHaveLength(4);
    expect(await c.local.cursor()).toBe(s2.ctx.records.maxSeq());
    expect((await c.local.restoreNotice())?.setAside).toBe(0);
  });

  it('per-device cleanup interrupted by a crash runs on the next start', async () => {
    const s1 = await server();
    const c = client(s1);
    await c.local.put('tasks', task('x'));
    await sync(c);
    const backup = await backupServer(s1);
    const s2 = await restore(backup);
    // The tab dies right after the reset transaction commits (listeners never run).
    (c.local as unknown as { acknowledgeGeneration: () => Promise<void> }).acknowledgeGeneration =
      async () => {};
    await reconnect(c, s2);
    expect(await c.local.db.table('_meta').get('resetCleanup')).toBeDefined();

    // Next start: a fresh store on the same database, listeners registered at module load.
    const next = new LocalStore(c.local.db);
    const events: DataResetEvent[] = [];
    next.onReset((e) => events.push(e));
    await next.acknowledgeGeneration();
    expect(events).toEqual([{ generation: 1, reason: 'restore' }]);
    expect(await c.local.db.table('_meta').get('resetCleanup')).toBeUndefined();
    await next.acknowledgeGeneration();
    expect(events).toHaveLength(1);
  });

  it('other tabs: writes from state loaded before the reset are rejected until the tab catches up', async () => {
    const s1 = await server();
    const c = client(s1);
    const rec = await c.local.put('tasks', task('v0'));
    await sync(c);
    // A second tab on the same IndexedDB database.
    const tab2 = new LocalStore(c.local.db, { now: () => T0 });
    await tab2.acknowledgeGeneration();
    const tab2Events: DataResetEvent[] = [];
    tab2.onReset((e) => tab2Events.push(e));

    const backup = await backupServer(s1);
    const s2 = await restore(backup);
    await reconnect(c, s2); // the leader tab resets

    // Tab 2's open editor saves its stale text: refused, and tab 2 runs its reset listeners.
    const err = await tab2.patch('tasks', rec.id, { title: 'stale' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DataError);
    expect((err as DataError).code).toBe('stale');
    await tab2.acknowledgeGeneration();
    expect(tab2Events).toEqual([{ generation: 1, reason: 'restore' }]);
    expect((await c.local.get('tasks', rec.id))?.title).toBe('v0');
    expect(await outbox(c)).toEqual([]);

    // Caught up: new edits are accepted and sync.
    await tab2.patch('tasks', rec.id, { title: 'after' });
    await sync(c);
    expect(s2.ctx.records.get('tasks', rec.id)?.title).toBe('after');
  });

  it('sign-out clear() also bumps the generation (stale tabs cannot write into the empty store)', async () => {
    const c = client(await server());
    await c.local.put('tasks', task('x'));
    const tab2 = new LocalStore(c.local.db);
    await tab2.acknowledgeGeneration();
    await c.local.clear();
    expect(await c.local.storedGeneration()).toBe(1);
    await expect(tab2.put('tasks', task('stale'))).rejects.toMatchObject({ code: 'stale' });
    await c.local.put('tasks', task('fresh')); // the clearing tab itself is caught up
    expect(await c.local.list('tasks')).toHaveLength(1);
  });

  it('caps the set-aside store, newest first', () => {
    const change = (i: number): RecordChange => ({
      collection: 'tasks',
      id: `id${i}`,
      createdAt: new Date(T0).toISOString(),
      fields: { title: { value: `t${i}`, hlc: 'x' as never } },
    });
    const batch = (from: number, n: number): SetAsideBatch => ({
      at: new Date(T0 + from).toISOString(),
      serverId: null,
      fromEpoch: null,
      toEpoch: null,
      changes: Array.from({ length: n }, (_, i) => change(from + i)),
    });
    const { kept, dropped } = capSetAside([batch(0, 3000), batch(10_000, 3000)]);
    expect(dropped).toBe(6000 - MAX_SET_ASIDE_CHANGES);
    expect(kept.reduce((n, b) => n + b.changes.length, 0)).toBe(MAX_SET_ASIDE_CHANGES);
    expect(kept.at(-1)!.changes).toHaveLength(3000); // the newest batch is kept whole
  });
});
