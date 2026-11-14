import {
  HLC_ZERO,
  MAX_CLOCK_DRIFT_MS,
  newId,
  pullResponseSchema,
  pushResponseSchema,
  serializeHlc,
  syncChangedEventSchema,
  syncHelloEventSchema,
  type PullResponse,
  type PushResponse,
  type RecordChange,
} from '@webfront/shared';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../test/helpers.js';
import { createSyncFeature, MAX_PUSH_BODY_BYTES } from './index.js';

const NOW = Date.parse('2026-11-14T10:00:00.000Z');
const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';
const CREATED = '2026-11-14T09:00:00.000Z';

/** HLC stamp `ms` after NOW (may be negative). */
const hlc = (ms: number, node = A, counter = 0) => serializeHlc({ wall: NOW + ms, counter, node });

async function setup(opts: { signedIn?: boolean; heartbeatMs?: number } = {}) {
  let now = NOW;
  const feature = createSyncFeature({ now: () => now, heartbeatMs: opts.heartbeatMs ?? 60_000 });
  const { app, ctx } = await createTestApp({
    features: [{ name: 'sync', register: feature }],
    signedIn: opts.signedIn ?? true,
  });
  const push = async (changes: RecordChange[], clientId = A): Promise<PushResponse> => {
    const res = await app.request('/api/sync/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId, changes }),
    });
    expect(res.status).toBe(200);
    return pushResponseSchema.parse(await res.json());
  };
  const pull = async (since = 0, limit?: number): Promise<PullResponse> => {
    const q = limit === undefined ? `since=${since}` : `since=${since}&limit=${limit}`;
    const res = await app.request(`/api/sync/pull?${q}`);
    expect(res.status).toBe(200);
    return pullResponseSchema.parse(await res.json());
  };
  const pullAll = async (since = 0) => {
    const records: PullResponse['records'] = [];
    let cursor = since;
    for (;;) {
      const page = await pull(cursor, 2);
      records.push(...page.records);
      cursor = page.cursor;
      if (!page.hasMore) break;
    }
    return { records, cursor };
  };
  return {
    app,
    ctx,
    push,
    pull,
    pullAll,
    setNow: (t: number) => {
      now = t;
    },
  };
}

function taskCreate(id: string, title: string, at: string, extra: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    title,
    notes: '',
    dueDate: null,
    completedAt: null,
    sortKey: 'a0',
    deleted: false,
    ...extra,
  };
  return {
    collection: 'tasks' as const,
    id,
    createdAt: CREATED,
    fields: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v, hlc: at }])),
  };
}

function fieldChange(id: string, fields: Record<string, [unknown, string]>): RecordChange {
  return {
    collection: 'tasks',
    id,
    createdAt: CREATED,
    fields: Object.fromEntries(
      Object.entries(fields).map(([k, [v, h]]) => [k, { value: v, hlc: h }]),
    ),
  };
}

