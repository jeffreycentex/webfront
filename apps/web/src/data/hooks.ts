import { useLiveQuery } from 'dexie-react-hooks';
import { stableStringify, type CollectionName, type RecordOf } from '@webfront/shared';
import { DEFAULT_STATUS } from './local';
import { getLocal } from './runtime';
import type { DataReader, QueryOptions, SyncStatus } from './types';

/**
 * React hooks over Dexie live queries: they re-run whenever the IndexedDB data they read
 * changes, in this tab or another one (including records pulled by the sync leader tab).
 */

/**
 * Live list of a collection. `undefined` while loading. The query re-runs when `collection`,
 * `where`, `limit` or `includeDeleted` change; pass anything `filter`/`sort` close over in `deps`.
 */
export function useCollection<N extends CollectionName>(
  collection: N,
  options?: QueryOptions<N>,
  deps: readonly unknown[] = [],
): RecordOf<N>[] | undefined {
  const whereKey = stableStringify(options?.where ?? null);
  return useLiveQuery(
    () => getLocal().list(collection, options),
    [collection, whereKey, options?.limit, options?.includeDeleted, ...deps],
  );
}

/** `undefined` while loading, `null` if not found (or deleted). */
export function useRecord<N extends CollectionName>(
  collection: N,
  id: string | null | undefined,
): RecordOf<N> | null | undefined {
  return useLiveQuery(
    async () => (id ? ((await getLocal().get(collection, id)) ?? null) : null),
    [collection, id],
  );
}

/** Live arbitrary query: re-runs when any data it read changes. */
export function useLiveData<T>(
  query: (db: DataReader) => Promise<T>,
  deps: readonly unknown[],
): T | undefined {
  return useLiveQuery(() => query(reader), [...deps]);
}

const INITIAL_STATUS: SyncStatus = { ...DEFAULT_STATUS, pendingChanges: 0, rejectedChanges: 0 };

/** Live sync status, shared by every tab (the leader tab persists it in IndexedDB). */
export function useSyncStatus(): SyncStatus {
  return useLiveQuery(() => getLocal().readStatus(), [], INITIAL_STATUS);
}

export const reader: DataReader = {
  get: (collection, id) => getLocal().get(collection, id),
  list: (collection, options) => getLocal().list(collection, options),
};
