import type { CollectionName, FieldsInput, FieldsOf, RecordOf } from '@webfront/shared';

/**
 * The data-layer contract (Task 1). Feature code talks to local data ONLY through these
 * types and the functions exported from `@/data`. Task 3 implements them on Dexie
 * (IndexedDB) with an outbox and sync; until then `@/data` is a stub.
 *
 * Rules:
 * - Reads come from IndexedDB and are live: hooks re-render when local data changes,
 *   including changes pulled from other devices.
 * - Writes are local-first: they resolve once stored locally and queued for sync. They never
 *   wait for the network and work offline.
 * - Tombstoned (deleted) records are hidden unless `includeDeleted` is set.
 * - Server-owned collections (calendarEvents, serviceStatuses) are read-only: write
 *   functions reject for them.
 */

export type { CollectionName, FieldsInput, FieldsOf, RecordOf };

export interface QueryOptions<N extends CollectionName> {
  /**
   * Equality match on one field. Use a field listed in the collection's registry `indexes`
   * for an indexed lookup; other fields are filtered in memory.
   */
  where?: Partial<{ [K in keyof FieldsOf<N>]: FieldsOf<N>[K] }>;
  /** Extra in-memory filter. */
  filter?: (record: RecordOf<N>) => boolean;
  /** Sort comparator (e.g. `compareBySortKey`). Default: unspecified order. */
  sort?: (a: RecordOf<N>, b: RecordOf<N>) => number;
  limit?: number;
  includeDeleted?: boolean;
}

/** Read access for non-hook code (search providers, event handlers) and `useLiveData`. */
export interface DataReader {
  get<N extends CollectionName>(collection: N, id: string): Promise<RecordOf<N> | undefined>;
  list<N extends CollectionName>(collection: N, options?: QueryOptions<N>): Promise<RecordOf<N>[]>;
}

export interface DataWriter {
  /**
   * Create a record (new UUIDv7 unless `id` is given) or, if `id` exists, overwrite all its
   * domain fields. Fields with schema defaults may be omitted. Resolves with the stored record.
   */
  put<N extends CollectionName>(
    collection: N,
    values: FieldsInput<N>,
    options?: { id?: string },
  ): Promise<RecordOf<N>>;
  /** Change some fields of an existing record (each changed field gets a new HLC stamp). */
  patch<N extends CollectionName>(collection: N, id: string, changes: Partial<FieldsOf<N>>): Promise<RecordOf<N>>;
  /** Soft delete (tombstone). Undo with `restore`. */
  remove<N extends CollectionName>(collection: N, id: string): Promise<void>;
  restore<N extends CollectionName>(collection: N, id: string): Promise<void>;
  /** Apply several writes atomically (one IndexedDB transaction). */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

export interface SyncStatus {
  /**
   * offline: server unreachable (local edits still work)
   * idle: in sync; syncing: push/pull in progress
   * unauthenticated: session expired, sign-in needed to sync
   * error: last attempt failed (see `error`), will retry
   */
  state: 'offline' | 'idle' | 'syncing' | 'unauthenticated' | 'error';
  /** Local changes not yet accepted by the server. */
  pendingChanges: number;
  /** Local changes the server rejected (invalid, or clock too far ahead); they will not sync. */
  rejectedChanges: number;
  lastSyncedAt: string | null;
  error: string | null;
}
