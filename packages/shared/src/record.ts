import { z } from 'zod';
import { HLC_ZERO, compareHlcStrings, hlcSchema, parseHlc, type HlcString } from './hlc.js';

/**
 * Common record envelope for every synced collection.
 *
 * Records are stored flat: envelope keys and domain fields side by side, e.g.
 *   { id, createdAt, updatedAt, deleted, clocks: { title: '…', deleted: '…' }, title: 'x', … }
 *
 * - `id`         client-generated UUIDv7 (settings use their key; see registry `idKind`).
 * - `createdAt`  ISO timestamp, set once by the creator. Merge keeps the earliest.
 * - `updatedAt`  ISO timestamp of the latest write seen. Merge keeps the latest. Informational only.
 * - `deleted`    tombstone flag. A *clocked* field like any domain field, so undelete works and a
 *                concurrent edit vs delete resolves by HLC like everything else.
 * - `clocks`     field name -> HLC stamp of the write that produced the current value.
 *                Every domain field and `deleted` should have a clock; a missing clock counts as
 *                `HLC_ZERO` (loses to any real write).
 */

export const isoDateTimeSchema = z.iso.datetime({ offset: false });
export const isoDateSchema = z.iso.date();

export const fieldClocksSchema = z.record(z.string(), hlcSchema);
export type FieldClocks = Record<string, HlcString>;

export const recordEnvelopeSchema = z.object({
  id: z.string().min(1).max(200),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  deleted: z.boolean(),
  clocks: fieldClocksSchema,
});

export interface RecordEnvelope {
  id: string;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
  clocks: FieldClocks;
}

/** A full record: envelope plus domain fields `F`. */
export type SyncRecord<F extends object = Record<string, unknown>> = RecordEnvelope & F;

/** Envelope keys that are NOT clocked (they are merged by fixed rules). */
export const UNCLOCKED_KEYS = ['id', 'createdAt', 'updatedAt', 'clocks'] as const;
const UNCLOCKED = new Set<string>(UNCLOCKED_KEYS);

/** Keys that must never appear as domain field names. */
export const RESERVED_KEYS = ['id', 'createdAt', 'updatedAt', 'deleted', 'clocks'] as const;

export function isClockedKey(key: string): boolean {
  return !UNCLOCKED.has(key);
}

/** JSON serialisation with sorted object keys; used for value equality and deterministic tie-breaks. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function valuesEqual(a: unknown, b: unknown): boolean {
  return a === b || stableStringify(a) === stableStringify(b);
}

/** One side of a field during merge. */
export interface FieldVersion {
  value: unknown;
  hlc: HlcString;
}

/**
 * Optional per-field hook for concurrent writes whose values differ (e.g. the wiki's
 * three-way body merge). It receives both versions and the LWW winner and returns the
 * version to keep. It must be deterministic. The returned `hlc` should be the winner's
 * stamp unless the resolver is producing a genuinely new write (then a fresh local tick).
 */
export type FieldResolver = (args: {
  field: string;
  local: FieldVersion;
  remote: FieldVersion;
  winner: FieldVersion;
}) => FieldVersion;

export interface MergeOptions {
  fieldResolvers?: Record<string, FieldResolver>;
}

export interface MergeResult<T extends RecordEnvelope> {
  record: T;
  /** Fields (incl. `deleted`) whose value or clock in `record` differs from `local`. */
  changedFields: string[];
}

