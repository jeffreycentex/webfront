import 'fake-indexeddb/auto';
import { newId, pullResponseSchema, type RecordOf } from '@webfront/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestClient,
  createTestServer,
  sync,
  type TestClient,
  type TestServer,
} from '../../../data/test/harness';
import {
  CONFLICT_BASE_PREFIX,
  acceptedState,
  createMemoryStore,
  createWikiResolver,
  decideBody,
  planLocalSave,
  reconcilePage,
  resolveConflict,
  saveBody,
  type BodyStateStore,
  type PendingSnapshot,
  type ReconcileIO,
} from './bodySync';
import { hashText } from './text';

/**
 * End-to-end tests of the wiki body merge over the REAL sync engine and server (see
 * `data/test/harness.ts`): two replicas edit the same page offline and must converge without
 * losing text, by either the record resolver (pull meets a pending edit) or the reconciler
 * (pull replaced an already-pushed body).
 */

const T0 = Date.parse('2026-11-14T10:00:00.000Z');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

interface Replica {
  c: TestClient;
  store: BodyStateStore;
  io: ReconcileIO;
  snaps: PendingSnapshot[];
  resolverCalls: number;
}

function replica(s: TestServer, name: string): Replica {
  const c = createTestClient(s, { name });
  cleanups.push(() => c.close());
  const store = createMemoryStore();
  const r: Replica = {
    c,
    store,
    snaps: [],
    resolverCalls: 0,
    io: {
      get: (id) => c.local.get('wikiPages', id),
      patch: (id, changes) => c.local.patch('wikiPages', id, changes),
      snapshot: (snap) =>
        c.local.put(
          'wikiRevisions',
          { pageId: snap.pageId, title: snap.title, body: snap.body },
          { id: snap.id },
        ),
      transaction: (fn) => c.local.transaction(fn),
      newId: () => newId(c.now),
      now: () => c.now,
    },
  };
  const resolve = createWikiResolver({
    store,
    now: () => c.now,
    newId: () => newId(c.now),
    onSnapshots: (snaps) => r.snaps.push(...snaps),
  });
  c.local.registerRecordResolver('wikiPages', (args) => {
    r.resolverCalls++;
    return resolve(args);
  });
  return r;
}

async function page(r: Replica, id: string): Promise<RecordOf<'wikiPages'>> {
  const p = await r.c.local.get('wikiPages', id);
  if (!p) throw new Error('missing page');
  return p;
}

/** Simulate the editor: save `text` derived from the page's current body. */
async function edit(r: Replica, id: string, text: string) {
  const cur = await page(r, id);
  return saveBody(r.io, r.store, id, text, cur.body);
}

/** One full round: sync, reconcile (as the app's background reconciler does), sync again. */
async function settle(...rs: Replica[]) {
  for (let i = 0; i < 3; i++) {
    for (const r of rs) {
      await sync(r.c);
      for (const id of r.store.keys()) await reconcilePage(r.io, r.store, id);
      await sync(r.c);
    }
  }
}

async function setup(body: string) {
  const s = await createTestServer({ now: T0 });
  cleanups.push(() => s.close());
  const a = replica(s, 'A');
  const b = replica(s, 'B');
  const p = await a.c.local.put('wikiPages', {
    title: 'Page',
    slug: 'page',
    sortKey: 'a0',
    body: '',
  });
  await edit(a, p.id, body);
  await settle(a, b);
  expect((await page(b, p.id)).body).toBe(body);
  return { s, a, b, id: p.id };
}

const L = (...lines: string[]) => lines.join('\n');
const BASE = L('# Title', '', 'alpha', 'beta', 'gamma', 'delta', 'epsilon');

async function expectConverged(s: TestServer, a: Replica, b: Replica, id: string) {
  const pa = await page(a, id);
  const pb = await page(b, id);
  const ps = s.ctx.records.get('wikiPages', id)!;
  expect(pa.body).toBe(pb.body);
  expect(ps.body).toBe(pa.body);
  expect(pa.conflict).toEqual(pb.conflict);
  return pa;
}

