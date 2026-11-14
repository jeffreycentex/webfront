import { compareBySortKey, coreSettings, readSetting, type ColourKey } from '@webfront/shared';
import { useCollection, useRecord } from '@/data';
import { useMemo } from 'react';
import type { Bookmark, Category } from './model';

/** Live data hooks for the bookmarks feature. `undefined` while loading. */

export function useCategories(): Category[] | undefined {
  return useCollection('bookmarkCategories', { sort: compareBySortKey });
}

export function useBookmarks(): Bookmark[] | undefined {
  return useCollection('bookmarks', { sort: compareBySortKey });
}

export function useStatuses() {
  const list = useCollection('serviceStatuses');
  return useMemo(() => new Map((list ?? []).map((s) => [s.bookmarkId, s])), [list]);
}

export function useTagColours(): Record<string, ColourKey> {
  const rec = useRecord('settings', coreSettings.tagColours.key);
  return useMemo(() => readSetting(coreSettings.tagColours, rec?.value), [rec]);
}

export function allTags(bookmarks: readonly Bookmark[] | undefined): string[] {
  const seen = new Map<string, number>();
  for (const b of bookmarks ?? []) for (const t of b.tags) seen.set(t, (seen.get(t) ?? 0) + 1);
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t);
}
