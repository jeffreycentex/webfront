import { z } from 'zod';
import { clientIdSchema } from '../ids.js';
import { fieldChangeSchema, isoDateTimeSchema, recordEnvelopeSchema } from '../record.js';
import { collectionNameSchema } from '../registry.js';

/**
 * Sync protocol. Owner of the implementation: Task 3.
 *
 * Model
 * - Each record lives once on the server (generic `records` table) with its field clocks.
 * - Clients push *field-level changes*. The server merges each into the stored record with
 *   `mergeRecordDetailed` (per-field LWW by HLC). If anything changed, the record gets the
 *   next value of a global, monotonically increasing `seq` (a record's seq is the seq of its
 *   latest accepted change).
 * - Clients pull every record with `seq > since`, in seq order, and merge them locally.
 *   The returned `cursor` is the next `since`. Pull returns full records, not deltas.
 * - `serverId` identifies the database instance; if it differs from what a client stored,
 *   the server DB was replaced (restore) and the client must pull from 0 and re-push its
 *   outbox.
 * - `GET /api/sync/events` is an SSE stream that only pokes ("there is something new");
 *   clients respond by pulling.
 * - Pushes to collections whose registry entry has `writable: false` are rejected.
 * - Pushing the same change twice is harmless (merge is idempotent; no new seq is assigned).
 */

export const MAX_PUSH_CHANGES = 500;
export const DEFAULT_PULL_LIMIT = 500;
export const MAX_PULL_LIMIT = 2000;

/** Field writes to one record. `fields` may include `deleted` (tombstone / undelete). */
export const recordChangeSchema = z.object({
  collection: collectionNameSchema,
  id: z.string().min(1).max(200),
  /** The record's createdAt as known by the client (merge keeps the earliest). */
  createdAt: isoDateTimeSchema,
  fields: z.record(z.string(), fieldChangeSchema),
});
export type RecordChange = z.infer<typeof recordChangeSchema>;

/** `POST /api/sync/push` */
export const pushRequestSchema = z.object({
  clientId: clientIdSchema,
  changes: z.array(recordChangeSchema).max(MAX_PUSH_CHANGES),
});
export type PushRequest = z.infer<typeof pushRequestSchema>;

export const pushResultSchema = z.discriminatedUnion('status', [
  /** Merged and stored; the record now has `seq`. */
  z.object({
    collection: collectionNameSchema,
    id: z.string(),
    status: z.literal('applied'),
    seq: z.int(),
  }),
  /** Valid but changed nothing (already known or lost every field to newer writes). */
  z.object({ collection: collectionNameSchema, id: z.string(), status: z.literal('unchanged') }),
  /** Invalid (bad field, read-only collection, clock drift). Clients drop it from the outbox. */
  z.object({
    collection: collectionNameSchema,
    id: z.string(),
    status: z.literal('rejected'),
    code: z.string(),
    error: z.string(),
  }),
]);
export type PushResult = z.infer<typeof pushResultSchema>;

export const pushResponseSchema = z.object({
  serverId: z.string(),
  results: z.array(pushResultSchema),
  /** Highest seq on the server after this push. */
  maxSeq: z.int().min(0),
});
export type PushResponse = z.infer<typeof pushResponseSchema>;

/** `GET /api/sync/pull?since=<seq>&limit=<n>` (query values arrive as strings). */
export const pullQuerySchema = z.object({
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(MAX_PULL_LIMIT).default(DEFAULT_PULL_LIMIT),
});
export type PullQuery = z.infer<typeof pullQuerySchema>;

/**
 * A pulled record. `record` is the full stored record (envelope + fields + clocks);
 * validate it with `collections[collection].schema` on the client.
 */
export const pulledRecordSchema = z.object({
  /**
   * A plain string (not the collection enum) so an older client receiving a collection it
   * does not know yet skips that record instead of failing the whole page.
   */
  collection: z.string(),
  seq: z.int().min(1),
  record: recordEnvelopeSchema.loose(),
});
export type PulledRecord = z.infer<typeof pulledRecordSchema>;

export const pullResponseSchema = z.object({
  serverId: z.string(),
  records: z.array(pulledRecordSchema),
  /** Pass as `since` next time (the seq of the last record returned, or `since` if none). */
  cursor: z.int().min(0),
  hasMore: z.boolean(),
});
export type PullResponse = z.infer<typeof pullResponseSchema>;

/**
 * `GET /api/sync/events` — text/event-stream.
 * - `event: hello` once on connect, `data: {"serverId": "...", "maxSeq": n}`
 * - `event: changed` after accepted writes, `data: {"maxSeq": n, "originClientId": "..." | null}`
 *   (clients may ignore pokes caused by their own push)
 * - comment lines (`: ping`) every ~25 s as keep-alive.
 * Optional query `?clientId=` so the server can tag the connection.
 */
export const SYNC_EVENT = { hello: 'hello', changed: 'changed' } as const;

export const syncHelloEventSchema = z.object({ serverId: z.string(), maxSeq: z.int().min(0) });
export type SyncHelloEvent = z.infer<typeof syncHelloEventSchema>;

export const syncChangedEventSchema = z.object({
  maxSeq: z.int().min(0),
  originClientId: clientIdSchema.nullable(),
});
export type SyncChangedEvent = z.infer<typeof syncChangedEventSchema>;
