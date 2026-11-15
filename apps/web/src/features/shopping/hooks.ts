import { useCallback, useEffect, useMemo, useState } from 'react';
import { compareBySortKey } from '@webfront/shared';
import { useCollection } from '@/data';
import {
  buildHistory,
  deriveStaples,
  missingStaples,
  type HistoryEntry,
  type Staple,
} from './logic';

const LAST_LIST_KEY = 'webfront.shopping.lastList';

export function readLastList(): string | null {
  try {
    return localStorage.getItem(LAST_LIST_KEY);
  } catch {
    return null;
  }
}

function writeLastList(id: string) {
  try {
    localStorage.setItem(LAST_LIST_KEY, id);
  } catch {
    /* storage unavailable: just don't remember */
  }
}

/** Live, sorted lists (undefined while loading). */
export function useShoppingLists() {
  return useCollection('shoppingLists', { sort: compareBySortKey });
}

/**
 * The list to show, remembered per device. Falls back to the first list when the remembered
 * one is gone (deleted on another device, say).
 */
export function useActiveList<T extends { id: string }>(lists: readonly T[] | undefined) {
  const [stored, setStored] = useState<string | null>(readLastList);
  const active = useMemo(
    () => lists?.find((l) => l.id === stored) ?? lists?.[0] ?? null,
    [lists, stored],
  );
  const select = useCallback((id: string) => {
    writeLastList(id);
    setStored(id);
  }, []);
  return [active, select] as const;
}

/** Every item name ever added (cleared items included), derived from synced records. */
export function useItemHistory(): HistoryEntry[] {
  const all = useCollection('shoppingItems', { includeDeleted: true });
  return useMemo(() => (all ? buildHistory(all) : []), [all]);
}

/** Keep the screen awake while `active` (Wake Lock API, where available). */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const nav = navigator as Navigator & {
      wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> };
    };
    if (!nav.wakeLock) return;
    let sentinel: { release(): Promise<void> } | null = null;
    let cancelled = false;
    const acquire = () => {
      nav
        .wakeLock!.request('screen')
        .then((s) => {
          if (cancelled) void s.release().catch(() => {});
          else sentinel = s;
        })
        .catch(() => {});
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') acquire();
    };
    acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void sentinel?.release().catch(() => {});
    };
  }, [active]);
}

/** A list's staples (derived from flagged item records, cleared ones included) and the rest. */
export function useStaples(listId: string | undefined) {
  const records = useCollection(
    'shoppingItems',
    { where: { listId: listId ?? '' }, includeDeleted: true },
    [listId],
  );
  return useMemo(() => {
    if (!records)
      return {
        loading: true as const,
        staples: [] as Staple[],
        live: [],
        missing: [] as Staple[],
        keys: new Set<string>(),
      };
    const staples = deriveStaples(records);
    const live = records.filter((r) => !r.deleted);
    return {
      loading: false as const,
      staples,
      live,
      missing: missingStaples(staples, live),
      keys: new Set(staples.map((s) => s.key)),
    };
  }, [records]);
}
