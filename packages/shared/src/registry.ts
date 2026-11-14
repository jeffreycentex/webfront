import { z } from 'zod';
import { bookmarkCategoryFields, bookmarkFields } from './collections/bookmarks.js';
import { calendarEventFields, calendarFeedFields } from './collections/calendar.js';
import { postitFields, taskFields } from './collections/notes.js';
import { serviceStatusFields } from './collections/services.js';
import { settingFields, settingKeySchema } from './collections/settings.js';
import { shoppingItemFields, shoppingListFields } from './collections/shopping.js';
import { wikiPageFields, wikiRevisionFields } from './collections/wiki.js';
import { RESERVED_KEYS, recordEnvelopeSchema, type SyncRecord } from './record.js';

/**
 * The collection registry: the ONE place that lists every synced collection.
 * Server (records table, push validation) and web (Dexie stores, hooks) both iterate it.
 *
 * Adding a collection: write its field schema in `collections/<area>.ts`, add an entry
 * below, done. See docs/CONTRACTS.md.
 */

type Fields = z.ZodObject<z.ZodRawShape>;

export interface CollectionDef<N extends string = string, F extends Fields = Fields> {
  readonly name: N;
  /** Domain fields only (no envelope). Fields with `.default()` are optional on create. */
  readonly fields: F;
  /** Full stored record: envelope + fields. Parsing fills defaults for missing fields. */
  readonly schema: z.ZodType<SyncRecord<z.output<F>>>;
  /** Clients may push changes. False = server-owned, read-only for clients. */
  readonly writable: boolean;
  /** 'uuid' = UUID ids (clients use newId()); 'key' = id is a natural key (settings). */
  readonly idKind: 'uuid' | 'key';
  /**
   * Secondary indexes for the web Dexie store, in Dexie syntax (`'categoryId'`,
   * `'[listId+sortKey]'`). `id` (primary key) and `updatedAt` are always indexed.
   * Do not index boolean or nullable-only fields: IndexedDB cannot index booleans and
   * skips null keys.
   */
  readonly indexes: readonly string[];
  /** String fields merged with a client-side three-way text merge instead of plain LWW. */
  readonly textMergeFields: readonly string[];
}

function defineCollection<const N extends string, F extends Fields>(def: {
  name: N;
  fields: F;
  writable: boolean;
  idKind?: 'uuid' | 'key';
  indexes?: readonly string[];
  textMergeFields?: readonly string[];
}): CollectionDef<N, F> {
  for (const key of Object.keys(def.fields.shape)) {
    if ((RESERVED_KEYS as readonly string[]).includes(key)) {
      throw new Error(`collection ${def.name}: field "${key}" is reserved`);
    }
  }
  const idKind = def.idKind ?? 'uuid';
  const idSchema = idKind === 'uuid' ? z.uuid() : settingKeySchema;
  const schema = recordEnvelopeSchema.extend({ id: idSchema }).extend(def.fields.shape);
  return {
    name: def.name,
    fields: def.fields,
    schema: schema as unknown as z.ZodType<SyncRecord<z.output<F>>>,
    writable: def.writable,
    idKind,
    indexes: def.indexes ?? [],
    textMergeFields: def.textMergeFields ?? [],
  };
}