function has(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Per-field last-writer-wins merge of two versions of the same record.
 *
 * Properties (tested): commutative, associative and idempotent on values and clocks, so
 * every replica converges regardless of delivery order. `remote` may be partial (only the
 * fields it changed, as produced by `changeToPartialRecord`); fields absent on one side are
 * taken from the other. Neither input is mutated.
 *
 * Tie-break when two stamps are equal but values differ (should not happen, since stamps
 * embed the node id): the value with the greater `stableStringify` wins.
 */
export function mergeRecordDetailed<T extends RecordEnvelope>(
  local: T | undefined,
  remote: T,
  options: MergeOptions = {},
): MergeResult<T> {
  if (!local) {
    const record = { ...remote, clocks: { ...remote.clocks } };
    const changedFields = Object.keys(remote).filter(isClockedKey);
    return { record, changedFields };
  }
  if (local.id !== remote.id) {
    throw new Error(`mergeRecord: id mismatch (${local.id} vs ${remote.id})`);
  }

  const out: Record<string, unknown> = {};
  const clocks: FieldClocks = {};
  const changedFields: string[] = [];
  const l = local as unknown as Record<string, unknown>;
  const r = remote as unknown as Record<string, unknown>;

  const keys = new Set<string>([...Object.keys(local), ...Object.keys(remote)]);
  for (const key of keys) {
    if (!isClockedKey(key)) continue;
    const inLocal = has(local, key);
    const inRemote = has(remote, key);
    const lClock = local.clocks[key];
    const rClock = remote.clocks[key];

    let value: unknown;
    let clock: HlcString | undefined;
    if (inLocal && !inRemote) {
      value = l[key];
      clock = lClock;
    } else if (!inLocal && inRemote) {
      value = r[key];
      clock = rClock;
    } else {
      const lv: FieldVersion = { value: l[key], hlc: lClock ?? HLC_ZERO };
      const rv: FieldVersion = { value: r[key], hlc: rClock ?? HLC_ZERO };
      const cmp = compareHlcStrings(lv.hlc, rv.hlc);
      let winner: FieldVersion;
      if (cmp > 0) winner = lv;
      else if (cmp < 0) winner = rv;
      else winner = stableStringify(lv.value) >= stableStringify(rv.value) ? lv : rv;

      const resolver = options.fieldResolvers?.[key];
      if (resolver && cmp !== 0 && !valuesEqual(lv.value, rv.value)) {
        winner = resolver({ field: key, local: lv, remote: rv, winner });
      }
      value = winner.value;
      clock = lClock === undefined && rClock === undefined ? undefined : winner.hlc;
    }

    out[key] = value;
    if (clock !== undefined) clocks[key] = clock;
    if (!inLocal || !valuesEqual(l[key], value) || lClock !== clock) changedFields.push(key);
  }

  out.id = local.id;
  out.createdAt = local.createdAt <= remote.createdAt ? local.createdAt : remote.createdAt;
  out.updatedAt = local.updatedAt >= remote.updatedAt ? local.updatedAt : remote.updatedAt;
  out.clocks = clocks;
  return { record: out as T, changedFields };
}

export function mergeRecord<T extends RecordEnvelope>(
  local: T | undefined,
  remote: T,
  options?: MergeOptions,
): T {
  return mergeRecordDetailed(local, remote, options).record;
}

/* ----------------------------------------------------------------------------------------
 * Field-level changes (the unit of the sync protocol) and conversions to/from records.
 * -------------------------------------------------------------------------------------- */

export const fieldChangeSchema = z.object({
  value: z.unknown(),
  hlc: hlcSchema,
});
export type FieldChange = z.infer<typeof fieldChangeSchema>;

/** Wall-clock ISO time of the latest stamp in `clocks` (or `fallback` when empty). */
export function latestClockTime(clocks: FieldClocks, fallback: string): string {
  let max: string | undefined;
  for (const c of Object.values(clocks)) if (max === undefined || c > max) max = c;
  return max === undefined ? fallback : new Date(parseHlc(max).wall).toISOString();
}

/** A set of field writes to one record, as sent in a push. */
export interface RecordChangeLike {
  id: string;
  createdAt: string;
  fields: Record<string, FieldChange>;
}

/** Turn a change into a partial record that `mergeRecord` can apply onto a stored record. */
export function changeToPartialRecord<T extends RecordEnvelope = SyncRecord>(
  change: RecordChangeLike,
): T {
  const out: Record<string, unknown> = {};
  const clocks: FieldClocks = {};
  for (const [key, fc] of Object.entries(change.fields)) {
    if (!isClockedKey(key)) continue;
    out[key] = fc.value;
    clocks[key] = fc.hlc;
  }
  out.id = change.id;
  out.createdAt = change.createdAt;
  out.updatedAt = latestClockTime(clocks, change.createdAt);
  out.clocks = clocks;
  return out as T;
}

/** Express a whole record as a change (every clocked field with its current stamp). */
export function recordToChangeFields(record: RecordEnvelope): Record<string, FieldChange> {
  const fields: Record<string, FieldChange> = {};
  const rec = record as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!isClockedKey(key)) continue;
    fields[key] = { value: rec[key], hlc: record.clocks[key] ?? HLC_ZERO };
  }
  return fields;
}

/**
 * Apply a local edit: stamp every field in `patch` with `hlc` and return the new record
 * plus the field changes to enqueue in the outbox. Pass `existing = undefined` to create
 * (then `patch` must contain every domain field, and `deleted: false` is added).
 */
export function applyLocalEdit<T extends RecordEnvelope>(
  existing: T | undefined,
  id: string,
  patch: Record<string, unknown>,
  hlc: HlcString,
  nowIso: string,
): { record: T; fields: Record<string, FieldChange> } {
  const fields: Record<string, FieldChange> = {};
  const values: Record<string, unknown> = { ...patch };
  if (!existing && !has(values, 'deleted')) values.deleted = false;
  for (const [key, value] of Object.entries(values)) {
    if (!isClockedKey(key)) throw new Error(`applyLocalEdit: cannot write envelope key "${key}"`);
    if (value === undefined) continue;
    fields[key] = { value, hlc };
  }
  const base: Record<string, unknown> = existing
    ? ({ ...existing, clocks: { ...existing.clocks } } as unknown as Record<string, unknown>)
    : { id, createdAt: nowIso, updatedAt: nowIso, clocks: {} };
  const clocks = base.clocks as FieldClocks;
  for (const [key, fc] of Object.entries(fields)) {
    base[key] = fc.value;
    clocks[key] = fc.hlc;
  }
  base.updatedAt = nowIso > (base.updatedAt as string) ? nowIso : base.updatedAt;
  return { record: base as T, fields };
}
