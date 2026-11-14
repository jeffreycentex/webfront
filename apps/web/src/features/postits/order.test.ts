import { sortKeysBetween } from '@webfront/shared';
import { describe, expect, it } from 'vitest';
import { newNoteKey, recentPostits, reorderKey, sortPostits, type Postit } from './order';

let n = 0;
const note = (o: Partial<Postit>): Postit =>
  ({
    id: `p${String(++n).padStart(3, '0')}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deleted: false,
    clocks: {},
    text: 'x',
    colour: 'yellow',
    pinned: false,
    archived: false,
    sortKey: 'a0',
    ...o,
  }) as Postit;

describe('sortPostits', () => {
  it('puts pinned first, then by sortKey with id tie-break', () => {
    const [k1, k2, k3] = sortKeysBetween(null, null, 3) as [string, string, string];
    const a = note({ sortKey: k3, pinned: true });
    const b = note({ sortKey: k1 });
    const c = note({ sortKey: k2 });
    const d = note({ sortKey: k2 });
    expect(sortPostits([c, d, b, a]).map((x) => x.id)).toEqual([a.id, b.id, c.id, d.id]);
  });
});

describe('recentPostits', () => {
  it('pinned first, then newest first', () => {
    const old = note({ createdAt: '2026-01-01T00:00:00.000Z' });
    const fresh = note({ createdAt: '2026-06-01T00:00:00.000Z' });
    const pin = note({ createdAt: '2025-01-01T00:00:00.000Z', pinned: true });
    expect(recentPostits([old, fresh, pin]).map((x) => x.id)).toEqual([pin.id, fresh.id, old.id]);
  });
});

describe('newNoteKey', () => {
  it('sorts before every existing key', () => {
    const keys = sortKeysBetween(null, null, 3).map((sortKey, i) => ({ sortKey, id: `i${i}` }));
    expect(newNoteKey(keys) < keys[0]!.sortKey).toBe(true);
    expect(newNoteKey([])).toBeTruthy();
  });
});

describe('reorderKey', () => {
  const keys = sortKeysBetween(null, null, 4);
  const list = ['A', 'B', 'C', 'D'].map((id, i) => ({ id, sortKey: keys[i]! }));
  const apply = (id: string, over: string) => {
    const k = reorderKey(list, id, over);
    return list
      .map((x) => (x.id === id && k ? { ...x, sortKey: k } : x))
      .sort((p, q) => (p.sortKey < q.sortKey ? -1 : 1))
      .map((x) => x.id)
      .join('');
  };
  it('moves in both directions', () => {
    expect(apply('A', 'C')).toBe('BCAD');
    expect(apply('D', 'A')).toBe('DABC');
    expect(apply('B', 'A')).toBe('BACD');
  });
  it('is a no-op for same or unknown ids', () => {
    expect(reorderKey(list, 'A', 'A')).toBeNull();
    expect(reorderKey(list, 'Z', 'A')).toBeNull();
  });
});