describe('wiki body merge over the sync engine', () => {
  for (const newer of ['A', 'B'] as const) {
    it(`non-overlapping offline edits merge cleanly when ${newer} has the newer stamp (push-first path)`, async () => {
      const { s, a, b, id } = await setup(BASE);
      a.c.online = false;
      b.c.online = false;
      await edit(a, id, BASE.replace('alpha', 'ALPHA (from A)'));
      await edit(b, id, BASE.replace('epsilon', 'EPSILON (from B)'));
      if (newer === 'A') a.c.now += 10_000;
      else b.c.now += 10_000;
      a.c.online = true;
      b.c.online = true;
      // A comes back first: its push lands before it ever sees B's edit.
      await settle(a, b);
      const merged = await expectConverged(s, a, b, id);
      expect(merged.body).toBe(
        L('# Title', '', 'ALPHA (from A)', 'beta', 'gamma', 'delta', 'EPSILON (from B)'),
      );
      expect(merged.conflict).toBeNull();
    });
  }

  it('the record resolver merges when a pull meets a pending edit', async () => {
    const { s, a, b, id } = await setup(BASE);
    await edit(a, id, BASE.replace('beta', 'BETA (A)'));
    b.c.now += 5000;
    await edit(b, id, BASE.replace('delta', 'DELTA (B)'));
    await sync(b.c);
    // A pulls before its push gets through.
    a.c.failNext = { push: 1, pull: 0, afterServer: false };
    await sync(a.c);
    const res = await s.app.request(`/api/sync/pull?since=${await a.c.local.cursor()}`);
    await a.c.local.applyPull(pullResponseSchema.parse(await res.json()));
    expect(a.resolverCalls).toBe(1);
    const local = await page(a, id);
    expect(local.body).toBe(BASE.replace('beta', 'BETA (A)').replace('delta', 'DELTA (B)'));
    // baseRevisionId moved forward to the merged snapshot, queued for writing after the pull.
    const mergedSnap = a.snaps.find((x) => x.label === 'merged');
    expect(local.baseRevisionId).toBe(mergedSnap?.id);
    expect(a.snaps.find((x) => x.label === 'mine')?.body).toBe(BASE.replace('beta', 'BETA (A)'));
    await settle(a, b);
    const merged = await expectConverged(s, a, b, id);
    expect(merged.body).toBe(BASE.replace('beta', 'BETA (A)').replace('delta', 'DELTA (B)'));
  });

  it('the record resolver flags an overlapping edit as a conflict, consistently on both replicas', async () => {
    const { s, a, b, id } = await setup(BASE);
    const textA = BASE.replace('beta', 'beta by A');
    const textB = BASE.replace('beta', 'beta by B');
    await edit(a, id, textA);
    b.c.now += 5000;
    await edit(b, id, textB);
    await sync(b.c);
    a.c.failNext = { push: 1, pull: 0, afterServer: false };
    await sync(a.c);
    const res = await s.app.request(`/api/sync/pull?since=${await a.c.local.cursor()}`);
    await a.c.local.applyPull(pullResponseSchema.parse(await res.json()));
    expect(a.resolverCalls).toBe(1);
    const local = await page(a, id);
    expect(local.body).toBe(textA); // local text kept as the body even though B's stamp was newer
    expect(local.conflict?.body).toBe(textB);
    expect(local.conflict?.revisionId).toBe(a.snaps.find((x) => x.label === 'theirs')?.id);
    await settle(a, b);
    const p = await expectConverged(s, a, b, id);
    expect(p).toMatchObject({ body: textA, conflict: { body: textB } });
    expect(b.resolverCalls).toBe(0);
  });

  it('overlapping edits produce the same conflict on both devices and keep both texts', async () => {
    const { s, a, b, id } = await setup(BASE);
    a.c.online = false;
    b.c.online = false;
    const textA = BASE.replace('gamma', 'gamma rewritten by A');
    const textB = BASE.replace('gamma', 'gamma rewritten by B');
    await edit(a, id, textA);
    b.c.now += 3000;
    await edit(b, id, textB);
    a.c.online = true;
    b.c.online = true;
    await settle(a, b);
    const p = await expectConverged(s, a, b, id);
    expect(p.conflict).not.toBeNull();
    expect([p.body, p.conflict!.body].sort()).toEqual([textA, textB].sort());

    // Resolve with a combined version on B; both replicas clear the conflict.
    const combined = BASE.replace('gamma', 'gamma rewritten by A and B');
    await resolveConflict(b.io, b.store, id, combined);
    await settle(a, b);
    const resolved = await expectConverged(s, a, b, id);
    expect(resolved).toMatchObject({ body: combined, conflict: null });

    // Later concurrent edits chain off the resolution and merge cleanly again.
    a.c.online = false;
    await edit(a, id, combined.replace('alpha', 'alpha 2'));
    await edit(b, id, combined.replace('epsilon', 'epsilon 2'));
    a.c.online = true;
    await settle(a, b);
    const again = await expectConverged(s, a, b, id);
    expect(again).toMatchObject({
      body: combined.replace('alpha', 'alpha 2').replace('epsilon', 'epsilon 2'),
      conflict: null,
    });
  });

  it('repeated rounds of offline edits keep converging without false conflicts', async () => {
    const { s, a, b, id } = await setup(
      L('l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9'),
    );
    for (let round = 0; round < 4; round++) {
      a.c.online = false;
      b.c.online = false;
      const cur = (await page(a, id)).body.split('\n');
      const ta = [...cur];
      ta[round] = `${ta[round]} A${round}`;
      const tb = [...cur];
      tb[9 - round] = `${tb[9 - round]} B${round}`;
      await edit(a, id, ta.join('\n'));
      // A second save in the same offline run.
      await edit(
        a,
        id,
        [...ta.slice(0, round + 1), `extra A${round}`, ...ta.slice(round + 1)].join('\n'),
      );
      await edit(b, id, tb.join('\n'));
      if (round % 2) a.c.now += 7000;
      else b.c.now += 7000;
      a.c.online = true;
      b.c.online = true;
      await settle(round % 2 ? b : a, round % 2 ? a : b);
      const p = await expectConverged(s, a, b, id);
      expect(p.conflict).toBeNull();
      expect(p.body).toContain(`A${round}`);
      expect(p.body).toContain(`B${round}`);
      expect(p.body).toContain(`extra A${round}`);
    }
  });

  it('a stale editor merges into a body that changed underneath it', async () => {
    const { a, b, id } = await setup(BASE);
    const from = (await page(a, id)).body;
    await edit(b, id, BASE.replace('alpha', 'alpha (B)'));
    await settle(b, a);
    // A's editor still holds text derived from `from`.
    const r = await saveBody(a.io, a.store, id, BASE.replace('epsilon', 'epsilon (A)'), from);
    expect(r).toMatchObject({ merged: true, conflict: false });
    expect((await page(a, id)).body).toBe(
      BASE.replace('alpha', 'alpha (B)').replace('epsilon', 'epsilon (A)'),
    );
  });
});

