import { describe, expect, it } from 'vitest';
import { serializeHlc } from './hlc.js';
import {
  applyLocalEdit,
  changeToPartialRecord,
  mergeRecord,
  mergeRecordDetailed,
  recordToChangeFields,
  type SyncRecord,
} from './record.js';

const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccc';
const T = Date.UTC(2026, 10, 14, 12, 0, 0, 0);
const h = (offsetMs: number, node = A, counter = 0) =>
  serializeHlc({ wall: T + offsetMs, counter, node });
const iso = (offsetMs: number) => new Date(T + offsetMs).toISOString();
const ID = '0196f0a2-0000-7000-8000-000000000001';

type Note = SyncRecord<{ title: string; body: string; tags: string[] }>;

function note(partial: Partial<Note> & { clocks: Note['clocks'] }): Note {
  return {
    id: ID,
    createdAt: iso(0),
    updatedAt: iso(0),
    deleted: false,
    title: 't',
    body: 'b',
    tags: [],
    ...partial,
  };
}

const base = note({ clocks: { title: h(0), body: h(0), tags: h(0), deleted: h(0) } });

describe('mergeRecord', () => {
  it('takes each field from the side with the newer clock', () => {
    const local: Note = {
      ...base,
      title: 'local title',
      clocks: { ...base.clocks, title: h(10, A) },
    };
    const remote: Note = {
      ...base,
      body: 'remote body',
      updatedAt: iso(20),
      clocks: { ...base.clocks, body: h(20, B) },
    };
    const merged = mergeRecord(local, remote);
    expect(merged.title).toBe('local title');
    expect(merged.body).toBe('remote body');
    expect(merged.clocks).toEqual({ ...base.clocks, title: h(10, A), body: h(20, B) });
    expect(merged.updatedAt).toBe(iso(20));
    expect(local.title).toBe('local title'); // inputs untouched
    expect(remote.clocks.title).toBe(h(0));
  });

  it('breaks equal-wall ties by counter then node id', () => {
    const local: Note = { ...base, title: 'A', clocks: { ...base.clocks, title: h(5, A, 1) } };
    const remote: Note = { ...base, title: 'B', clocks: { ...base.clocks, title: h(5, B, 0) } };
    expect(mergeRecord(local, remote).title).toBe('A');
    const remote2: Note = { ...base, title: 'B', clocks: { ...base.clocks, title: h(5, B, 1) } };
    expect(mergeRecord(local, remote2).title).toBe('B');
  });

  it('treats deleted as a clocked field: newer edit vs older delete keeps the edit', () => {
    const deletedRemote: Note = {
      ...base,
      deleted: true,
      clocks: { ...base.clocks, deleted: h(10, B) },
    };
    const local: Note = { ...base, title: 'edited', clocks: { ...base.clocks, title: h(20, A) } };
    const merged = mergeRecord(local, deletedRemote);
    expect(merged.deleted).toBe(true);
    expect(merged.title).toBe('edited');
    const undelete: Note = {
      ...base,
      deleted: false,
      clocks: { ...base.clocks, deleted: h(30, A) },
    };
    expect(mergeRecord(merged, undelete).deleted).toBe(false);
  });

  it('keeps the earliest createdAt and the latest updatedAt', () => {
    const a: Note = { ...base, createdAt: iso(5), updatedAt: iso(10) };
    const b: Note = { ...base, createdAt: iso(1), updatedAt: iso(7) };
    const m = mergeRecord(a, b);
    expect(m.createdAt).toBe(iso(1));
    expect(m.updatedAt).toBe(iso(10));
  });

  it('applies a partial remote (a pushed change) onto a full record', () => {
    const partial = changeToPartialRecord<Note>({
      id: ID,
      createdAt: iso(0),
      fields: { title: { value: 'new', hlc: h(50, B) } },
    });
    const { record, changedFields } = mergeRecordDetailed(base, partial);
    expect(record.title).toBe('new');
    expect(record.body).toBe('b');
    expect(record.clocks.title).toBe(h(50, B));
    expect(record.updatedAt).toBe(iso(50));
    expect(changedFields).toEqual(['title']);
  });

  it('reports no changed fields when re-applying an already merged change', () => {
    const partial = changeToPartialRecord<Note>({
      id: ID,
      createdAt: iso(0),
      fields: { title: { value: 'x', hlc: h(50, B) } },
    });
    const once = mergeRecord(base, partial);
    expect(mergeRecordDetailed(once, partial).changedFields).toEqual([]);
    const stale = changeToPartialRecord<Note>({
      id: ID,
      createdAt: iso(0),
      fields: { title: { value: 'old', hlc: h(1, C) } },
    });
    expect(mergeRecordDetailed(once, stale).changedFields).toEqual([]);
  });

  it('merges with no local copy by copying remote', () => {
    const { record, changedFields } = mergeRecordDetailed(undefined, base);
    expect(record).toEqual(base);
    expect(record.clocks).not.toBe(base.clocks);
    expect(changedFields.sort()).toEqual(['body', 'deleted', 'tags', 'title']);
  });

  it('throws on id mismatch', () => {
    expect(() => mergeRecord(base, { ...base, id: 'other' })).toThrow(/id mismatch/);
  });

  it('is deterministic when stamps are equal but values differ', () => {
    const x: Note = { ...base, title: 'x', clocks: { ...base.clocks, title: h(9) } };
    const y: Note = { ...base, title: 'y', clocks: { ...base.clocks, title: h(9) } };
    expect(mergeRecord(x, y).title).toBe(mergeRecord(y, x).title);
  });

  it('is commutative, associative and idempotent', () => {
    const v1: Note = {
      ...base,
      title: 'one',
      updatedAt: iso(10),
      clocks: { ...base.clocks, title: h(10, A) },
    };
    const v2: Note = {
      ...base,
      body: 'two',
      tags: ['x'],
      updatedAt: iso(20),
      clocks: { ...base.clocks, body: h(20, B), tags: h(20, B) },
    };
    const v3: Note = {
      ...base,
      title: 'three',
      deleted: true,
      updatedAt: iso(15),
      clocks: { ...base.clocks, title: h(5, C), deleted: h(15, C) },
    };
    const versions = [v1, v2, v3];
    const expected = mergeRecord(mergeRecord(v1, v2), v3);
    for (const a of versions)
      for (const b of versions)
        for (const c of versions) {
          if (new Set([a, b, c]).size !== 3) continue;
          expect(mergeRecord(mergeRecord(a, b), c)).toEqual(expected);
          expect(mergeRecord(a, mergeRecord(b, c))).toEqual(expected);
        }
    expect(mergeRecord(expected, expected)).toEqual(expected);
    expect(mergeRecord(expected, v2)).toEqual(expected);
    expect(expected).toMatchObject({ title: 'one', body: 'two', tags: ['x'], deleted: true });
  });

  it('calls a field resolver for concurrent differing writes', () => {
    const local: Note = { ...base, body: 'L', clocks: { ...base.clocks, body: h(10, A) } };
    const remote: Note = { ...base, body: 'R', clocks: { ...base.clocks, body: h(20, B) } };
    const merged = mergeRecord(local, remote, {
      fieldResolvers: {
        body: ({ local: l, remote: r, winner }) => ({
          value: `${l.value}+${r.value}`,
          hlc: winner.hlc,
        }),
      },
    });
    expect(merged.body).toBe('L+R');
    expect(merged.clocks.body).toBe(h(20, B));
  });
});