describe('sync push', () => {
  it('creates a record and assigns increasing seqs', async () => {
    const t = await setup();
    const id1 = newId();
    const id2 = newId();
    const res = await t.push([
      taskCreate(id1, 'one', hlc(-1000)),
      taskCreate(id2, 'two', hlc(-900)),
    ]);
    expect(res.results).toEqual([
      { collection: 'tasks', id: id1, status: 'applied', seq: 1 },
      { collection: 'tasks', id: id2, status: 'applied', seq: 2 },
    ]);
    expect(res.maxSeq).toBe(2);
    expect(res.serverId).toBe(t.ctx.records.serverId());
    const stored = t.ctx.records.get('tasks', id1);
    expect(stored?.title).toBe('one');
    expect(stored?.clocks.title).toBe(hlc(-1000));
    expect(stored?.deleted).toBe(false);
  });

  it('is idempotent: replaying a push changes nothing and assigns no seq', async () => {
    const t = await setup();
    const id = newId();
    const change = taskCreate(id, 'one', hlc(-1000));
    await t.push([change]);
    const before = t.ctx.records.get('tasks', id);
    const again = await t.push([change]);
    expect(again.results[0]).toEqual({ collection: 'tasks', id, status: 'unchanged' });
    expect(again.maxSeq).toBe(1);
    expect(t.ctx.records.get('tasks', id)).toEqual(before);
  });

  it('merges per field by HLC regardless of arrival order', async () => {
    const id = newId();
    const create = taskCreate(id, 'v0', hlc(-10_000));
    const a = fieldChange(id, {
      title: ['from A', hlc(-5000, A)],
      notes: ['A notes', hlc(-3000, A)],
    });
    const b = fieldChange(id, {
      title: ['from B', hlc(-4000, B)],
      notes: ['B notes', hlc(-6000, B)],
    });

    const t1 = await setup();
    await t1.push([create]);
    await t1.push([a], A);
    await t1.push([b], B);

    const t2 = await setup();
    await t2.push([b], B); // B's partial arrives before the create
    await t2.push([create]);
    await t2.push([a], A);

    for (const t of [t1]) {
      const r = t.ctx.records.get('tasks', id)!;
      expect(r.title).toBe('from B');
      expect(r.notes).toBe('A notes');
    }
    // In t2, B's partial for an unknown record is rejected (incomplete), then create + A apply.
    const r2 = t2.ctx.records.get('tasks', id)!;
    expect(r2.notes).toBe('A notes');
    expect(r2.title).toBe('from A');
  });

  it('two clients pushing out of order converge to the same record', async () => {
    const id = newId();
    const create = taskCreate(id, 'v0', hlc(-10_000));
    const changes = [
      fieldChange(id, { title: ['A1', hlc(-5000, A)] }),
      fieldChange(id, { title: ['B1', hlc(-5000, B)] }), // same wall and counter: node breaks tie
      fieldChange(id, { notes: ['B2', hlc(-2000, B)], deleted: [true, hlc(-2500, B)] }),
      fieldChange(id, { deleted: [false, hlc(-2400, A)], notes: ['A2', hlc(-2100, A)] }),
    ];
    const orders = [
      [0, 1, 2, 3],
      [3, 2, 1, 0],
      [2, 0, 3, 1],
    ];
    const finals = [];
    for (const order of orders) {
      const t = await setup();
      await t.push([create]);
      for (const i of order) await t.push([changes[i]!], i % 2 === 0 ? A : B);
      const r = t.ctx.records.get('tasks', id)!;
      finals.push({ title: r.title, notes: r.notes, deleted: r.deleted, clocks: r.clocks });
    }
    expect(finals[1]).toEqual(finals[0]);
    expect(finals[2]).toEqual(finals[0]);
    expect(finals[0]).toMatchObject({ title: 'B1', notes: 'B2', deleted: false });
  });

  it('applies changes in one batch sequentially, each with its own seq', async () => {
    const t = await setup();
    const id = newId();
    const res = await t.push([
      taskCreate(id, 'v0', hlc(-10_000)),
      fieldChange(id, { title: ['v1', hlc(-9000)] }),
    ]);
    expect(res.results.map((r) => r.status)).toEqual(['applied', 'applied']);
    expect(res.maxSeq).toBe(2);
    expect(t.ctx.records.get('tasks', id)?.title).toBe('v1');
    // Only one row; its seq is the latest change's seq.
    const page = await t.pull(0);
    expect(page.records).toHaveLength(1);
    expect(page.records[0]?.seq).toBe(2);
  });

  it('a change that loses every field is unchanged', async () => {
    const t = await setup();
    const id = newId();
    await t.push([taskCreate(id, 'new', hlc(-1000))]);
    const res = await t.push([fieldChange(id, { title: ['old', hlc(-5000, B)] })], B);
    expect(res.results[0]?.status).toBe('unchanged');
    expect(t.ctx.records.get('tasks', id)?.title).toBe('new');
  });

  it('tombstones and undeletes by HLC', async () => {
    const t = await setup();
    const id = newId();
    await t.push([taskCreate(id, 'x', hlc(-10_000))]);
    await t.push([fieldChange(id, { deleted: [true, hlc(-5000)] })]);
    expect(t.ctx.records.get('tasks', id)?.deleted).toBe(true);
    expect(t.ctx.records.list('tasks')).toHaveLength(0);
    expect(t.ctx.records.list('tasks', { includeDeleted: true })).toHaveLength(1);

    // A concurrent but older undelete loses; a newer one wins.
    const older = await t.push([fieldChange(id, { deleted: [false, hlc(-6000, B)] })], B);
    expect(older.results[0]?.status).toBe('unchanged');
    expect(t.ctx.records.get('tasks', id)?.deleted).toBe(true);
    await t.push([fieldChange(id, { deleted: [false, hlc(-4000, B)] })], B);
    expect(t.ctx.records.get('tasks', id)?.deleted).toBe(false);

    // An edit to a deleted record is kept (and visible after undelete).
    await t.push([fieldChange(id, { deleted: [true, hlc(-3000)] })]);
    await t.push([fieldChange(id, { title: ['edited while deleted', hlc(-2000, B)] })], B);
    const r = t.ctx.records.get('tasks', id)!;
    expect(r.deleted).toBe(true);
    expect(r.title).toBe('edited while deleted');
    const pulled = await t.pull(0);
    expect(pulled.records[0]?.record.deleted).toBe(true);
  });

  it('stores normalised (parsed) values', async () => {
    const t = await setup();
    const id = newId();
    await t.push([taskCreate(id, '  padded  ', hlc(-1000))]);
    expect(t.ctx.records.get('tasks', id)?.title).toBe('padded');
  });

  describe('rejections', () => {
    it('rejects writes to server-owned collections', async () => {
      const t = await setup();
      const id = newId();
      const res = await t.push([
        {
          collection: 'serviceStatuses',
          id,
          createdAt: CREATED,
          fields: {
            bookmarkId: { value: id, hlc: hlc(-1) },
            deleted: { value: false, hlc: hlc(-1) },
          },
        },
      ]);
      expect(res.results[0]).toMatchObject({ status: 'rejected', code: 'read_only' });
      expect(res.maxSeq).toBe(0);
    });

    it('rejects unknown fields, envelope keys, invalid values and bad ids', async () => {
      const t = await setup();
      const id = newId();
      await t.push([taskCreate(id, 'x', hlc(-10_000))]);
      const cases: Array<[RecordChange, string]> = [
        [fieldChange(id, { bogus: [1, hlc(-1000)] }), 'unknown_field'],
        [fieldChange(id, { updatedAt: [CREATED, hlc(-1000)] }), 'unknown_field'],
        [fieldChange(id, { clocks: [{}, hlc(-1000)] }), 'unknown_field'],
        [fieldChange(id, { title: ['', hlc(-1000)] }), 'invalid_value'],
        [fieldChange(id, { dueDate: ['tomorrow', hlc(-1000)] }), 'invalid_value'],
        [fieldChange(id, { deleted: ['yes', hlc(-1000)] }), 'invalid_value'],
        [{ collection: 'tasks', id, createdAt: CREATED, fields: {} }, 'empty_change'],
        [fieldChange('not-a-uuid', { title: ['x', hlc(-1000)] }), 'invalid_id'],
      ];
      const res = await t.push(cases.map(([c]) => c));
      res.results.forEach((r, i) => {
        expect(r, `case ${i}`).toMatchObject({ status: 'rejected', code: cases[i]![1] });
      });
      expect(res.maxSeq).toBe(1);
      expect(t.ctx.records.get('tasks', id)?.title).toBe('x');
    });

    it('rejects a valid change mixed with an invalid field as a whole (no partial apply)', async () => {
      const t = await setup();
      const id = newId();
      await t.push([taskCreate(id, 'x', hlc(-10_000))]);
      const res = await t.push([
        fieldChange(id, { title: ['ok', hlc(-1000)], bogus: [1, hlc(-1000)] }),
      ]);
      expect(res.results[0]?.status).toBe('rejected');
      expect(t.ctx.records.get('tasks', id)?.title).toBe('x');
    });

    it('rejects incomplete new records', async () => {
      const t = await setup();
      const res = await t.push([fieldChange(newId(), { title: ['only a title', hlc(-1000)] })]);
      expect(res.results[0]).toMatchObject({ status: 'rejected', code: 'incomplete_record' });
    });

    it('rejects clocks too far ahead of the server', async () => {
      const t = await setup();
      const id = newId();
      const res = await t.push([
        taskCreate(id, 'future', hlc(MAX_CLOCK_DRIFT_MS + 1000)),
        taskCreate(newId(), 'slightly ahead is fine', hlc(MAX_CLOCK_DRIFT_MS - 1000)),
      ]);
      expect(res.results[0]).toMatchObject({ status: 'rejected', code: 'clock_drift' });
      expect(res.results[1]?.status).toBe('applied');
    });

    it('rejects malformed requests with 400', async () => {
      const t = await setup();
      const bad = [
        { clientId: 'nope', changes: [] },
        {
          clientId: A,
          changes: [{ collection: 'unknownThings', id: 'x', createdAt: CREATED, fields: {} }],
        },
        { clientId: A, changes: [fieldChange(newId(), { title: ['x', 'not-an-hlc'] })] },
        // A field change without a value.
        {
          clientId: A,
          changes: [
            {
              collection: 'tasks',
              id: newId(),
              createdAt: CREATED,
              fields: { title: { hlc: hlc(-1) } },
            },
          ],
        },
      ];
      for (const body of bad) {
        const res = await t.app.request('/api/sync/push', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(400);
      }
    });

    it('rejects oversized push bodies with 413 before parsing them', async () => {
      const t = await setup();
      const res = await t.app.request('/api/sync/push', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(MAX_PUSH_BODY_BYTES + 1),
        },
        body: 'x'.repeat(MAX_PUSH_BODY_BYTES + 1),
      });
      expect(res.status).toBe(413);
    });
  });

  it('requires auth', async () => {
    const t = await setup({ signedIn: false });
    expect((await t.app.request('/api/sync/pull')).status).toBe(401);
    expect((await t.app.request('/api/sync/events')).status).toBe(401);
    const res = await t.app.request('/api/sync/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: A, changes: [] }),
    });
    expect(res.status).toBe(401);
  });
});

