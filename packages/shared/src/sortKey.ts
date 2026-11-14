import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import { z } from 'zod';

/**
 * Fractional-index sort keys for drag ordering (bookmarks, categories, post-its, tasks,
 * shopping items, wiki siblings). Moving an item rewrites only that item's `sortKey`, so a
 * reorder is a single-field change that merges cleanly.
 *
 * Rules:
 * - Order by plain code-unit comparison (`<`), never `localeCompare`. IndexedDB and SQLite
 *   (BINARY collation) order strings the same way.
 * - Two replicas inserting at the same spot offline can produce equal keys; always break ties
 *   by `id` (use `compareBySortKey`).
 */

export const sortKeySchema = z.string().min(1).max(256);
export type SortKey = z.infer<typeof sortKeySchema>;

/** Key strictly between `before` and `after` (either may be null for the open end). */
export function sortKeyBetween(
  before: string | null | undefined,
  after: string | null | undefined,
): SortKey {
  const a = before ?? null;
  const b = after ?? null;
  if (a !== null && b !== null && a === b) {
    // Concurrent inserts produced equal neighbours; place just after them.
    return generateKeyBetween(a, null);
  }
  if (a !== null && b !== null && a > b) return generateKeyBetween(b, a);
  return generateKeyBetween(a, b);
}

/** `n` evenly spread keys strictly between `before` and `after`. */
export function sortKeysBetween(
  before: string | null | undefined,
  after: string | null | undefined,
  n: number,
): SortKey[] {
  return generateNKeysBetween(before ?? null, after ?? null, n);
}

/** Key for appending after the current last key (`null` for an empty list). */
export function sortKeyAfter(last: string | null | undefined): SortKey {
  return generateKeyBetween(last ?? null, null);
}

/** Key for prepending before the current first key. */
export function sortKeyBefore(first: string | null | undefined): SortKey {
  return generateKeyBetween(null, first ?? null);
}

export function compareSortKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Comparator for records with `sortKey` and `id`; ties broken by id. */
export function compareBySortKey(
  a: { sortKey: string; id: string },
  b: { sortKey: string; id: string },
): number {
  return compareSortKeys(a.sortKey, b.sortKey) || compareSortKeys(a.id, b.id);
}

/**
 * Key for moving an item to index `toIndex` in `sorted` (the list already ordered by
 * `compareBySortKey`, *excluding* the item being moved).
 */
export function sortKeyForIndex(sorted: readonly { sortKey: string }[], toIndex: number): SortKey {
  const i = Math.max(0, Math.min(toIndex, sorted.length));
  const before = i > 0 ? sorted[i - 1]!.sortKey : null;
  const after = i < sorted.length ? sorted[i]!.sortKey : null;
  return sortKeyBetween(before, after);
}