describe('applyLocalEdit / recordToChangeFields', () => {
  it('creates a record with deleted=false and a clock per field', () => {
    const { record, fields } = applyLocalEdit<Note>(
      undefined,
      ID,
      { title: 'n', body: '', tags: [] },
      h(1),
      iso(1),
    );
    expect(record).toMatchObject({
      id: ID,
      title: 'n',
      deleted: false,
      createdAt: iso(1),
      updatedAt: iso(1),
    });
    expect(Object.keys(fields).sort()).toEqual(['body', 'deleted', 'tags', 'title']);
    expect(record.clocks.title).toBe(h(1));
  });

  it('patches only the given fields and refuses envelope keys', () => {
    const { record, fields } = applyLocalEdit(base, ID, { title: 'p' }, h(2), iso(2));
    expect(record.title).toBe('p');
    expect(record.clocks.body).toBe(h(0));
    expect(Object.keys(fields)).toEqual(['title']);
    expect(() => applyLocalEdit(base, ID, { createdAt: iso(3) }, h(3), iso(3))).toThrow();
  });

  it('round-trips a record through change fields', () => {
    const partial = changeToPartialRecord<Note>({
      id: base.id,
      createdAt: base.createdAt,
      fields: recordToChangeFields(base),
    });
    expect(mergeRecord(undefined, partial)).toEqual({ ...base, updatedAt: iso(0) });
  });
});