describe('sync pull', () => {
  it('paginates in seq order with a stable cursor', async () => {
    const t = await setup();
    const ids = Array.from({ length: 5 }, () => newId());
    await t.push(ids.map((id, i) => taskCreate(id, `t${i}`, hlc(-10_000 + i))));

    const p1 = await t.pull(0, 2);
    expect(p1.records.map((r) => r.seq)).toEqual([1, 2]);
    expect(p1.cursor).toBe(2);
    expect(p1.hasMore).toBe(true);

    // A record from page 1 changes between pages: it moves to a new, higher seq.
    await t.push([fieldChange(ids[0]!, { title: ['changed', hlc(-500)] })]);

    const p2 = await t.pull(p1.cursor, 2);
    expect(p2.records.map((r) => r.seq)).toEqual([3, 4]);
    const p3 = await t.pull(p2.cursor, 2);
    expect(p3.records.map((r) => r.seq)).toEqual([5, 6]);
    expect(p3.records[1]?.record.id).toBe(ids[0]);
    expect(p3.records[1]?.record.title).toBe('changed');
    expect(p3.hasMore).toBe(false);

    const empty = await t.pull(p3.cursor, 2);
    expect(empty).toMatchObject({ records: [], cursor: p3.cursor, hasMore: false });

    const page = await t.pull(1000);
    expect(page.cursor).toBe(1000);
  });

  it('returns full records with clocks and validates query parameters', async () => {
    const t = await setup();
    const id = newId();
    await t.push([taskCreate(id, 't', hlc(-1000))]);
    const p = await t.pull(0);
    expect(p.serverId).toBe(t.ctx.records.serverId());
    expect(p.records[0]).toMatchObject({
      collection: 'tasks',
      seq: 1,
      record: { id, title: 't', deleted: false, createdAt: CREATED },
    });
    expect(p.records[0]?.record.clocks.title).toBe(hlc(-1000));
    expect((await t.app.request('/api/sync/pull?since=-1')).status).toBe(400);
    expect((await t.app.request('/api/sync/pull?limit=0')).status).toBe(400);
    expect((await t.app.request('/api/sync/pull?limit=99999')).status).toBe(400);
  });

  it('seq is strictly monotonic across pushes and server writes, and matches maxSeq', async () => {
    const t = await setup();
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      const id = newId();
      const res = await t.push([taskCreate(id, `t${i}`, hlc(-1000 + i))]);
      const r = res.results[0]!;
      if (r.status === 'applied') seen.push(r.seq);
      t.ctx.records.writeAsServer('serviceStatuses', [{ id: newId(), fields: { bookmarkId: id } }]);
      seen.push(t.ctx.records.maxSeq());
    }
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]!);
    const all = await t.pullAll();
    expect(all.cursor).toBe(t.ctx.records.maxSeq());
    expect(all.records.map((r) => r.seq)).toEqual(
      [...all.records.map((r) => r.seq)].sort((a, b) => a - b),
    );
  });
});

