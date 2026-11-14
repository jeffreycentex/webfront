import type { CollectionName, RecordEnvelope, SyncRecord } from '@webfront/shared';
import type { Db } from './database.js';

/**
 * Mapping between the generic `records` table (migrations/001_core.sql) and shared
 * `SyncRecord` objects. Owner after Task 1: Task 3 (sync).
 */

export interface RecordRow {
  collection: string;
  id: string;
  data: string;
  clocks: string;
  deleted: number;
  created_at: string;
  updated_at: string;
  seq: number;
}

const ENVELOPE = new Set(['id', 'createdAt', 'updatedAt', 'deleted', 'clocks']);

export function rowToRecord<T extends RecordEnvelope = SyncRecord>(row: RecordRow): T {
  const data = JSON.parse(row.data) as Record<string, unknown>;
  return {
    ...data,
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deleted: row.deleted === 1,
    clocks: JSON.parse(row.clocks) as Record<string, string>,
  } as unknown as T;
}

export function recordToRow(
  collection: CollectionName,
  record: RecordEnvelope,
  seq: number,
): RecordRow {
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) if (!ENVELOPE.has(k)) data[k] = v;
  return {
    collection,
    id: record.id,
    data: JSON.stringify(data),
    clocks: JSON.stringify(record.clocks),
    deleted: record.deleted ? 1 : 0,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    seq,
  };
}

export function readRecordRow(db: Db, collection: string, id: string): RecordRow | undefined {
  return db.get<RecordRow>('SELECT * FROM records WHERE collection = ? AND id = ?', collection, id);
}

/** Insert or replace the row for (collection, id). */
export function upsertRecordRow(db: Db, row: RecordRow): void {
  db.run(
    `INSERT INTO records (collection, id, data, clocks, deleted, created_at, updated_at, seq)
     VALUES (@collection, @id, @data, @clocks, @deleted, @created_at, @updated_at, @seq)
     ON CONFLICT (collection, id) DO UPDATE SET
       data = excluded.data, clocks = excluded.clocks, deleted = excluded.deleted,
       created_at = excluded.created_at, updated_at = excluded.updated_at, seq = excluded.seq`,
    { ...row },
  );
}
