/**
 * `@/data` — the only module feature code imports for local data.
 * Owner: Task 3 (sync engine). Contract: `./types.ts`.
 *
 *   const items = useCollection('shoppingItems', { where: { listId }, sort: compareBySortKey });
 *   await put('shoppingItems', { listId, name: 'Milk', sortKey });
 *   await patch('shoppingItems', id, { checked: true });
 *   await remove('shoppingItems', id);
 *
 * `items` is `undefined` while loading, then an array.
 *
 * ## Transactions
 *
 * `transaction(fn)` runs `fn` in one IndexedDB transaction. Inside it only await `@/data` calls
 * (or other IndexedDB work): awaiting fetch or a timer lets IndexedDB commit early. Any function
 * shape works (`() => helper()` and `async () => await helper()` are equivalent).
 *
 * ## Notifications
 *
 * `onPullApplied(listener)` fires after a pulled page is durably stored, with the names of the
 * collections that changed (sync-leader tab only). `clearLocalData()` also wipes per-device
 * state: `webfront.*` localStorage keys and the wiki attachment cache database.
 *
 * ## Merge hooks (wiki three-way merge)
 *
 * Both hooks run only while PULLING, inside the same IndexedDB transaction that stores the
 * pulled record and advances the cursor. They must be synchronous and must not touch IndexedDB.
 * Register them once at module load (e.g. in the feature's index.tsx); they live per tab.
 *
 * 1. Record resolver (use this for the wiki):
 *
 *      registerRecordResolver('wikiPages', (args) => {
 *        // args: { collection, local, remote, merged, pendingFields, conflictFields, tick, clientId }
 *        return { body, conflict, baseRevisionId };   // or undefined to keep `merged`
 *      });
 *
 *    Fires when the pulled record has local edits still in the outbox (`pendingFields`) AND
 *    the remote changed at least one of those same fields concurrently (`conflictFields`):
 *    the remote stamp is neither the one the local edit was based on nor one this replica
 *    minted. It fires whether the local edit won LWW or lost; `merged` is the plain per-field
 *    LWW result (after field resolvers). It does NOT fire for records without pending edits
 *    (the remote simply wins) or when the remote only changed other fields.
 *    The returned fields are validated with the shared schema (invalid output is logged and
 *    ignored), stamped with ONE fresh local HLC (so they beat both sides), written onto
 *    `merged` and queued for push, atomically with the pull. Fields equal to `merged` are
 *    skipped. Return only domain fields (not `deleted`).
 *
 * 2. Field resolvers (`registerFieldResolvers(collection, map | ({ tick, clientId }) => map)`):
 *    one function per field, called by `mergeRecord` when both sides have different values
 *    with different stamps; returns the `{ value, hlc }` to keep. A returned stamp that is
 *    neither side's (a `tick()`) is queued for push. Runs before the record resolver.
 */
import type { DataWriter } from './types';
import { getLocal } from './runtime';

export type {
  CollectionName,
  DataReader,
  DataWriter,
  FieldsInput,
  FieldsOf,
  QueryOptions,
  RecordOf,
  SyncStatus,
} from './types';
export type {
  FieldResolverSource,
  RecordResolver,
  RecordResolverArgs,
  ResolverHelpers,
} from './local';
export { DataError } from './local';

// Hooks and non-hook reads
export { useCollection, useRecord, useLiveData, useSyncStatus, reader } from './hooks';

// Writes: local, offline-safe, resolve once stored and queued (never wait for the network).
export const put: DataWriter['put'] = (collection, values, options) =>
  getLocal().put(collection, values, options);
export const patch: DataWriter['patch'] = (collection, id, changes) =>
  getLocal().patch(collection, id, changes);
export const remove: DataWriter['remove'] = (collection, id) => getLocal().remove(collection, id);
export const restore: DataWriter['restore'] = (collection, id) =>
  getLocal().restore(collection, id);
export const transaction: DataWriter['transaction'] = (fn) => getLocal().transaction(fn);

// Lifecycle (app shell only), merge hooks (wiki), tests.
export {
  startSync,
  stopSync,
  syncNow,
  clearLocalData,
  clearDeviceState,
  onPullApplied,
  registerFieldResolvers,
  registerRecordResolver,
  _dbForTests,
} from './runtime';