describe('writeAsServer', () => {
  it('creates and updates server-owned records, stamping only changed fields', async () => {
    const t = await setup();
    const bookmarkId = newId();
    const events: unknown[] = [];
    t.ctx.events.on('records.changed', (p) => events.push(p));

    expect(
      t.ctx.records.writeAsServer('serviceStatuses', [{ id: bookmarkId, fields: { bookmarkId } }]),
    ).toBe(1);
    const created = t.ctx.records.get('serviceStatuses', bookmarkId)!;
    expect(created.state).toBe('unknown');
    expect(created.deleted).toBe(false);
    // Every field, defaults included, carries a server clock.
    for (const k of ['bookmarkId', 'state', 'changedAt', 'message', 'deleted']) {
      expect(created.clocks[k]).toMatch(/-[0-9a-f]{16}$/);
      expect(created.clocks[k]!.endsWith(A)).toBe(false);
    }
    expect(events).toEqual([{ maxSeq: 1, collections: ['serviceStatuses'], originClientId: null }]);

    // Same values: no change, no seq, no event.
    expect(
      t.ctx.records.writeAsServer('serviceStatuses', [
        { id: bookmarkId, fields: { state: 'unknown' } },
      ]),
    ).toBe(0);
    expect(t.ctx.records.maxSeq()).toBe(1);
    expect(events).toHaveLength(1);

    t.setNow(NOW + 60_000);
    expect(
      t.ctx.records.writeAsServer('serviceStatuses', [
        { id: bookmarkId, fields: { state: 'down', message: 'HTTP 502', bookmarkId } },
      ]),
    ).toBe(1);
    const updated = t.ctx.records.get('serviceStatuses', bookmarkId)!;
    expect(updated.state).toBe('down');
    expect(updated.clocks.state! > created.clocks.state!).toBe(true);
    expect(updated.clocks.bookmarkId).toBe(created.clocks.bookmarkId);
    expect(t.ctx.records.maxSeq()).toBe(2);
    expect(events).toHaveLength(2);
  });

  it('server stamps beat every client stamp already seen, even from a fast client clock', async () => {
    const t = await setup();
    const id = newId();
    const feed = {
      collection: 'calendarFeeds' as const,
      id,
      createdAt: CREATED,
      fields: {
        name: { value: 'Work', hlc: hlc(60_000, A) },
        url: { value: 'https://example.com/a.ics', hlc: hlc(60_000, A) },
        colour: { value: 'blue', hlc: hlc(60_000, A) },
        enabled: { value: true, hlc: hlc(60_000, A) },
        lastFetchedAt: { value: null, hlc: hlc(60_000, A) },
        lastError: { value: null, hlc: hlc(60_000, A) },
        deleted: { value: false, hlc: hlc(60_000, A) },
      },
    };
    expect((await t.push([feed])).results[0]?.status).toBe('applied');
    t.ctx.records.writeAsServer('calendarFeeds', [{ id, fields: { lastError: 'HTTP 404' } }]);
    const r = t.ctx.records.get('calendarFeeds', id)!;
    expect(r.lastError).toBe('HTTP 404');
    expect(r.clocks.lastError! > hlc(60_000, A)).toBe(true);
  });

  it('rejects invalid server writes and leaves the database unchanged', async () => {
    const t = await setup();
    const good = newId();
    expect(() =>
      t.ctx.records.writeAsServer('serviceStatuses', [
        { id: good, fields: { bookmarkId: good } },
        { id: newId(), fields: { bookmarkId: 'nope' } },
      ]),
    ).toThrow();
    expect(t.ctx.records.get('serviceStatuses', good)).toBeUndefined();
    expect(t.ctx.records.maxSeq()).toBe(0);
    expect(() =>
      t.ctx.records.writeAsServer('serviceStatuses', [
        { id: good, fields: { bookmarkId: good, bogus: 1 } as never },
      ]),
    ).toThrow(/unknown field/);
  });

  it('persists the server clock across store re-creation', async () => {
    const t = await setup();
    const id = newId();
    t.ctx.records.writeAsServer('serviceStatuses', [{ id, fields: { bookmarkId: id } }]);
    const first = t.ctx.records.get('serviceStatuses', id)!.clocks.state!;
    // Re-install a store over the same database with a clock that went backwards.
    const { createRecordStore } = await import('./store.js');
    const again = createRecordStore({
      db: t.ctx.db,
      events: t.ctx.events,
      logger: t.ctx.logger,
      now: () => NOW - 3_600_000,
    });
    again.writeAsServer('serviceStatuses', [{ id, fields: { state: 'up' } }]);
    expect(again.get('serviceStatuses', id)!.clocks.state! > first).toBe(true);
  });
});

