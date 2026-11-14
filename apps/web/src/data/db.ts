import Dexie from 'dexie';
import {
  listCollections,
  type CollectionName,
  type FieldChange,
  type HlcString,
} from '@webfront/shared';

/**
 * The local IndexedDB database (Dexie). One object store per registry collection, keyed by
 * `id`, with `updatedAt` plus the registry's `indexes`, and three internal stores:
 *
 * - `_outbox`   one entry per record with local field writes not yet accepted by the server
 *               (`&[collection+id]` is unique, so repeated edits coalesce per field).
 * - `_meta`     key/value: `local` (clientId + persisted HLC), `cursor`, `serverId`, `status`.
 * - `_rejected` changes the server rejected (kept for diagnostics; surfaced as a count).
 *
 * Schema evolution: stores and indexes are derived from `listCollections()`. When the
 * registry gains a collection or index, bump `DB_VERSION`. (Dexie 4 also patches a schema that
 * was extended without a bump, with a console warning, so a forgotten bump is not fatal.)
 */

export const DB_NAME = 'webfront';
export const DB_VERSION = 1;

export const OUTBOX = '_outbox';
export const META = '_meta';
export const REJECTED = '_rejected';
export const INTERNAL_STORES = [OUTBOX, META, REJECTED] as const;

export interface OutboxEntry {
  /** Auto-increment; FIFO order of the first pending write to the record. */
  seq?: number;
  collection: CollectionName;
  id: string;
  createdAt: string;
  /** Pending field writes (value + HLC). Only the newest write per field is kept. */
  fields: Record<string, FieldChange>;
  /**
   * Per pending field: the stamp the field had locally when it was first edited (or the
   * latest remote stamp merged into it since). A pulled stamp different from both this and
   * the pending stamp means someone else edited the field concurrently. Missing = unknown.
   */
  baseClocks?: Record<string, HlcString>;
}

export interface RejectedEntry {
  key?: number;
  collection: CollectionName;
  id: string;
  code: string;
  error: string;
  fields: Record<string, FieldChange>;
  at: string;
}

export interface MetaEntry<T = unknown> {
  key: string;
  value: T;
}

/** Dexie store definitions derived from the collection registry. */
export function storeSchema(): Record<string, string> {
  const stores: Record<string, string> = {};
  for (const def of listCollections()) {
    const extra = def.indexes.filter((i) => i !== 'id' && i !== 'updatedAt');
    stores[def.name] = ['id', 'updatedAt', ...extra].join(', ');
  }
  stores[OUTBOX] = '++seq, &[collection+id]';
  stores[META] = 'key';
  stores[REJECTED] = '++key, collection';
  return stores;
}

export function createDatabase(name: string = DB_NAME): Dexie {
  const db = new Dexie(name);
  db.version(DB_VERSION).stores(storeSchema());
  return db;
}

/** Names of the plain (non-compound, non-multi-entry) indexes of a collection store. */
export function simpleIndexes(collection: CollectionName): Set<string> {
  const def = listCollections().find((c) => c.name === collection);
  const out = new Set<string>(['id', 'updatedAt']);
  for (const i of def?.indexes ?? []) if (!i.startsWith('[') && !i.startsWith('*')) out.add(i);
  return out;
}
