import { describe, expect, it } from 'vitest';
import {
  compareBySortKey,
  sortKeyAfter,
  sortKeyBefore,
  sortKeyBetween,
  sortKeyForIndex,
  sortKeysBetween,
} from './sortKey.js';

describe('sort keys', () => {
  it('generates keys strictly between neighbours', () => {
    const a = sortKeyAfter(null);
    const b = sortKeyAfter(a);
    const mid = sortKeyBetween(a, b);
    expect(a < mid && mid < b).toBe(true);
    const first = sortKeyBefore(a);
    expect(first < a).toBe(true);
  });

  it('supports many repeated inserts at the same spot', () => {
    let lo = sortKeyAfter(null);
    const hi = sortKeyAfter(lo);
    for (let i = 0; i < 200; i++) {
      const k = sortKeyBetween(lo, hi);
      expect(lo < k && k < hi).toBe(true);
      lo = k;
    }
  });

  it('generates n ordered keys', () => {
    const keys = sortKeysBetween(null, null, 10);
    expect(keys).toHaveLength(10);
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(10);
  });

  it('tolerates equal or swapped neighbours from concurrent edits', () => {
    const a = sortKeyAfter(null);
    expect(sortKeyBetween(a, a) > a).toBe(true);
    const b = sortKeyAfter(a);
    const k = sortKeyBetween(b, a);
    expect(a < k && k < b).toBe(true);
  });

  it('computes a key for a target index', () => {
    const keys = sortKeysBetween(null, null, 3);
    const items = keys.map((sortKey) => ({ sortKey }));
    const k0 = sortKeyForIndex(items, 0);
    const k1 = sortKeyForIndex(items, 1);
    const k3 = sortKeyForIndex(items, 99);
    expect(k0 < keys[0]!).toBe(true);
    expect(keys[0]! < k1 && k1 < keys[1]!).toBe(true);
    expect(k3 > keys[2]!).toBe(true);
    expect(sortKeyForIndex([], 0)).toBe(sortKeyAfter(null));
  });

  it('breaks ties by id', () => {
    const rows = [
      { id: 'b', sortKey: 'a1' },
      { id: 'a', sortKey: 'a1' },
      { id: 'c', sortKey: 'a0' },
    ];
    expect(rows.sort(compareBySortKey).map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });
});
