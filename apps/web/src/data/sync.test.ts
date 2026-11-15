import 'fake-indexeddb/auto';
import {
  MAX_CLOCK_DRIFT_MS,
  compareBySortKey,
  mergeRecord,
  newId,
  type RecordOf,
  type SyncRecord,
} from '@webfront/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { OUTBOX, REJECTED, type OutboxEntry } from './db';
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

const T0 = Date.parse('2026-11-14T10:00:00.000Z');

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function server(): Promise<TestServer> {
  const s = await createTestServer({ now: T0 });
  cleanups.push(() => s.close());
  return s;
}

function client(s: TestServer, opts: Parameters<typeof createTestClient>[1] = {}): TestClient {
  const c = createTestClient(s, opts);
  cleanups.push(() => c.close());
  return c;
}

const outbox = (c: TestClient) => c.local.db.table(OUTBOX).toArray() as Promise<OutboxEntry[]>;
const task = (title: string, sortKey = 'a0') => ({ title, sortKey });

/** Everything a replica holds for a collection, comparable across replicas. */
async function snapshot(c: TestClient, collection: 'tasks' | 'postits' = 'tasks') {
  const rows = await c.local.list(collection, { includeDeleted: true });
  return rows
    .map((r) => ({ ...r }) as Record<string, unknown>)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function serverSnapshot(s: TestServer, collection: 'tasks' | 'postits' = 'tasks') {
  return s.ctx.records
    .list(collection, { includeDeleted: true })
    .map((r) => ({ ...r }) as Record<string, unknown>)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

describe('local writes', () => {
  it('stores the record and its outbox entry together, with per-field HLC stamps', async () => {
    const c = client(await server());
    const rec = await c.local.put('tasks', task('  Buy milk  '));
    expect(rec.title).toBe('Buy milk'); // normalised by the shared schema
    expect(rec.notes).toBe(''); // default filled
    expect(rec.deleted).toBe(false);
    const stored = await c.local.get('tasks', rec.id);
    expect(stored).toEqual(rec);
    const ob = await outbox(c);
    expect(ob).toHaveLength(1);
    expect(ob[0]).toMatchObject({ collection: 'tasks', id: rec.id, createdAt: rec.createdAt });
    expect(Object.keys(ob[0]!.fields).sort()).toEqual(
      [
        'completedAt',
        'completionCount',
        'deleted',
        'dueDate',
        'lastCompletedAt',
        'notes',
        'repeat',
        'sortKey',
        'title',
      ].sort(),
    );
    for (const [k, fc] of Object.entries(ob[0]!.fields)) {
      expect(fc.hlc).toBe(rec.clocks[k]);
    }
  });

  it('rejects invalid writes without touching the record or outbox', async () => {
    const c = client(await server());
    await expect(c.local.put('tasks', { title: '', sortKey: 'a0' })).rejects.toThrow();
    const rec = await c.local.put('tasks', task('ok'));
    await expect(c.local.patch('tasks', rec.id, { dueDate: 'tomorrow' })).rejects.toThrow();
    await expect(
      c.local.patch('tasks', rec.id, { bogus: 1 } as unknown as Partial<RecordOf<'tasks'>>),
    ).rejects.toThrow(/not a writable field/);
    await expect(c.local.patch('tasks', newId(), { title: 'x' })).rejects.toThrow(/not found/);
    await expect(
      c.local.put('serviceStatuses', { bookmarkId: newId() }, { id: newId() }),
    ).rejects.toThrow(/read-only/);
    await expect(c.local.put('settings', { value: 1 })).rejects.toThrow(/explicit id/);
    expect(await c.local.get('tasks', rec.id)).toEqual(rec);
    expect(await outbox(c)).toHaveLength(1);
  });

  it('transaction() commits all writes or none', async () => {
    const c = client(await server());
    await expect(
      c.local.transaction(async () => {
        await c.local.put('tasks', task('one'));
        await c.local.put('tasks', task('two'));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await c.local.list('tasks')).toEqual([]);
    expect(await outbox(c)).toEqual([]);

    await c.local.transaction(async () => {
      const a = await c.local.put('tasks', task('one'));
      await c.local.patch('tasks', a.id, { notes: 'n' });
      await c.local.put('postits', { text: 'hi', sortKey: 'a0' });
    });
    expect(await c.local.list('tasks')).toHaveLength(1);
    expect(await outbox(c)).toHaveLength(2);
  });

  it('coalesces repeated edits per field and skips no-op writes', async () => {
    const c = client(await server());
    const rec = await c.local.put('tasks', task('v0'));
    await c.local.patch('tasks', rec.id, { title: 'v1' });
    await c.local.patch('tasks', rec.id, { title: 'v2', notes: 'n' });
    const before = await outbox(c);
    await c.local.patch('tasks', rec.id, { title: 'v2' }); // unchanged: no new stamp
    const ob = await outbox(c);
    expect(ob).toEqual(before);
    expect(ob).toHaveLength(1);
    expect(ob[0]!.fields.title!.value).toBe('v2');
    const now = (await c.local.get('tasks', rec.id))!;
    expect(ob[0]!.fields.title!.hlc).toBe(now.clocks.title);
    expect(ob[0]!.fields.notes!.hlc).toBe(now.clocks.title); // same write
    expect(now.clocks.sortKey! < now.clocks.title!).toBe(true); // untouched field kept its stamp
  });

  it('stamps are strictly increasing even when the wall clock goes backwards', async () => {
    const c = client(await server());
    const rec = await c.local.put('tasks', task('v0'));
    c.now -= 60_000;
    const after = await c.local.patch('tasks', rec.id, { title: 'v1' });
    expect(after.clocks.title! > rec.clocks.title!).toBe(true);
  });

  it('remove/restore toggle the clocked tombstone; reads hide deleted records', async () => {
    const c = client(await server());
    const a = await c.local.put('tasks', task('a', 'a1'));
    const b = await c.local.put('tasks', task('b', 'a0'));
    await c.local.remove('tasks', a.id);
    expect(await c.local.get('tasks', a.id)).toBeUndefined();
    expect((await c.local.get('tasks', a.id, { includeDeleted: true }))?.deleted).toBe(true);
    expect((await c.local.list('tasks')).map((r) => r.id)).toEqual([b.id]);
    expect(await c.local.list('tasks', { includeDeleted: true })).toHaveLength(2);
    await c.local.restore('tasks', a.id);
    const sorted = await c.local.list('tasks', { sort: compareBySortKey });
    expect(sorted.map((r) => r.title)).toEqual(['b', 'a']);
    // put() on a tombstone revives it
    await c.local.remove('tasks', b.id);
    await c.local.put('tasks', task('b2'), { id: b.id });
    expect((await c.local.get('tasks', b.id))?.title).toBe('b2');
  });

  it('list supports indexed and in-memory where, filter, sort and limit', async () => {
    const c = client(await server());
    const l1 = await c.local.put('shoppingLists', { name: 'L1', sortKey: 'a0' });
    const l2 = await c.local.put('shoppingLists', { name: 'L2', sortKey: 'a1' });
    for (const [i, name] of ['milk', 'eggs', 'bread'].entries()) {
      await c.local.put('shoppingItems', { listId: l1.id, name, sortKey: `a${i}` });
    }
    await c.local.put('shoppingItems', { listId: l2.id, name: 'milk', sortKey: 'a0' });
    const items = await c.local.list('shoppingItems', {
      where: { listId: l1.id },
      sort: compareBySortKey,
    });
    expect(items.map((i) => i.name)).toEqual(['milk', 'eggs', 'bread']);
    const milk = await c.local.list('shoppingItems', { where: { name: 'milk', checked: false } });
    expect(milk).toHaveLength(2);
    const limited = await c.local.list('shoppingItems', {
      filter: (i) => i.name !== 'eggs',
      sort: (a, b) => a.name.localeCompare(b.name),
      limit: 2,
    });
    expect(limited.map((i) => i.name)).toEqual(['bread', 'milk']);
    const nulls = await c.local.list('wikiPages', { where: { parentId: null } });
    expect(nulls).toEqual([]);
  });
});

describe('push', () => {
  it('pushes the outbox, empties it on ack, and is idempotent when a response is lost', async () => {
    const s = await server();
    const c = client(s);
    await sync(c); // initial cycle (identity check)
    const rec = await c.local.put('tasks', task('one'));
    c.failNext = { push: 1, pull: 0, afterServer: true }; // server applies, response lost
    await sync(c);
    expect(c.engine.currentStatus.state).toBe('offline');
    expect(await outbox(c)).toHaveLength(1);
    expect(s.ctx.records.get('tasks', rec.id)?.title).toBe('one');
    const seqAfterFirst = s.ctx.records.maxSeq();

    await sync(c);
    expect(c.engine.currentStatus.state).toBe('idle');
    expect(await outbox(c)).toHaveLength(0);
    expect(s.ctx.records.maxSeq()).toBe(seqAfterFirst); // replay was "unchanged"
  });

  it('keeps edits made while a push is in flight', async () => {
    const s = await server();
    const c = client(s);
    const rec = await c.local.put('tasks', task('v1'));
    // Intercept the push: make a local edit after the request was built but before the ack.
    const realPush = s.app.request.bind(s.app);
    let edited = false;
    s.app.request = (async (input: string, init?: RequestInit) => {
      const res = await realPush(input, init);
      if (input.includes('/push') && !edited && String(init?.body).includes(rec.id)) {
        edited = true;
        await c.local.patch('tasks', rec.id, { title: 'v2' });
      }
      return res;
    }) as typeof s.app.request;
    await sync(c);
    s.app.request = realPush;
    // The cycle notices the remaining entry and pushes again in the same syncNow.
    expect(await outbox(c)).toHaveLength(0);
    expect(s.ctx.records.get('tasks', rec.id)?.title).toBe('v2');
  });

  it('batches large outboxes', async () => {
    const s = await server();
    const c = client(s, { pushMaxChanges: 3 });
    for (let i = 0; i < 8; i++) await c.local.put('tasks', task(`t${i}`));
    await sync(c);
    expect(c.calls.push).toBe(1 + 3); // identity check on start, then three batches
    expect(s.ctx.records.list('tasks')).toHaveLength(8);
    expect(await outbox(c)).toHaveLength(0);
  });

  it('records rejected changes, surfaces a count and does not block the queue', async () => {
    const s = await server();
    const c = client(s);
    c.now = T0 + MAX_CLOCK_DRIFT_MS + 60_000; // this device's clock is far ahead
    const bad = await c.local.put('tasks', task('from the future'));
    c.now = T0;
    // A fresh client with a sane clock would be accepted; same device keeps stamping ahead
    // (HLC never goes back), so only the first write is the problem. Use another record type:
    const good = await c.local.put('postits', { text: 'fine', sortKey: 'a0' });
    expect(good.clocks.text! > bad.clocks.title!).toBe(true);
    await sync(c);
    const status = await c.local.readStatus();
    expect(status.rejectedChanges).toBe(2); // both carry stamps beyond the drift limit
    expect(status.pendingChanges).toBe(0);
    const rejected = await c.local.db.table(REJECTED).toArray();
    expect(rejected[0]).toMatchObject({ collection: 'tasks', id: bad.id, code: 'clock_drift' });
    expect(status.state).toBe('idle');

    // Once the server clock catches up, new writes go through.
    s.now = T0 + MAX_CLOCK_DRIFT_MS + 120_000;
    const later = await c.local.put('tasks', task('later'));
    await sync(c);
    expect(s.ctx.records.get('tasks', later.id)?.title).toBe('later');
  });
});

describe('pull', () => {
  it('merges remote records and keeps newer pending local edits', async () => {
    const s = await server();
    const a = client(s, { name: 'A' });
    const b = client(s, { name: 'B' });
    const rec = await a.local.put('tasks', task('v0'));
    await sync(a);
    await sync(b);
    expect((await b.local.get('tasks', rec.id))?.title).toBe('v0');

    // B edits notes and syncs; A (offline) edits title afterwards.
    b.now += 1000;
    await b.local.patch('tasks', rec.id, { notes: 'from B' });
    await sync(b);
    a.now += 2000;
    await a.local.patch('tasks', rec.id, { title: 'from A' });

    // A pulls before pushing (push fails): its pending title survives, B's notes arrive.
    a.failNext = { push: 1, pull: 0, afterServer: false };
    await sync(a); // push fails -> cycle aborts before pull
    await a.local.applyPull(await pullFrom(s, await a.local.cursor()));
    const merged = (await a.local.get('tasks', rec.id))!;
    expect(merged.title).toBe('from A');
    expect(merged.notes).toBe('from B');
    expect((await outbox(a))[0]?.fields.title?.value).toBe('from A');

    await sync(a);
    await sync(b);
    expect(await snapshot(a)).toEqual(await snapshot(b));
    expect(serverSnapshot(s)).toEqual(await snapshot(a));
  });

  it('drops queued writes that lost to a newer remote write', async () => {
    const s = await server();
    const a = client(s, { name: 'A' });
    const b = client(s, { name: 'B' });
    const rec = await a.local.put('tasks', task('v0'));
    await sync(a);
    await sync(b);
    await a.local.patch('tasks', rec.id, { title: 'older from A' });
    b.now += 5000;
    await b.local.patch('tasks', rec.id, { title: 'newer from B' });
    await sync(b);
    await a.local.applyPull(await pullFrom(s, await a.local.cursor()));
    expect((await a.local.get('tasks', rec.id))?.title).toBe('newer from B');
    expect(await outbox(a)).toEqual([]);
  });

  it('resumes from the last durable page after a failure mid-pull', async () => {
    const s = await server();
    const a = client(s, { name: 'A' });
    for (let i = 0; i < 5; i++) await a.local.put('tasks', task(`t${i}`));
    await sync(a);

    const b = client(s, { name: 'B', pullLimit: 2 });
    b.failNext = { push: 0, pull: 1, afterServer: false };
    // First pull page succeeds, second fails: emulate by failing the 2nd call.
    let calls = 0;
    const real = s.app.request.bind(s.app);
    s.app.request = (async (input: string, init?: RequestInit) => {
      if (input.includes('/pull') && ++calls === 2) throw new TypeError('connection reset');
      return real(input, init);
    }) as typeof s.app.request;
    b.failNext.pull = 0;
    await sync(b);
    s.app.request = real;
    expect(b.engine.currentStatus.state).toBe('offline');
    expect(await b.local.cursor()).toBe(2);
    expect(await b.local.list('tasks')).toHaveLength(2);

    await sync(b);
    expect(await b.local.cursor()).toBe(5);
    expect(await b.local.list('tasks')).toHaveLength(5);
    expect(b.engine.currentStatus.state).toBe('idle');
  });

  it('skips invalid pulled records but still advances the cursor', async () => {
    const s = await server();
    const c = client(s);
    const id = newId();
    // Corrupt row written behind the store's back.
    s.ctx.db.run(
      `INSERT INTO records (collection, id, data, clocks, deleted, created_at, updated_at, seq)
       VALUES ('tasks', ?, '{"title":""}', '{}', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1)`,
      id,
    );
    s.ctx.db.run(`UPDATE meta SET value = '1' WHERE key = 'records_seq'`);
    await sync(c);
    expect(await c.local.cursor()).toBe(1);
    expect(await c.local.list('tasks')).toEqual([]);
  });

  it('applies server-owned records (read-only locally)', async () => {
    const s = await server();
    const c = client(s);
    const bm = newId();
    s.ctx.records.writeAsServer('serviceStatuses', [{ id: bm, fields: { bookmarkId: bm, state: 'up' } }]);
    await sync(c);
    expect((await c.local.get('serviceStatuses', bm))?.state).toBe('up');
    expect(await outbox(c)).toEqual([]);
  });
});

async function pullFrom(s: TestServer, since: number) {
  const { pullResponseSchema } = await import('@webfront/shared');
  const res = await s.app.request(`/api/sync/pull?since=${since}`);
  return pullResponseSchema.parse(await res.json());
}

describe('convergence', () => {
  it('two clients editing offline converge through the server', async () => {
    const s = await server();
    const a = client(s, { name: 'A' });
    const b = client(s, { name: 'B' });
    const seed = [];
    for (let i = 0; i < 6; i++) seed.push(await a.local.put('tasks', task(`t${i}`, `a${i}`)));
    await sync(a);
    await sync(b);

    a.online = false;
    b.online = false;
    // Deterministic pseudo-random interleaving of conflicting edits.
    let x = 42;
    const rnd = () => (x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let step = 0; step < 60; step++) {
      const c = rnd() < 0.5 ? a : b;
      c.now += Math.floor(rnd() * 1000);
      const target = seed[Math.floor(rnd() * seed.length)]!;
      const op = rnd();
      if (op < 0.4) await c.local.patch('tasks', target.id, { title: `${c.name}-${step}` });
      else if (op < 0.6) await c.local.patch('tasks', target.id, { notes: `${c.name} note ${step}` });
      else if (op < 0.75) await c.local.remove('tasks', target.id);
      else if (op < 0.9) await c.local.restore('tasks', target.id);
      else await c.local.put('tasks', task(`${c.name} new ${step}`));
      // Sometimes one side reconnects briefly mid-way.
      if (step === 30) {
        a.online = true;
        await sync(a);
        a.online = false;
      }
    }
    // Oracle: the merge of both replicas' local states is what everyone must end up with.
    const expected = new Map<string, Record<string, unknown>>();
    for (const r of [...(await snapshot(a)), ...(await snapshot(b))]) {
      const prev = expected.get(r.id as string);
      expected.set(
        r.id as string,
        prev ? mergeRecord(prev as unknown as SyncRecord, r as unknown as SyncRecord) : r,
      );
    }

    a.online = true;
    b.online = true;
    // B pushes first; A then pulls BEFORE pushing, so B's edits meet A's pending ones.
    await sync(b);
    const pendingA = (await outbox(a)).length;
    expect(pendingA).toBeGreaterThan(0);
    await a.local.applyPull(await pullFrom(s, await a.local.cursor()));
    await sync(a);
    await sync(b);

    expect(await outbox(a)).toEqual([]);
    expect(await outbox(b)).toEqual([]);
    const sa = await snapshot(a);
    expect(await snapshot(b)).toEqual(sa);
    expect(serverSnapshot(s)).toEqual(sa);
    const pick = (r: Record<string, unknown>) => {
      const { updatedAt: _u, ...rest } = r;
      return rest;
    };
    expect(sa.map(pick)).toEqual(
      [...expected.values()].sort((x, y) => String(x.id).localeCompare(String(y.id))).map(pick),
    );
  });

  it('runs field resolvers on pull and pushes the values they mint', async () => {
    const s = await server();
    const a = client(s, { name: 'A' });
    const b = client(s, { name: 'B' });
    const rec = await a.local.put('tasks', task('t'));
    await sync(a);
    await sync(b);
    // A concatenating resolver for `notes` on client A only.
    a.local.registerFieldResolvers('tasks', ({ tick }) => ({
      notes: ({ local, remote }) => {
        const parts = [String(local.value), String(remote.value)].filter(Boolean).sort();
        return { value: parts.join(' + '), hlc: tick() };
      },
    }));
    await a.local.patch('tasks', rec.id, { notes: 'mine' });
    b.now += 10;
    await b.local.patch('tasks', rec.id, { notes: 'theirs' });
    await sync(b);
    a.failNext = { push: 1, pull: 0, afterServer: false };
    await sync(a); // push fails: the merge happens on the next pull
    await a.local.applyPull(await pullFrom(s, await a.local.cursor()));
    expect((await a.local.get('tasks', rec.id))?.notes).toBe('mine + theirs');
    await sync(a);
    await sync(b);
    expect((await b.local.get('tasks', rec.id))?.notes).toBe('mine + theirs');
    expect(s.ctx.records.get('tasks', rec.id)?.notes).toBe('mine + theirs');
  });
});

describe('server identity and auth', () => {
  it('re-pushes everything into a different, EMPTY server database (fresh install)', async () => {
    const s1 = await server();
    const c = client(s1);
    const kept = await c.local.put('tasks', task('kept'));
    const del = await c.local.put('tasks', task('deleted'));
    await c.local.remove('tasks', del.id);
    const bm = newId();
    s1.ctx.records.writeAsServer('serviceStatuses', [{ id: bm, fields: { bookmarkId: bm } }]);
    await sync(c);
    expect(await c.local.cursor()).toBeGreaterThan(0);
    expect(await c.local.get('serviceStatuses', bm)).toBeDefined();

    const s2 = await server(); // a different, empty database
    c.server = s2;
    c.sse!.onHello({ serverId: s2.ctx.records.serverId(), maxSeq: 0 });
    await c.engine.syncNow();

    expect(c.engine.currentStatus.state).toBe('idle');
    expect(await c.local.knownServerId()).toBe(s2.ctx.records.serverId());
    expect(await c.local.knownEpoch()).toBe(serverEpoch(s2));
    expect(s2.ctx.records.get('tasks', kept.id)?.title).toBe('kept');
    expect(s2.ctx.records.get('tasks', del.id)?.deleted).toBe(true);
    // Server-owned data from the old server is gone.
    expect(await c.local.get('serviceStatuses', bm)).toBeUndefined();
    expect(await c.local.cursor()).toBe(s2.ctx.records.maxSeq());
    expect(await outbox(c)).toEqual([]);
    expect(await c.local.restoreNotice()).toBeNull();
  });

  it('treats a different, NON-empty server database like a restore: nothing local is pushed', async () => {
    const s1 = await server();
    const c = client(s1);
    const mine = await c.local.put('tasks', task('mine'));
    await sync(c);
    await c.local.patch('tasks', mine.id, { notes: 'unsynced' });

    const s2 = await server();
    const theirs = newId();
    s2.ctx.records.writeAsServer('serviceStatuses', [{ id: theirs, fields: { bookmarkId: theirs } }]);
    c.server = s2;
    c.sse!.onHello({ serverId: s2.ctx.records.serverId(), maxSeq: 1 });
    await c.engine.syncNow();

    expect(s2.ctx.records.get('tasks', mine.id)).toBeUndefined();
    expect(await c.local.get('tasks', mine.id, { includeDeleted: true })).toBeUndefined();
    expect(await c.local.get('serviceStatuses', theirs)).toBeDefined();
    expect((await c.local.restoreNotice())?.setAside).toBe(1);
    expect(c.pushes.filter((p) => p.changes > 0 && p.epoch === serverEpoch(s2))).toEqual([]);
  });

  it('notices a restore from the pull alone (nothing to push), before merging anything', async () => {
    const s1 = await server();
    const c = client(s1);
    const rec = await c.local.put('tasks', task('v0'));
    await sync(c);
    const backup = await backupServer(s1);
    await c.local.patch('tasks', rec.id, { title: 'v1' });
    await sync(c);
    const s2 = await restoreServer(backup, { now: T0 });
    cleanups.push(() => s2.close());
    c.server = s2;
    await sync(c); // no hello: the pull's epoch differs, so the cycle probes and resets
    expect((await c.local.get('tasks', rec.id))?.title).toBe('v0');
    expect(s2.ctx.records.get('tasks', rec.id)?.title).toBe('v0');
    expect(await c.local.cursor()).toBe(s2.ctx.records.maxSeq());
    expect(await c.local.knownEpoch()).toBe(serverEpoch(s2));
  });

  it('an SSE hello makes the next cycle probe the server', async () => {
    const s = await server();
    const c = client(s);
    await sync(c);
    const pushes = c.pushes.length;
    c.sse!.onHello({ serverId: s.ctx.records.serverId(), epoch: serverEpoch(s), maxSeq: 0 });
    await c.engine.syncNow();
    expect(c.pushes.slice(pushes)).toEqual([{ epoch: undefined, changes: 0 }]);
  });

  it('pokes from other clients trigger a sync; its own pokes do not', async () => {
    const s = await server();
    const c = client(s, { backstopMs: 3_600_000 });
    await sync(c);
    const pulls = c.calls.pull;
    c.sse!.onChanged({ maxSeq: 1, originClientId: await c.local.clientId() });
    await new Promise((r) => setTimeout(r, 20));
    expect(c.calls.pull).toBe(pulls);
    c.sse!.onChanged({ maxSeq: 1, originClientId: 'ffffffffffffffff' });
    await new Promise((r) => setTimeout(r, 20));
    expect(c.calls.pull).toBe(pulls + 1);
  });

  it('on 401 stops syncing, keeps local data and outbox, and resumes after start()', async () => {
    const s = await server();
    const c = client(s);
    const rec = await c.local.put('tasks', task('offline edit'));
    s.authed = false;
    await sync(c);
    expect(c.engine.isRunning).toBe(false);
    const status = await c.local.readStatus();
    expect(status.state).toBe('unauthenticated');
    expect(status.pendingChanges).toBe(1);
    expect(await c.local.get('tasks', rec.id)).toBeDefined();
    // Writes still work while signed out.
    await c.local.patch('tasks', rec.id, { notes: 'more' });
    const pushesBefore = c.calls.push;
    c.engine.trigger('write');
    await new Promise((r) => setTimeout(r, 10));
    expect(c.calls.push).toBe(pushesBefore); // halted: no retries

    s.authed = true;
    await sync(c);
    expect((await c.local.readStatus()).state).toBe('idle');
    expect(s.ctx.records.get('tasks', rec.id)).toMatchObject({ title: 'offline edit', notes: 'more' });
  });

  it('reports offline on network errors and backs off exponentially with jitter', async () => {
    const s = await server();
    const c = client(s, { backoffBaseMs: 1000, backoffMaxMs: 8000, random: () => 1 });
    await c.local.put('tasks', task('x'));
    c.online = false;
    await sync(c);
    expect((await c.local.readStatus()).state).toBe('offline');
    const engine = c.engine as unknown as { failures: number; backoffDelay(): number };
    const delays = [];
    for (let f = 1; f <= 6; f++) {
      engine.failures = f;
      delays.push(engine.backoffDelay());
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
    c.online = true;
    await sync(c);
    expect((await c.local.readStatus()).state).toBe('idle');
  });
});

describe('clear', () => {
  it('clearLocalData-style clear removes records, outbox and metadata', async () => {
    const c = client(await server());
    await c.local.put('tasks', task('x'));
    const id1 = await c.local.clientId();
    await c.local.clear();
    expect(await c.local.list('tasks', { includeDeleted: true })).toEqual([]);
    expect(await outbox(c)).toEqual([]);
    expect(await c.local.cursor()).toBe(0);
    expect(await c.local.clientId()).not.toBe(id1);
  });
});

describe('record resolver (wiki-style three-way merge)', () => {
  type Args = import('./local').RecordResolverArgs<'wikiPages'>;

  async function setupPage() {
    const s = await server();
    const a = client(s, { name: 'A' });
    const b = client(s, { name: 'B' });
    const page = await a.local.put('wikiPages', { title: 'Page', slug: 'page', sortKey: 'a0', body: 'base' });
    await sync(a);
    await sync(b);
    const calls: Args[] = [];
    const rev = newId();
    a.local.registerRecordResolver('wikiPages', (args) => {
      calls.push(args);
      const bodies = [String(args.pendingFields.body?.value), args.remote.body].sort();
      return { body: bodies.join(' | '), baseRevisionId: rev, conflict: null };
    });
    /** A pulls before pushing (its push fails), so its pending edits meet the remote ones. */
    const pullFirst = async () => {
      a.failNext = { push: 1, pull: 0, afterServer: false };
      await sync(a);
      await a.local.applyPull(await pullFrom(s, await a.local.cursor()));
    };
    return { s, a, b, page, calls, rev, pullFirst };
  }

  it('fires when remote edits a pending field and won; result is stamped, stored and pushed atomically', async () => {
    const { s, a, b, page, calls, rev, pullFirst } = await setupPage();
    await a.local.patch('wikiPages', page.id, { body: 'A edit' });
    b.now += 5000;
    await b.local.patch('wikiPages', page.id, { body: 'B edit' });
    await sync(b);
    await pullFirst();

    expect(calls).toHaveLength(1);
    const args = calls[0]!;
    expect(args.conflictFields).toEqual(['body']);
    expect(args.merged.body).toBe('B edit'); // remote won LWW
    expect(args.local.body).toBe('A edit');
    expect(args.pendingFields.body?.value).toBe('A edit');

    const local = (await a.local.get('wikiPages', page.id))!;
    expect(local).toMatchObject({ body: 'A edit | B edit', baseRevisionId: rev, conflict: null });
    const remoteBodyClock = s.ctx.records.get('wikiPages', page.id)!.clocks.body!;
    expect(local.clocks.body! > remoteBodyClock).toBe(true);
    expect(local.clocks.baseRevisionId).toBe(local.clocks.body); // one stamp for the whole result
    const [entry] = await outbox(a);
    expect(entry?.fields.body).toEqual({ value: 'A edit | B edit', hlc: local.clocks.body });
    expect(entry?.fields.baseRevisionId).toEqual({ value: rev, hlc: local.clocks.body });

    await sync(a);
    await sync(b);
    for (const rec of [s.ctx.records.get('wikiPages', page.id), await b.local.get('wikiPages', page.id)]) {
      expect(rec).toMatchObject({ body: 'A edit | B edit', baseRevisionId: rev });
    }
    // Pulling the echo of the merged result does not fire again.
    expect(calls).toHaveLength(1);
  });

  it('also fires when the local pending edit won LWW', async () => {
    const { a, b, page, calls, pullFirst } = await setupPage();
    await b.local.patch('wikiPages', page.id, { body: 'B edit' });
    await sync(b);
    a.now += 5000;
    await a.local.patch('wikiPages', page.id, { body: 'A edit' });
    await pullFirst();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.merged.body).toBe('A edit');
    expect((await a.local.get('wikiPages', page.id))?.body).toBe('A edit | B edit');
  });

  it('does not fire without pending edits, for other fields, or for echoes of its own writes', async () => {
    const { s, a, b, page, calls, pullFirst } = await setupPage();
    // No pending edits on A: remote simply wins.
    await b.local.patch('wikiPages', page.id, { body: 'B1' });
    await sync(b);
    await sync(a);
    expect((await a.local.get('wikiPages', page.id))?.body).toBe('B1');

    // Remote changes a different field than the pending one.
    await a.local.patch('wikiPages', page.id, { body: 'A pending' });
    b.now += 1000;
    await b.local.patch('wikiPages', page.id, { title: 'Renamed by B' });
    await sync(b);
    await pullFirst();
    expect((await a.local.get('wikiPages', page.id))).toMatchObject({
      body: 'A pending',
      title: 'Renamed by B',
    });

    // Echo of A's own earlier write while a newer local edit is pending (response was lost).
    a.failNext = { push: 1, pull: 0, afterServer: true };
    await sync(a); // server stored "A pending", A did not get the ack
    await a.local.patch('wikiPages', page.id, { body: 'A newer' });
    await a.local.applyPull(await pullFrom(s, await a.local.cursor()));
    expect((await a.local.get('wikiPages', page.id))?.body).toBe('A newer');

    expect(calls).toHaveLength(0);
    await sync(a);
    expect(s.ctx.records.get('wikiPages', page.id)?.body).toBe('A newer');
  });

  it('ignores invalid resolver output and still applies the pull', async () => {
    const { a, b, page, pullFirst } = await setupPage();
    a.local.registerRecordResolver('wikiPages', () => ({ slug: 'Not A Slug!' }));
    await a.local.patch('wikiPages', page.id, { body: 'A edit' });
    b.now += 5000;
    await b.local.patch('wikiPages', page.id, { body: 'B edit' });
    await sync(b);
    await pullFirst();
    const local = (await a.local.get('wikiPages', page.id))!;
    expect(local).toMatchObject({ body: 'B edit', slug: 'page' });
    expect(await a.local.cursor()).toBe(b.server.ctx.records.maxSeq());
    expect(await outbox(a)).toEqual([]); // A's losing body edit was dropped as usual
  });
});

describe('unknown collections in a pull', () => {
  it('skips records of collections this client does not know and still advances the cursor', async () => {
    const { pullResponseSchema } = await import('@webfront/shared');
    const c = client(await server());
    const id = newId();
    const at = '2026-11-14T10:00:00.000Z';
    const stamp = `${at}-0000-aaaaaaaaaaaaaaaa`;
    const page = pullResponseSchema.parse({
      serverId: 'x',
      cursor: 2,
      hasMore: false,
      records: [
        {
          collection: 'futureThings',
          seq: 1,
          record: { id: 'whatever', createdAt: at, updatedAt: at, deleted: false, clocks: {}, foo: 1 },
        },
        {
          collection: 'tasks',
          seq: 2,
          record: {
            id,
            createdAt: at,
            updatedAt: at,
            deleted: false,
            clocks: { title: stamp, sortKey: stamp, deleted: stamp },
            title: 'known',
            sortKey: 'a0',
          },
        },
      ],
    });
    const res = await c.local.applyPull(page);
    expect(res).toMatchObject({ unknown: 1, invalid: 0, changed: 1 });
    expect(await c.local.cursor()).toBe(2);
    expect((await c.local.get('tasks', id))?.title).toBe('known');
  });
});
