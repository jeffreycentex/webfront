import type Dexie from 'dexie';
import type { z } from 'zod';
import {
  CLIENT_ID_PATTERN,
  HLC_ZERO,
  HlcClock,
  applyLocalEdit,
  collections,
  isCollectionName,
  isValidRecordId,
  listCollections,
  mergeRecordDetailed,
  newClientId,
  newId,
  recordToChangeFields,
  stableStringify,
  validateFieldValue,
  valuesEqual,
  type CollectionName,
  type FieldChange,
  type FieldResolver,
  type FieldsInput,
  type FieldsOf,
  type HlcString,
  type PullResponse,
  type PushResult,
  type RecordChange,
  type RecordOf,
  type SyncRecord,
} from '@webfront/shared';
import {
  INTERNAL_STORES,
  META,
  OUTBOX,
  REJECTED,
  simpleIndexes,
  type MetaEntry,
  type OutboxEntry,
  type RejectedEntry,
} from './db';
import type { QueryOptions, SyncStatus } from './types';

/**
 * Local data store: every read and write the UI makes, plus the outbox/pull primitives the
 * sync engine uses. Pure IndexedDB (no network), so it is fully usable offline.
 *
 * Write path (put/patch/remove/restore), all in ONE IndexedDB transaction:
 *   validate with the shared schema → tick the persisted HLC → update the record →
 *   merge the stamped fields into the record's outbox entry → persist the HLC.
 * Only fields whose value actually changes are stamped, so writing an unchanged form never
 * overrides a concurrent edit made on another device.
 *
 * Methods await only Dexie promises, so they are safe inside Dexie transactions and
 * `liveQuery` (do not add `await fetch(...)` or timers here).
 */

export interface LocalIdentity {
  clientId: string;
  hlc: HlcString | null;
}

/** Persisted part of the sync status (the counts are computed live). */
export interface PersistedStatus {
  state: SyncStatus['state'];
  lastSyncedAt: string | null;
  error: string | null;
}

export const DEFAULT_STATUS: PersistedStatus = { state: 'offline', lastSyncedAt: null, error: null };

export interface ResolverHelpers {
  /** A fresh local HLC stamp, for resolvers that produce a genuinely new value (e.g. a text merge). */
  tick(): HlcString;
  clientId: string;
}

/**
 * Per-collection field resolvers used when merging pulled records (see `FieldResolver` in
 * shared `record.ts`). Either a map or a factory that receives helpers.
 */
export type FieldResolverSource =
  | Record<string, FieldResolver>
  | ((helpers: ResolverHelpers) => Record<string, FieldResolver>);

/** Arguments of a record resolver (see `registerRecordResolver`). */
export interface RecordResolverArgs<N extends CollectionName = CollectionName> {
  collection: N;
  /** The local record before this pull (includes the pending local edits). */
  local: RecordOf<N>;
  /** The pulled server record. */
  remote: RecordOf<N>;
  /** Plain per-field LWW result (after any field resolvers). Written if you return nothing. */
  merged: RecordOf<N>;
  /** This record's local writes not yet accepted by the server (field -> value + HLC). */
  pendingFields: Record<string, FieldChange>;
  /**
   * Pending fields the remote changed concurrently: the remote stamp is neither the stamp the
   * local edit was based on nor one minted by this replica. Non-empty whenever the resolver
   * is called. Each one may have won or
   * lost LWW: compare `merged[f]` with `pendingFields[f].value`.
   */
  conflictFields: string[];
  /** A fresh local HLC stamp (returned fields are stamped automatically; rarely needed). */
  tick(): HlcString;
  clientId: string;
}

/**
 * Record-level merge hook. Return the fields to set on top of `merged` (validated, stamped
 * with ONE fresh local HLC, stored and queued for push in the pull's IndexedDB transaction),
 * or undefined / {} to keep `merged` as is. Must be synchronous and deterministic enough
 * for its inputs; it must not touch IndexedDB.
 */
export type RecordResolver<N extends CollectionName = CollectionName> = (
  args: RecordResolverArgs<N>,
) => Partial<FieldsOf<N>> | undefined | void;

export class DataError extends Error {
  constructor(
    readonly code: 'not_found' | 'read_only' | 'invalid_id' | 'invalid_field',
    message: string,
  ) {
    super(message);
    this.name = 'DataError';
  }
}