describe('decideBody', () => {
  it('accepts anything when we have no own edits', () => {
    expect(
      decideBody(acceptedState('x', 0), 'x', { body: 'y', bodyBase: null, conflictBody: null }),
    ).toEqual({
      kind: 'accept',
    });
  });

  it('accepts text built on ours, and conflict records that kept ours', () => {
    const { state } = planLocalSave(undefined, { body: 'base', bodyBase: null }, 'mine', 0);
    expect(
      decideBody(state, 'mine', { body: 'next', bodyBase: hashText('mine'), conflictBody: null })
        .kind,
    ).toBe('accept');
    expect(
      decideBody(state, 'mine', {
        body: 'x',
        bodyBase: CONFLICT_BASE_PREFIX + hashText('mine'),
        conflictBody: 'mine',
      }).kind,
    ).toBe('accept');
  });

  it('conflicts when the ancestor is unknown, never guessing', () => {
    const { state } = planLocalSave(undefined, { body: 'base', bodyBase: null }, 'mine', 0);
    expect(
      decideBody(state, 'mine', {
        body: 'theirs',
        bodyBase: hashText('unknown'),
        conflictBody: null,
      }),
    ).toEqual({
      kind: 'conflict',
      reason: 'unknown-base',
    });
    expect(
      decideBody(undefined, 'mine', { body: 'theirs', bodyBase: null, conflictBody: null }, true)
        .kind,
    ).toBe('conflict');
  });

  it('keeps ours when the incoming text is an old version we already built on', () => {
    const { state } = planLocalSave(undefined, { body: 'base', bodyBase: null }, 'mine', 0);
    expect(
      decideBody(state, 'mine', { body: 'base', bodyBase: null, conflictBody: null }).kind,
    ).toBe('mine');
  });
});