export const collections = {
  bookmarkCategories: defineCollection({
    name: 'bookmarkCategories',
    fields: bookmarkCategoryFields,
    writable: true,
    indexes: ['parentId', 'sortKey'],
  }),
  bookmarks: defineCollection({
    name: 'bookmarks',
    fields: bookmarkFields,
    writable: true,
    indexes: ['categoryId', '[categoryId+sortKey]', '*tags', 'url'],
  }),
  postits: defineCollection({
    name: 'postits',
    fields: postitFields,
    writable: true,
    indexes: ['sortKey'],
  }),
  tasks: defineCollection({
    name: 'tasks',
    fields: taskFields,
    writable: true,
    indexes: ['dueDate', 'sortKey'],
  }),
  shoppingLists: defineCollection({
    name: 'shoppingLists',
    fields: shoppingListFields,
    writable: true,
    indexes: ['sortKey'],
  }),
  shoppingItems: defineCollection({
    name: 'shoppingItems',
    fields: shoppingItemFields,
    writable: true,
    indexes: ['listId', '[listId+sortKey]', 'name'],
  }),
  wikiPages: defineCollection({
    name: 'wikiPages',
    fields: wikiPageFields,
    writable: true,
    indexes: ['slug', 'parentId', 'title'],
    textMergeFields: ['body'],
  }),
  wikiRevisions: defineCollection({
    name: 'wikiRevisions',
    fields: wikiRevisionFields,
    writable: true,
    indexes: ['pageId', '[pageId+createdAt]'],
  }),
  calendarFeeds: defineCollection({
    name: 'calendarFeeds',
    fields: calendarFeedFields,
    writable: true,
  }),
  settings: defineCollection({
    name: 'settings',
    fields: settingFields,
    writable: true,
    idKind: 'key',
  }),
  calendarEvents: defineCollection({
    name: 'calendarEvents',
    fields: calendarEventFields,
    writable: false,
    indexes: ['feedId', 'start'],
  }),
  serviceStatuses: defineCollection({
    name: 'serviceStatuses',
    fields: serviceStatusFields,
    writable: false,
    indexes: ['bookmarkId'],
  }),
} as const;

export type Collections = typeof collections;
export type CollectionName = keyof Collections;
/** Domain fields of a collection, as stored (defaults applied). */
export type FieldsOf<N extends CollectionName> = z.output<Collections[N]['fields']>;
/** Domain fields accepted on create (fields with defaults are optional). */
export type FieldsInput<N extends CollectionName> = z.input<Collections[N]['fields']>;
/** Full stored record of a collection. */
export type RecordOf<N extends CollectionName> = SyncRecord<FieldsOf<N>>;

export type AnyCollectionDef = CollectionDef<CollectionName, Fields>;

export const COLLECTION_NAMES = Object.keys(collections) as CollectionName[];
export const WRITABLE_COLLECTIONS = COLLECTION_NAMES.filter((n) => collections[n].writable);
export const SERVER_OWNED_COLLECTIONS = COLLECTION_NAMES.filter((n) => !collections[n].writable);

export const collectionNameSchema = z.enum(
  COLLECTION_NAMES as [CollectionName, ...CollectionName[]],
);

export function isCollectionName(name: string): name is CollectionName {
  return Object.prototype.hasOwnProperty.call(collections, name);
}

export function getCollection<N extends CollectionName>(name: N): Collections[N] {
  return collections[name];
}

/** Iterate the registry with a uniform type (for server/Dexie setup loops). */
export function listCollections(): AnyCollectionDef[] {
  return COLLECTION_NAMES.map((n) => collections[n] as unknown as AnyCollectionDef);
}

/** Validate a record id for a collection. */
export function isValidRecordId(name: CollectionName, id: string): boolean {
  return collections[name].idKind === 'uuid'
    ? z.uuid().safeParse(id).success
    : settingKeySchema.safeParse(id).success;
}

/**
 * Validate one field value for a collection (used by push validation, where changes carry
 * individual fields). `deleted` is accepted for every collection. Returns the parsed value
 * (defaults applied) or an error message.
 */
export function validateFieldValue(
  name: CollectionName,
  field: string,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (field === 'deleted') {
    return typeof value === 'boolean'
      ? { ok: true, value }
      : { ok: false, error: 'deleted must be boolean' };
  }
  const shape = collections[name].fields.shape as Record<string, z.ZodType>;
  const fieldSchema = Object.prototype.hasOwnProperty.call(shape, field) ? shape[field] : undefined;
  if (!fieldSchema) return { ok: false, error: `unknown field ${name}.${field}` };
  const parsed = fieldSchema.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : {
        ok: false,
        error: `${name}.${field}: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      };
}

/** Parse a full stored record (fills defaults for fields added since it was written). */
export function parseRecord<N extends CollectionName>(name: N, data: unknown): RecordOf<N> {
  return collections[name].schema.parse(data) as unknown as RecordOf<N>;
}
