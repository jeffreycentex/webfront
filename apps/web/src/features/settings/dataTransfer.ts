import {
  WRITABLE_COLLECTIONS,
  collections,
  isValidRecordId,
  safeHttpUrl,
  type CollectionName,
} from '@webfront/shared';
import { z } from 'zod';
import { put, reader, transaction } from '@/data';

/**
 * Full JSON export and merge-import. Export holds every record of every writable collection
 * (not tombstones, not attachments). Import validates each record with the shared schemas and
 * merges by id through `@/data`, so changes sync like any edit; it never deletes anything: a
 * record is only written when it is new here or newer than the local copy, and a local
 * tombstone newer than the file stays deleted.
 */

export const EXPORT_FORMAT = 'webfront-export';
export const EXPORT_VERSION = 1;

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  collections: Partial<Record<CollectionName, unknown[]>>;
}

export async function buildExport(now: Date = new Date()): Promise<ExportFile> {
  const out: ExportFile['collections'] = {};
  for (const name of WRITABLE_COLLECTIONS) out[name] = await reader.list(name);
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now.toISOString(),
    collections: out,
  };
}

export function exportFileName(now: Date = new Date()): string {
  return `webfront-export-${now.toISOString().slice(0, 10)}.json`;
}

const fileSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  version: z.number().int().min(1),
  exportedAt: z.string(),
  collections: z.record(z.string(), z.array(z.unknown())),
});

export interface ImportItem {
  collection: CollectionName;
  id: string;
  fields: Record<string, unknown>;
}

export interface CollectionSummary {
  collection: CollectionName;
  added: number;
  updated: number;
  unchanged: number;
  invalid: number;
}

export interface ImportPlan {
  exportedAt: string;
  items: ImportItem[];
  summary: CollectionSummary[];
  ignoredCollections: string[];
}

export type ParseResult = { ok: true; plan: ImportPlan } | { ok: false; error: string };

export async function planImport(text: string): Promise<ParseResult> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: 'This file is not valid JSON.' };
  }
  const parsed = fileSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: 'This is not a Webfront export file.' };
  const file = parsed.data;
  if (file.version > EXPORT_VERSION) {
    return {
      ok: false,
      error: `This file was made by a newer version of Webfront (format ${file.version}). Update the app first.`,
    };
  }

  const items: ImportItem[] = [];
  const summary: CollectionSummary[] = [];
  const ignored: string[] = [];
  for (const [name, rows] of Object.entries(file.collections)) {
    if (!(WRITABLE_COLLECTIONS as string[]).includes(name)) {
      ignored.push(name);
      continue;
    }
    const collection = name as CollectionName;
    const def = collections[collection];
    const s: CollectionSummary = { collection, added: 0, updated: 0, unchanged: 0, invalid: 0 };
    for (const row of rows) {
      const rec = def.schema.safeParse(row);
      if (!rec.success || rec.data.deleted || !isValidRecordId(collection, rec.data.id)) {
        s.invalid++;
        continue;
      }
      const fields = def.fields.safeParse(rec.data);
      if (!fields.success || !importSafe(collection, fields.data as Record<string, unknown>)) {
        s.invalid++;
        continue;
      }
      const local = await reader.get(collection, rec.data.id);
      if (!local) s.added++;
      else if (local.updatedAt < rec.data.updatedAt && !local.deleted) s.updated++;
      else if (local.deleted && local.updatedAt < rec.data.updatedAt) s.updated++;
      else {
        s.unchanged++;
        continue;
      }
      items.push({
        collection,
        id: rec.data.id,
        fields: fields.data as Record<string, unknown>,
      });
    }
    summary.push(s);
  }
  return {
    ok: true,
    plan: { exportedAt: file.exportedAt, items, summary, ignoredCollections: ignored },
  };
}

/**
 * Extra checks for a file that may not be the user's own: the schemas accept any URL scheme, but
 * a bookmark (or its service check) must be http(s), so an imported `javascript:` or `data:`
 * link is skipped as invalid rather than stored.
 */
function importSafe(collection: CollectionName, fields: Record<string, unknown>): boolean {
  if (collection !== 'bookmarks') return true;
  if (!safeHttpUrl(fields.url as string)) return false;
  const check = fields.serviceCheck as { type?: string; url?: string | null } | null;
  if (check?.type === 'http' && check.url != null && !safeHttpUrl(check.url)) return false;
  return true;
}

const BATCH = 100;

/** Write the planned items (new and newer records only). Returns how many were written. */
export async function applyImport(
  plan: ImportPlan,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  let done = 0;
  for (let i = 0; i < plan.items.length; i += BATCH) {
    const batch = plan.items.slice(i, i + BATCH);
    await transaction(async () => {
      for (const item of batch) {
        await put(item.collection, item.fields as never, { id: item.id });
      }
    });
    done += batch.length;
    onProgress?.(done, plan.items.length);
  }
  return done;
}

export function planTotals(plan: ImportPlan) {
  return plan.summary.reduce(
    (t, s) => ({
      added: t.added + s.added,
      updated: t.updated + s.updated,
      unchanged: t.unchanged + s.unchanged,
      invalid: t.invalid + s.invalid,
    }),
    { added: 0, updated: 0, unchanged: 0, invalid: 0 },
  );
}