describe('records.changed events and SSE', () => {
  it('push emits one records.changed with the origin client', async () => {
    const t = await setup();
    const events: unknown[] = [];
    t.ctx.events.on('records.changed', (p) => events.push(p));
    await t.push([taskCreate(newId(), 'x', hlc(-1))], B);
    await t.push([], B);
    expect(events).toEqual([{ maxSeq: 1, collections: ['tasks'], originClientId: B }]);
  });

  async function readEvents(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const next = async (): Promise<string> => {
      for (;;) {
        const idx = buf.indexOf('\n\n');
        if (idx >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          return block;
        }
        const { value, done } = await reader.read();
        if (done) return '<eof>';
        buf += decoder.decode(value, { stream: true });
      }
    };
    return { next, reader };
  }

  const parseBlock = (block: string) => {
    const event = /^event: (.*)$/m.exec(block)?.[1];
    const data = /^data: (.*)$/m.exec(block)?.[1];
    return { event, data: data ? (JSON.parse(data) as unknown) : undefined };
  };

  it('sends hello, then changed pokes, heartbeats, and cleans up on disconnect', async () => {
    const t = await setup({ heartbeatMs: 20 });
    let listeners = 0;
    const origOn = t.ctx.events.on.bind(t.ctx.events);
    t.ctx.events.on = ((event: never, fn: never) => {
      listeners++;
      const off = origOn(event, fn);
      return () => {
        listeners--;
        off();
      };
    }) as typeof t.ctx.events.on;

    const res = await t.app.request('/api/sync/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const s = await readEvents(res.body!);

    const hello = parseBlock(await s.next());
    expect(hello.event).toBe('hello');
    expect(syncHelloEventSchema.parse(hello.data)).toEqual({
      serverId: t.ctx.records.serverId(),
      maxSeq: 0,
    });
    expect(listeners).toBe(2);

    await t.push([taskCreate(newId(), 'x', hlc(-1))], B);
    let block = await s.next();
    while (block.startsWith(': ping')) block = await s.next();
    const changed = parseBlock(block);
    expect(changed.event).toBe('changed');
    expect(syncChangedEventSchema.parse(changed.data)).toEqual({ maxSeq: 1, originClientId: B });

    // Heartbeat comment arrives within a few intervals.
    let sawPing = false;
    for (let i = 0; i < 5 && !sawPing; i++) sawPing = (await s.next()).startsWith(': ping');
    expect(sawPing).toBe(true);

    await s.reader.cancel();
    await new Promise((r) => setTimeout(r, 10));
    expect(listeners).toBe(0);
  });

  it('closes the stream when its session is revoked, and on shutdown', async () => {
    const t = await setup();
    const res = await t.app.request('/api/sync/events');
    const s = await readEvents(res.body!);
    expect(parseBlock(await s.next()).event).toBe('hello');
    t.ctx.events.emit('session.revoked', { sessionId: 'someone-else' });
    t.ctx.events.emit('session.revoked', { sessionId: 'test-session' });
    expect(await s.next()).toBe('<eof>');

    const res2 = await t.app.request('/api/sync/events');
    const s2 = await readEvents(res2.body!);
    expect(parseBlock(await s2.next()).event).toBe('hello');
    await t.ctx.close();
    expect(await s2.next()).toBe('<eof>');
  });
});

describe('record store helpers', () => {
  it('get returns tombstoned records; list hides them', async () => {
    const t = await setup();
    const id = newId();
    await t.push([taskCreate(id, 'x', hlc(-1000), { deleted: true })]);
    expect(t.ctx.records.get('tasks', id)?.deleted).toBe(true);
    expect(t.ctx.records.list('tasks')).toEqual([]);
    expect(t.ctx.records.get('tasks', newId())).toBeUndefined();
    expect(HLC_ZERO < hlc(0)).toBe(true);
  });
});
