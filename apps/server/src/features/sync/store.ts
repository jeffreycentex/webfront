import {
  HlcClock,
  MAX_CLOCK_DRIFT_MS,
  applyLocalEdit,
  changeToPartialRecord,
  collections,
  isClockedKey,
  isCollectionName,
  isHlcString,
  isValidRecordId,
  mergeRecordDetailed,
  parseHlc,
  validateFieldValue,
  valuesEqual,
  type CollectionName,
  type FieldChange,
  type HlcString,
  type PulledRecord,
  type PushResult,
  type RecordChange,
  type RecordOf,
  type SyncRecord,
} from '@webfront/shared';
import type { RecordStore, ServerWrite } from '../../context.js';
import type { Db } from '../../db/database.js';
import {
  readRecordRow,
  recordToRow,
  rowToRecord,
  upsertRecordRow,
  type RecordRow,
} from '../../db/recordRows.js';
import type { EventBus } from '../../events.js';
import type { Logger } from '../../logger.js';

/**
 * Server-side record store (implements `RecordStore` from context.ts).
 *
 * Invariants
 * - Every accepted write runs inside one SQLite transaction that also bumps
 *   `meta.records_seq`, so a record's `seq` and the counter can never disagree.
 * - `seq` only increases. A record's row carries the seq of its latest accepted change, so a
 *   client that pulled up to cursor N sees every record changed after N exactly once more.
 * - Merges are per-field LWW (`mergeRecordDetailed`); a push that changes nothing (a replay, or
 *   every field lost to newer stamps) gets `unchanged` and no seq.
 * - The server's HLC observes every accepted stamp, so `writeAsServer` stamps are newer than
 *   anything already stored.
 */

export interface RecordStoreDeps {
  db: Db;
  events: EventBus;
  logger: Logger;
  /** Clock source (tests). Defaults to Date.now. */
  now?: () => number;
}

export interface ServerRecordStore extends RecordStore {
  /** HLC node id used for server-originated writes (16 hex chars). */
  readonly serverNodeId: string;
  /**
   * The restore marker (`meta.sync_epoch`, 32 hex chars), read from the database on every call
   * so it always describes the database actually being served. See `api/sync.ts`.
   */
  epoch(): string;
}

/** `meta` key of the restore marker. `deploy/restore.sh` writes the same key. */
export const SYNC_EPOCH_KEY = 'sync_epoch';
const EPOCH_PATTERN = /^[0-9a-f]{32}$/;