type AnyRecord = SyncRecord & Record<string, unknown>;

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function maxClock(clocks: Record<string, string>): string | undefined {
  let max: string | undefined;
  for (const c of Object.values(clocks)) if (max === undefined || c > max) max = c;
  return max;
}

/** Advance `clock` past every stamp in `clocks` (so later local writes win over them). */
function observe(clock: HlcClock, clocks: Record<string, string>): void {
  const max = maxClock(clocks);
  if (max !== undefined && max > clock.current) clock.receive(max);
}

function isIndexable(value: unknown): boolean {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

/** Default value of every domain field that has one (fills records written by older schemas). */
const DEFAULTS = new Map<CollectionName, Array<[string, unknown]>>();
for (const def of listCollections()) {
  const out: Array<[string, unknown]> = [];
  for (const [key, schema] of Object.entries(def.fields.shape)) {
    const r = (schema as z.ZodType).safeParse(undefined);
    if (r.success) out.push([key, r.data]);
  }
  DEFAULTS.set(def.name, out);
}

function withDefaults<T extends AnyRecord>(collection: CollectionName, record: T): T {
  const defaults = DEFAULTS.get(collection) ?? [];
  let out: T | undefined;
  for (const [key, value] of defaults) {
    if (!hasOwn(record, key)) {
      out ??= { ...record };
      (out as Record<string, unknown>)[key] = structuredClone(value);
    }
  }
  return out ?? record;
}

/** The entries of `clocks` whose keys are in `fields`. */
function pick(
  clocks: Record<string, HlcString> | undefined,
  fields: Record<string, unknown>,
): Record<string, HlcString> {
  const out: Record<string, HlcString> = {};
  for (const [k, c] of Object.entries(clocks ?? {})) if (hasOwn(fields, k)) out[k] = c;
  return out;
}

/** Rough JSON size of a change, for batching. */
function changeSize(entry: OutboxEntry): number {
  let n = 100;
  for (const [k, fc] of Object.entries(entry.fields)) {
    n += k.length + 40;
    const v = fc.value;
    n += typeof v === 'string' ? v.length : stableStringify(v).length;
  }
  return n;
}

export function outboxEntryToChange(entry: OutboxEntry): RecordChange {
  return {
    collection: entry.collection,
    id: entry.id,
    createdAt: entry.createdAt,
    fields: entry.fields,
  };
}

export interface LocalStoreOptions {
  /** Clock source (tests). */
  now?: () => number;
}

export class LocalStore {
  private readonly now: () => number;
  private readonly resolvers = new Map<CollectionName, FieldResolverSource>();
  private readonly recordResolvers = new Map<CollectionName, RecordResolver>();
  private readonly writeListeners = new Set<() => void>();
  private readonly pullListeners = new Set<(collections: CollectionName[]) => void>();

  constructor(
    readonly db: Dexie,
    options: LocalStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  /* ---------------------------------------------------------------- tables and metadata */

  allTables(): string[] {
    return [...listCollections().map((c) => c.name), ...INTERNAL_STORES];
  }

  private table(name: string) {
    return this.db.table(name);
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    const row = (await this.table(META).get(key)) as MetaEntry<T> | undefined;
    return row?.value;
  }

  async setMeta<T>(key: string, value: T): Promise<void> {
    await this.table(META).put({ key, value } satisfies MetaEntry<T>);
  }

  /** Load the persisted clock (creating the client id on first use). Call inside a rw tx. */
  private async loadClock(): Promise<HlcClock> {
    let identity = await this.getMeta<LocalIdentity>('local');
    if (!identity || !CLIENT_ID_PATTERN.test(identity.clientId)) {
      identity = { clientId: newClientId(), hlc: null };
      await this.setMeta('local', identity);
    }
    return new HlcClock(identity.clientId, {
      now: this.now,
      ...(identity.hlc ? { last: identity.hlc } : {}),
    });
  }

  private async saveClock(clock: HlcClock): Promise<void> {
    await this.setMeta<LocalIdentity>('local', { clientId: clock.node, hlc: clock.current });
  }

  /** This replica's client id (16 hex chars, also its HLC node id). */
  async clientId(): Promise<string> {
    return this.db.transaction('rw', [META], async () => (await this.loadClock()).node);
  }

  async cursor(): Promise<number> {
    return (await this.getMeta<number>('cursor')) ?? 0;
  }

  async knownServerId(): Promise<string | null> {
    return (await this.getMeta<string>('serverId')) ?? null;
  }

  async rememberServerId(serverId: string): Promise<void> {
    await this.setMeta('serverId', serverId);
  }

  async readStatus(): Promise<SyncStatus> {
    const persisted = (await this.getMeta<PersistedStatus>('status')) ?? DEFAULT_STATUS;
    const [pendingChanges, rejectedChanges] = await Promise.all([
      this.table(OUTBOX).count(),
      this.table(REJECTED).count(),
    ]);
    return { ...DEFAULT_STATUS, ...persisted, pendingChanges, rejectedChanges };
  }

  async writeStatus(status: PersistedStatus): Promise<void> {
    await this.setMeta('status', status);
  }

  /* ---------------------------------------------------------------------------- reads */

  async getRaw(collection: CollectionName, id: string): Promise<AnyRecord | undefined> {
    const rec = (await this.table(collection).get(id)) as AnyRecord | undefined;
    return rec ? withDefaults(collection, rec) : undefined;
  }

  /** A live record (tombstones hidden unless `includeDeleted`). */
  async get<N extends CollectionName>(
    collection: N,
    id: string,
    options: { includeDeleted?: boolean } = {},
  ): Promise<RecordOf<N> | undefined> {
    const rec = await this.getRaw(collection, id);
    if (!rec || (rec.deleted && !options.includeDeleted)) return undefined;
    return rec as unknown as RecordOf<N>;
  }

  async list<N extends CollectionName>(
    collection: N,
    options: QueryOptions<N> = {},
  ): Promise<RecordOf<N>[]> {
    const where = Object.entries((options.where ?? {}) as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    const indexes = simpleIndexes(collection);
    const indexed = where.find(([k, v]) => indexes.has(k) && isIndexable(v));
    const table = this.table(collection);
    const rows = (
      indexed ? await table.where(indexed[0]).equals(indexed[1] as string).toArray() : await table.toArray()
    ) as AnyRecord[];

    let out: AnyRecord[] = [];
    for (const raw of rows) {
      if (raw.deleted && !options.includeDeleted) continue;
      const rec = withDefaults(collection, raw);
      if (!where.every(([k, v]) => valuesEqual(rec[k], v))) continue;
      if (options.filter && !options.filter(rec as unknown as RecordOf<N>)) continue;
      out.push(rec);
    }
    if (options.sort) {
      const sort = options.sort;
      out.sort((a, b) => sort(a as unknown as RecordOf<N>, b as unknown as RecordOf<N>));
    }
    if (options.limit !== undefined) out = out.slice(0, Math.max(0, options.limit));
    return out as unknown as RecordOf<N>[];
  }

  /* --------------------------------------------------------------------------- writes */

  /** Called after a pulled page is durably stored, with the collections that changed. */
  onPullApplied(fn: (collections: CollectionName[]) => void): () => void {
    this.pullListeners.add(fn);
    return () => this.pullListeners.delete(fn);
  }

  private emitPullApplied(names: CollectionName[]): void {
    for (const fn of [...this.pullListeners]) {
      try {
        fn(names);
      } catch (err) {
        console.warn('@/data: pull listener threw', err);
      }
    }
  }

  onLocalWrite(fn: () => void): () => void {
    this.writeListeners.add(fn);
    return () => this.writeListeners.delete(fn);
  }

  private emitLocalWrite(): void {
    for (const fn of [...this.writeListeners]) {
      try {
        fn();
      } catch (err) {
        console.error('@/data: write listener failed', err);
      }
    }
  }

  private assertWritable(collection: CollectionName): void {
    if (!hasOwn(collections, collection)) {
      throw new DataError('invalid_field', `unknown collection ${String(collection)}`);
    }
    if (!collections[collection].writable) {
      throw new DataError('read_only', `${collection} is read-only (server-owned)`);
    }
  }

  /**
   * Core write: `build(existing)` returns the desired values of the fields to write
   * (already validated). Fields whose value equals the stored one are skipped; the rest are
   * stamped with one fresh HLC and queued, atomically.
   */
  private async write(
    collection: CollectionName,
    id: string,
    build: (existing: AnyRecord | undefined) => Record<string, unknown>,
  ): Promise<AnyRecord> {
    const def = collections[collection];
    const stored = await this.db.transaction('rw', [collection, OUTBOX, META], async () => {
      const table = this.table(collection);
      const raw = (await table.get(id)) as AnyRecord | undefined;
      const existing = raw ? withDefaults(collection, raw) : undefined;
      const desired = build(existing);

      let values: Record<string, unknown> = desired;
      if (existing) {
        values = {};
        for (const [k, v] of Object.entries(desired)) {
          if (!hasOwn(existing, k) || !valuesEqual(existing[k], v)) values[k] = v;
        }
        if (Object.keys(values).length === 0) return existing;
      }

      const clock = await this.loadClock();
      if (existing) observe(clock, existing.clocks);
      const hlc = clock.tick();
      const nowIso = new Date(this.now()).toISOString();
      const { record, fields } = applyLocalEdit<AnyRecord>(existing, id, values, hlc, nowIso);
      const parsed = def.schema.parse(record) as unknown as AnyRecord;
      const next = { ...parsed, clocks: record.clocks } as AnyRecord;

      await table.put(next);
      await this.enqueue(collection, id, next.createdAt, fields, existing?.clocks);
      await this.saveClock(clock);
      return next;
    });
    this.emitLocalWrite();
    return stored;
  }

  /** Merge field writes into the record's outbox entry (newest stamp per field wins). */
  private async enqueue(
    collection: CollectionName,
    id: string,
    createdAt: string,
    fields: Record<string, FieldChange>,
    /** The record's clocks before these writes (become the base of newly pending fields). */
    priorClocks?: Record<string, string>,
  ): Promise<void> {
    if (Object.keys(fields).length === 0) return;
    const outbox = this.table(OUTBOX);
    const cur = (await outbox.where('[collection+id]').equals([collection, id]).first()) as
      | OutboxEntry
      | undefined;
    const merged: Record<string, FieldChange> = { ...cur?.fields };
    const baseClocks: Record<string, HlcString> = { ...cur?.baseClocks };
    for (const [k, fc] of Object.entries(fields)) {
      const prev = merged[k];
      if (!prev) {
        const base = priorClocks?.[k];
        if (base !== undefined) baseClocks[k] = base;
      }
      if (!prev || fc.hlc > prev.hlc) merged[k] = fc;
    }
    if (!cur) {
      await outbox.add({ collection, id, createdAt, fields: merged, baseClocks } satisfies OutboxEntry);
      return;
    }
    await outbox.put({
      ...cur,
      createdAt: cur.createdAt <= createdAt ? cur.createdAt : createdAt,
      fields: merged,
      baseClocks,
    } satisfies OutboxEntry);
  }

  async put<N extends CollectionName>(
    collection: N,
    values: FieldsInput<N>,
    options: { id?: string } = {},
  ): Promise<RecordOf<N>> {
    this.assertWritable(collection);
    const def = collections[collection];
    let id = options.id;
    if (id === undefined) {
      if (def.idKind !== 'uuid') {
        throw new DataError('invalid_id', `${collection} records need an explicit id (key)`);
      }
      id = newId(this.now());
    }
    if (!isValidRecordId(collection, id)) {
      throw new DataError('invalid_id', `invalid id for ${collection}: ${id}`);
    }
    // Validate and normalise every domain field (fills defaults); throws ZodError.
    const parsed = def.fields.parse(values) as Record<string, unknown>;
    const rec = await this.write(collection, id, (existing) =>
      existing?.deleted ? { ...parsed, deleted: false } : parsed,
    );
    return rec as unknown as RecordOf<N>;
  }

  async patch<N extends CollectionName>(
    collection: N,
    id: string,
    changes: Partial<FieldsOf<N>>,
  ): Promise<RecordOf<N>> {
    this.assertWritable(collection);
    const shape = collections[collection].fields.shape as Record<string, unknown>;
    const values: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(changes as Record<string, unknown>)) {
      if (v === undefined) continue;
      if (!hasOwn(shape, k)) {
        throw new DataError('invalid_field', `${collection}.${k} is not a writable field`);
      }
      const checked = validateFieldValue(collection, k, v);
      if (!checked.ok) throw new DataError('invalid_field', checked.error);
      values[k] = checked.value;
    }
    const rec = await this.write(collection, id, (existing) => {
      if (!existing) throw new DataError('not_found', `${collection}/${id} not found`);
      return values;
    });
    return rec as unknown as RecordOf<N>;
  }

  private async setDeleted(collection: CollectionName, id: string, deleted: boolean) {
    this.assertWritable(collection);
    await this.write(collection, id, (existing) => {
      if (!existing) throw new DataError('not_found', `${collection}/${id} not found`);
      return { deleted };
    });
  }

  async remove(collection: CollectionName, id: string): Promise<void> {
    await this.setDeleted(collection, id, true);
  }

  async restore(collection: CollectionName, id: string): Promise<void> {
    await this.setDeleted(collection, id, false);
  }

  /** Run `fn` in one rw transaction over every store: its writes commit or roll back together. */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    // Dexie only keeps its transaction zone alive across native `await`s when the scope function
    // is itself an `async function` (it detects that by the function's type). A plain arrow
    // returning a native promise (`() => helper()`) therefore committed early with
    // PrematureCommitError. Wrapping in an async function makes every caller shape safe.
    return this.db.transaction('rw', this.allTables(), async () => await fn());
  }

  /* ------------------------------------------------------------------------- resolvers */

  registerRecordResolver<N extends CollectionName>(
    collection: N,
    resolver: RecordResolver<N> | null,
  ): void {
    if (resolver) this.recordResolvers.set(collection, resolver as unknown as RecordResolver);
    else this.recordResolvers.delete(collection);
  }

  registerFieldResolvers(collection: CollectionName, source: FieldResolverSource | null): void {
    if (source) this.resolvers.set(collection, source);
    else this.resolvers.delete(collection);
  }

  private resolversFor(
    collection: CollectionName,
    clock: HlcClock,
  ): Record<string, FieldResolver> | undefined {
    const source = this.resolvers.get(collection);
    if (!source) return undefined;
    return typeof source === 'function'
      ? source({ tick: () => clock.tick(), clientId: clock.node })
      : source;
  }

  /* ------------------------------------------------------------------------ outbox / sync */

  /** Oldest outbox entries, capped by count and approximate payload size (at least one). */
  async outboxBatch(maxChanges: number, maxBytes: number): Promise<OutboxEntry[]> {
    const entries = (await this.table(OUTBOX).orderBy('seq').limit(maxChanges).toArray()) as OutboxEntry[];
    const out: OutboxEntry[] = [];
    let bytes = 0;
    for (const e of entries) {
      const size = changeSize(e);
      if (out.length > 0 && bytes + size > maxBytes) break;
      out.push(e);
      bytes += size;
    }
    return out;
  }

  async pendingCount(): Promise<number> {
    return this.table(OUTBOX).count();
  }

  /**
   * Apply push results. For each sent entry, remove exactly the field writes that were sent
   * (same field AND same stamp): writes made while the push was in flight stay queued.
   * Rejected writes are moved to `_rejected` so they never block the queue.
   * Returns how many sent entries had a matching result (0 means the response did not match).
   */
  async ackPush(sent: OutboxEntry[], results: PushResult[]): Promise<number> {
    const byKey = new Map(results.map((r) => [`${r.collection}\u0000${r.id}`, r]));
    let matched = 0;
    await this.db.transaction('rw', this.allTables(), async () => {
      const outbox = this.table(OUTBOX);
      for (const s of sent) {
        const result = byKey.get(`${s.collection}\u0000${s.id}`);
        if (!result) continue;
        matched++;
        const cur = (await outbox.where('[collection+id]').equals([s.collection, s.id]).first()) as
          | OutboxEntry
          | undefined;
        if (!cur) continue;

        let keep: Record<string, FieldChange> = {};
        for (const [k, fc] of Object.entries(cur.fields)) {
          if (s.fields[k]?.hlc !== fc.hlc) keep[k] = fc;
        }

        if (result.status === 'rejected') {
          const whole =
            result.code === 'incomplete_record' ? await this.wholeRecordFields(s) : undefined;
          if (whole) {
            // The server lacks this record (e.g. its database was restored): send all of it.
            keep = { ...whole, ...keep };
          } else {
            await this.table(REJECTED).add({
              collection: s.collection,
              id: s.id,
              code: result.code,
              error: result.error,
              fields: s.fields,
              at: new Date(this.now()).toISOString(),
            } satisfies RejectedEntry);
            console.warn(`@/data: server rejected ${s.collection}/${s.id}: ${result.error}`);
          }
        }

        if (Object.keys(keep).length === 0) await outbox.delete(cur.seq!);
        else await outbox.put({ ...cur, fields: keep, baseClocks: pick(cur.baseClocks, keep) });
      }
    });
    return matched;
  }

  /**
   * Every field of the local record as a change, or undefined when the rejected change
   * already contained all of them (then the rejection is genuine and retrying cannot help).
   */
  private async wholeRecordFields(
    sent: OutboxEntry,
  ): Promise<Record<string, FieldChange> | undefined> {
    const rec = await this.getRaw(sent.collection, sent.id);
    if (!rec) return undefined;
    const all = recordToChangeFields(rec);
    if (Object.keys(all).every((k) => hasOwn(sent.fields, k))) return undefined;
    return all;
  }

  /**
   * Merge one pulled page into local records and advance the cursor, atomically.
   * Local field writes still in the outbox are kept when their stamp is newer (they are part
   * of the local record, and the merge is per-field LWW); queued writes that lost to a newer
   * remote stamp are dropped from the outbox. Values produced by a field resolver with a new
   * stamp are queued for push.
   * Returns the number of records that failed validation (skipped).
   */
  async applyPull(
    page: PullResponse,
  ): Promise<{ changed: number; invalid: number; unknown: number }> {
    const valid: Array<{ collection: CollectionName; record: AnyRecord }> = [];
    let invalid = 0;
    let unknown = 0;
    for (const p of page.records) {
      // A collection this (older) client does not know: skip it, the cursor still advances.
      if (!isCollectionName(p.collection)) {
        unknown++;
        continue;
      }
      const parsed = collections[p.collection].schema.safeParse(p.record);
      if (!parsed.success) {
        invalid++;
        console.warn(`@/data: skipped invalid pulled record ${p.collection}/${p.record.id}`);
        continue;
      }
      const rec = parsed.data as unknown as AnyRecord;
      valid.push({ collection: p.collection, record: { ...rec, clocks: { ...p.record.clocks } } });
    }

    let changed = 0;
    const changedCollections = new Set<CollectionName>();
    await this.db.transaction('rw', this.allTables(), async () => {
      changed = 0;
      changedCollections.clear();
      const clock = await this.loadClock();
      for (const { record } of valid) observe(clock, record.clocks);
      for (const { collection, record } of valid) {
        if (await this.mergePulled(collection, record, clock)) {
          changed++;
          changedCollections.add(collection);
        }
      }
      const cur = await this.cursor();
      if (page.cursor > cur) await this.setMeta('cursor', page.cursor);
      await this.saveClock(clock);
    });
    if (changedCollections.size > 0) this.emitPullApplied([...changedCollections]);
    return { changed, invalid, unknown };
  }

  /** Merge one pulled record (inside applyPull's transaction). Returns true if stored. */
  private async mergePulled(
    collection: CollectionName,
    remote: AnyRecord,
    clock: HlcClock,
  ): Promise<boolean> {
    const table = this.table(collection);
    const outbox = this.table(OUTBOX);
    const raw = (await table.get(remote.id)) as AnyRecord | undefined;
    const local = raw ? withDefaults(collection, raw) : undefined;
    const fieldResolvers = this.resolversFor(collection, clock);
    const detailed = mergeRecordDetailed<AnyRecord>(
      local,
      remote,
      fieldResolvers ? { fieldResolvers } : {},
    );
    let merged = detailed.record;
    const changedFields = new Set(detailed.changedFields);

    const writable = collections[collection].writable;
    const entry = writable
      ? ((await outbox.where('[collection+id]').equals([collection, remote.id]).first()) as
          | OutboxEntry
          | undefined)
      : undefined;

    // Pending local writes that the remote changed concurrently.
    const conflictFields: string[] = [];
    if (entry && local) {
      for (const [k, fc] of Object.entries(entry.fields)) {
        if (!hasOwn(remote, k)) continue;
        const rc = remote.clocks[k] ?? HLC_ZERO;
        // Stamps minted by this replica (its own earlier writes echoed back) and the stamp
        // the local edit was based on are not concurrent edits.
        const ownWrite = rc.slice(-16) === clock.node;
        if (!ownWrite && rc !== fc.hlc && rc !== entry.baseClocks?.[k]) conflictFields.push(k);
      }
    }

    // Record-level resolver: its fields get one fresh stamp and are queued for push.
    const minted: Record<string, FieldChange> = {};
    const recordResolver = this.recordResolvers.get(collection);
    if (recordResolver && entry && local && conflictFields.length > 0) {
      const patch = recordResolver({
        collection,
        local: local as never,
        remote: remote as never,
        merged: merged as never,
        pendingFields: { ...entry.fields },
        conflictFields,
        tick: () => clock.tick(),
        clientId: clock.node,
      });
      const values = this.validateResolverPatch(collection, patch, merged);
      if (values && Object.keys(values).length > 0) {
        const hlc = clock.tick();
        const nowIso = new Date(this.now()).toISOString();
        const edited = applyLocalEdit<AnyRecord>(merged, merged.id, values, hlc, nowIso);
        merged = edited.record;
        for (const [k, fc] of Object.entries(edited.fields)) {
          minted[k] = fc;
          changedFields.add(k);
        }
      }
    }

    const unchanged =
      local &&
      changedFields.size === 0 &&
      merged.updatedAt === local.updatedAt &&
      merged.createdAt === local.createdAt;
    if (!unchanged) await table.put(merged);
    if (!writable) return !unchanged;

    // Reconcile the outbox: keep queued writes that are still the current value, add values
    // minted by resolvers (a stamp that is neither local nor remote), and remember the remote
    // stamps just merged as the new base of each still-pending field.
    const fields: Record<string, FieldChange> = {};
    for (const [k, fc] of Object.entries(entry?.fields ?? {})) {
      if (merged.clocks[k] === fc.hlc) fields[k] = fc;
    }
    for (const k of changedFields) {
      const c = merged.clocks[k];
      if (c !== undefined && c !== local?.clocks[k] && c !== remote.clocks[k]) {
        fields[k] = minted[k] ?? { value: merged[k], hlc: c };
      }
    }
    const baseClocks: Record<string, HlcString> = pick(entry?.baseClocks, fields);
    for (const k of Object.keys(fields)) {
      const rc = remote.clocks[k];
      if (rc !== undefined && hasOwn(remote, k)) baseClocks[k] = rc;
    }

    const hasFields = Object.keys(fields).length > 0;
    if (entry && !hasFields) await outbox.delete(entry.seq!);
    else if (entry) await outbox.put({ ...entry, fields, baseClocks });
    else if (hasFields) {
      await outbox.add({
        collection,
        id: remote.id,
        createdAt: merged.createdAt,
        fields,
        baseClocks,
      } satisfies OutboxEntry);
    }
    return !unchanged;
  }

  /** Validate a record resolver's result; invalid output is logged and ignored. */
  private validateResolverPatch(
    collection: CollectionName,
    patch: Record<string, unknown> | undefined | void,
    merged: AnyRecord,
  ): Record<string, unknown> | undefined {
    if (!patch) return undefined;
    const shape = collections[collection].fields.shape as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      const checked = hasOwn(shape, k) ? validateFieldValue(collection, k, v) : undefined;
      if (!checked?.ok) {
        console.error(
          `@/data: record resolver for ${collection} returned an invalid field "${k}"; ignored`,
          checked?.error,
        );
        return undefined;
      }
      if (!valuesEqual(merged[k], checked.value)) out[k] = checked.value;
    }
    return out;
  }

  /**
   * The server database was replaced: forget the cursor, drop server-owned data (it will be
   * pulled again) and queue every local record of writable collections for a full re-push.
   */
  async resetForNewServer(serverId: string): Promise<void> {
    await this.db.transaction('rw', this.allTables(), async () => {
      for (const def of listCollections()) {
        const table = this.table(def.name);
        if (!def.writable) {
          await table.clear();
          continue;
        }
        const all = (await table.toArray()) as AnyRecord[];
        for (const rec of all) {
          await this.enqueue(def.name, rec.id, rec.createdAt, recordToChangeFields(rec), rec.clocks);
        }
      }
      await this.setMeta('cursor', 0);
      await this.setMeta('serverId', serverId);
    });
  }

  /** Remove every local record, the outbox and all metadata (sign-out). */
  async clear(): Promise<void> {
    await this.db.transaction('rw', this.allTables(), async () => {
      for (const name of this.allTables()) await this.table(name).clear();
    });
  }
}