type Rejection = Extract<PushResult, { status: 'rejected' }>;

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export function createRecordStore(deps: RecordStoreDeps): ServerRecordStore {
  const { db, events } = deps;
  const logger = deps.logger.child({ component: 'records' });
  const now = deps.now ?? Date.now;

  const metaGet = (key: string): string | undefined =>
    db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value;
  const metaSet = (key: string, value: string): void => {
    db.run(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value,
    );
  };

  const serverId = (): string => {
    const id = metaGet('server_id');
    if (!id) throw new Error('meta.server_id is missing');
    return id;
  };

  // The server's HLC node id is derived from server_id (first 16 hex chars), so it needs no
  // extra state and changes together with server_id when a database is replaced.
  const serverNodeId = serverId()
    .replace(/[^0-9a-f]/g, '')
    .padEnd(16, '0')
    .slice(0, 16);

  const lastHlc = metaGet('server_hlc');
  const clock = new HlcClock(serverNodeId, {
    now,
    ...(lastHlc && isHlcString(lastHlc) ? { last: lastHlc } : {}),
  });

  const maxSeq = (): number => Number(metaGet('records_seq') ?? '0');

  // Migration 020 creates the epoch; this covers a row deleted or mangled by hand. A missing
  // or invalid marker is treated like a restore (a fresh value), never silently adopted.
  db.transaction(() => {
    const current = metaGet(SYNC_EPOCH_KEY);
    if (current === undefined || !EPOCH_PATTERN.test(current)) {
      db.run(
        `INSERT INTO meta (key, value) VALUES (?, lower(hex(randomblob(16))))
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        SYNC_EPOCH_KEY,
      );
      logger.warn('meta.sync_epoch was missing or invalid; wrote a new one', {
        hadValue: current !== undefined,
      });
    }
  });

  const epoch = (): string => {
    const value = metaGet(SYNC_EPOCH_KEY);
    if (!value || !EPOCH_PATTERN.test(value)) throw new Error('meta.sync_epoch is missing');
    return value;
  };

  // Self-heal: records_seq must never be below a seq already in use (unique index on seq).
  db.transaction(() => {
    const top = db.get<{ m: number | null }>('SELECT MAX(seq) AS m FROM records')?.m ?? 0;
    if (top > maxSeq()) {
      logger.warn('records_seq was behind MAX(seq); repaired', { recordsSeq: maxSeq(), top });
      metaSet('records_seq', String(top));
    }
  });

  const nextSeq = (): number => {
    const next = maxSeq() + 1;
    metaSet('records_seq', String(next));
    return next;
  };

  /** Advance the server clock past the newest stamp in `clocks`. */
  const observe = (clocks: Record<string, string>): void => {
    let max: string | undefined;
    for (const c of Object.values(clocks)) if (max === undefined || c > max) max = c;
    if (max !== undefined && max > clock.current) clock.receive(max);
  };

  const load = (collection: CollectionName, id: string): SyncRecord | undefined => {
    const row = readRecordRow(db, collection, id);
    return row ? rowToRecord(row) : undefined;
  };

  const store = (collection: CollectionName, record: SyncRecord): number => {
    const seq = nextSeq();
    upsertRecordRow(db, recordToRow(collection, record, seq));
    return seq;
  };

  const emitChanged = (touched: Set<CollectionName>, originClientId: string | null): void => {
    if (touched.size === 0) return;
    events.emit('records.changed', {
      maxSeq: maxSeq(),
      collections: [...touched],
      originClientId,
    });
  };

  /** Validate and merge one change. Must run inside a transaction. */
  const applyOne = (change: RecordChange, touched: Set<CollectionName>): PushResult => {
    const { collection, id } = change;
    const reject = (code: string, error: string): Rejection => ({
      collection,
      id,
      status: 'rejected',
      code,
      error,
    });

    const def = collections[collection];
    if (!def.writable) return reject('read_only', `${collection} is read-only for clients`);
    if (!isValidRecordId(collection, id))
      return reject('invalid_id', `invalid id for ${collection}`);

    const entries = Object.entries(change.fields);
    if (entries.length === 0) return reject('empty_change', 'change has no fields');

    const nowMs = now();
    const fields: Record<string, FieldChange> = {};
    for (const [key, fc] of entries) {
      if (!isClockedKey(key)) return reject('unknown_field', `${key} cannot be written`);
      if (fc.value === undefined)
        return reject('invalid_value', `${collection}.${key}: missing value`);
      const checked = validateFieldValue(collection, key, fc.value);
      if (!checked.ok) {
        const unknown = !hasOwn(def.fields.shape, key) && key !== 'deleted';
        return reject(unknown ? 'unknown_field' : 'invalid_value', checked.error);
      }
      const wall = parseHlc(fc.hlc).wall;
      if (wall - nowMs > MAX_CLOCK_DRIFT_MS) {
        return reject(
          'clock_drift',
          `${collection}.${key}: clock is ${Math.round((wall - nowMs) / 1000)}s ahead of the server`,
        );
      }
      // Store the parsed (normalised) value; clients normalise with the same schemas.
      fields[key] = { value: checked.value, hlc: fc.hlc };
    }

    const partial = changeToPartialRecord({ id, createdAt: change.createdAt, fields });
    const existing = load(collection, id);
    const { record: merged, changedFields } = mergeRecordDetailed(existing, partial);
    if (existing && changedFields.length === 0) {
      return { collection, id, status: 'unchanged' };
    }

    const parsed = def.schema.safeParse(merged);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(record)'}: ${i.message}`)
        .join('; ');
      return existing
        ? reject('invalid_record', `merged record is invalid: ${detail}`)
        : reject('incomplete_record', `new record is incomplete or invalid: ${detail}`);
    }

    const record = { ...(parsed.data as unknown as SyncRecord), clocks: merged.clocks };
    observe(partial.clocks);
    const seq = store(collection, record);
    touched.add(collection);
    return { collection, id, status: 'applied', seq };
  };

  const applyChanges: RecordStore['applyChanges'] = (changes, originClientId) => {
    const touched = new Set<CollectionName>();
    const results = db.transaction(() => {
      const out = changes.map((change) => applyOne(change, touched));
      if (touched.size > 0) metaSet('server_hlc', clock.current);
      return out;
    });
    emitChanged(touched, originClientId);
    return results;
  };

  const writeAsServer = <N extends CollectionName>(
    collection: N,
    writes: ServerWrite<N>[],
  ): number => {
    const def = collections[collection];
    const shape = def.fields.shape as Record<string, unknown>;
    const touched = new Set<CollectionName>();
    let count = 0;

    db.transaction(() => {
      for (const write of writes) {
        if (!isValidRecordId(collection, write.id)) {
          throw new Error(`writeAsServer: invalid id for ${collection}: ${write.id}`);
        }
        const input = write.fields as Record<string, unknown>;
        for (const key of Object.keys(input)) {
          if (key !== 'deleted' && !hasOwn(shape, key)) {
            throw new Error(`writeAsServer: unknown field ${collection}.${key}`);
          }
        }

        const existing = load(collection, write.id);
        let values: Record<string, unknown>;
        if (!existing) {
          const { deleted, ...domain } = input;
          if (deleted !== undefined && typeof deleted !== 'boolean') {
            throw new Error('writeAsServer: deleted must be boolean');
          }
          values = { ...def.fields.parse(domain), deleted: deleted ?? false };
        } else {
          values = {};
          const ex = existing as Record<string, unknown>;
          for (const [key, raw] of Object.entries(input)) {
            if (raw === undefined) continue;
            const checked = validateFieldValue(collection, key, raw);
            if (!checked.ok) throw new Error(`writeAsServer: ${checked.error}`);
            if (!hasOwn(ex, key) || !valuesEqual(ex[key], checked.value))
              values[key] = checked.value;
          }
          if (Object.keys(values).length === 0) continue;
          observe(existing.clocks);
        }

        const hlc: HlcString = clock.tick();
        const nowIso = new Date(now()).toISOString();
        const { record } = applyLocalEdit<SyncRecord>(existing, write.id, values, hlc, nowIso);
        const parsed = def.schema.parse(record) as unknown as SyncRecord;
        store(collection, { ...parsed, clocks: record.clocks });
        touched.add(collection);
        count++;
      }
      if (count > 0) metaSet('server_hlc', clock.current);
    });

    emitChanged(touched, null);
    return count;
  };

  const parseRow = <N extends CollectionName>(
    collection: N,
    row: RecordRow,
  ): RecordOf<N> | undefined => {
    const parsed = collections[collection].schema.safeParse(rowToRecord(row));
    if (!parsed.success) {
      logger.warn('stored record failed validation', { collection, id: row.id });
      return undefined;
    }
    // Keep the stored clocks object as-is (parse only fills defaults for newer fields).
    return parsed.data as unknown as RecordOf<N>;
  };

  return {
    serverNodeId,
    serverId,
    epoch,
    maxSeq,
    applyChanges,
    writeAsServer,
    get(collection, id) {
      const row = readRecordRow(db, collection, id);
      return row ? parseRow(collection, row) : undefined;
    },
    list(collection, options = {}) {
      const rows = options.includeDeleted
        ? db.all<RecordRow>('SELECT * FROM records WHERE collection = ? ORDER BY seq', collection)
        : db.all<RecordRow>(
            'SELECT * FROM records WHERE collection = ? AND deleted = 0 ORDER BY seq',
            collection,
          );
      const out: RecordOf<typeof collection>[] = [];
      for (const row of rows) {
        const rec = parseRow(collection, row);
        if (rec) out.push(rec);
      }
      return out;
    },
    pull(since, limit) {
      const rows = db.all<RecordRow>(
        'SELECT * FROM records WHERE seq > ? ORDER BY seq LIMIT ?',
        since,
        limit + 1,
      );
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const records: PulledRecord[] = [];
      for (const row of page) {
        // Rows of collections no longer in the registry are skipped but still advance the cursor.
        if (!isCollectionName(row.collection)) continue;
        records.push({ collection: row.collection, seq: row.seq, record: rowToRecord(row) });
      }
      const last = page[page.length - 1];
      return { records, cursor: last ? last.seq : since, hasMore };
    },
  };
}
