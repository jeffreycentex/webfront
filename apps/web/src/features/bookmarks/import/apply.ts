import {
  COLOUR_KEYS,
  compareBySortKey,
  sortKeysBetween,
  type ColourKey,
  type RecordOf,
} from '@webfront/shared';
import { put, remove, transaction } from '@/data';
import type { Selection } from './plan';

/** Writes an import through `@/data` in batches, one `transaction` each, and can undo it. */

type Category = RecordOf<'bookmarkCategories'>;
type Bookmark = RecordOf<'bookmarks'>;

export interface CreatedByImport {
  categoryIds: string[];
  bookmarkIds: string[];
}

export interface ImportProgress {
  done: number;
  total: number;
}

export interface ApplyArgs {
  selection: Selection;
  merge: boolean;
  /** Live (not deleted) records at the time of import. */
  categories: readonly Category[];
  bookmarks: readonly Bookmark[];
  onProgress?: (p: ImportProgress) => void;
  /** Writes per transaction. */
  batchSize?: number;
}

export interface ApplyResult extends CreatedByImport {
  /** Existing categories that received links. */
  mergedCategories: number;
  links: number;
}

const COLOUR_STEP = 5; // coprime with 12: visits every colour, neighbours differ in hue
const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

function lastKey(items: readonly { sortKey: string; id: string }[]): string | null {
  let last: { sortKey: string; id: string } | null = null;
  for (const i of items) if (!last || compareBySortKey(last, i) < 0) last = i;
  return last?.sortKey ?? null;
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

interface CategoryJob {
  name: string;
  colour: ColourKey;
  /** Existing parent category id, when merging into one. */
  parentRef: string | null;
  /** Index of the new parent job otherwise. */
  parentJob: number | null;
  sortKey: string;
  links: { title: string; url: string; tags: string[]; notes: string }[];
  existingId: string | null;
}

export async function applyImport(args: ApplyArgs): Promise<ApplyResult> {
  const { selection, merge, onProgress } = args;
  const batchSize = Math.max(1, args.batchSize ?? 400);
  const liveCats = args.categories.filter((c) => !c.deleted);
  const liveMarks = args.bookmarks.filter((b) => !b.deleted);

  // 1. Plan categories: reuse or create, with colours and sort keys.
  const topExisting = liveCats.filter((c) => !c.parentId).sort(compareBySortKey);
  const lastTop = topExisting[topExisting.length - 1];
  let colourIdx = lastTop ? COLOUR_KEYS.indexOf(lastTop.colour) : -COLOUR_STEP;
  const nextColour = (): ColourKey => {
    colourIdx = (colourIdx + COLOUR_STEP + COLOUR_KEYS.length) % COLOUR_KEYS.length;
    return COLOUR_KEYS[colourIdx]!;
  };

  const jobs: CategoryJob[] = [];
  const newTopCount = selection.categories.filter(
    (c) => !(merge && topExisting.some((e) => sameName(e.name, c.folder.name))),
  ).length;
  const topKeys = sortKeysBetween(lastKey(topExisting), null, newTopCount);
  let topKeyAt = 0;
  let mergedCategories = 0;

  for (const cat of selection.categories) {
    const match = merge ? topExisting.find((e) => sameName(e.name, cat.folder.name)) : undefined;
    const colour = match ? match.colour : nextColour();
    const topJobIndex = jobs.length;
    jobs.push({
      name: cat.folder.name,
      colour,
      parentRef: null,
      parentJob: null,
      sortKey: match ? match.sortKey : topKeys[topKeyAt++]!,
      links: cat.links,
      existingId: match?.id ?? null,
    });
    if (match) mergedCategories++;

    const existingSubs = match ? liveCats.filter((c) => c.parentId === match.id) : [];
    const matchedSubs = cat.subs.map((s) =>
      merge ? existingSubs.find((e) => sameName(e.name, s.folder.name)) : undefined,
    );
    const newSubs = matchedSubs.filter((m) => !m).length;
    const subKeys = sortKeysBetween(lastKey(existingSubs), null, newSubs);
    let subAt = 0;
    cat.subs.forEach((s, i) => {
      const m = matchedSubs[i];
      jobs.push({
        name: s.folder.name,
        colour,
        parentRef: match?.id ?? null,
        parentJob: match ? null : topJobIndex,
        sortKey: m ? m.sortKey : subKeys[subAt++]!,
        links: s.links,
        existingId: m?.id ?? null,
      });
      if (m) mergedCategories++;
    });
  }

  const newJobs = jobs.filter((j) => !j.existingId);
  const totalLinks = jobs.reduce((n, j) => n + j.links.length, 0);
  const total = newJobs.length + totalLinks;
  let done = 0;
  onProgress?.({ done, total });

  const created: CreatedByImport = { categoryIds: [], bookmarkIds: [] };
  const targetId = new Map<number, string>();
  jobs.forEach((j, i) => {
    if (j.existingId) targetId.set(i, j.existingId);
  });

  try {
    // 2. Categories (parents before children, which is the order they were pushed).
    for (let at = 0; at < jobs.length;) {
      const batch: number[] = [];
      for (; at < jobs.length && batch.length < batchSize; at++) {
        if (!jobs[at]!.existingId) batch.push(at);
      }
      if (batch.length === 0) continue;
      const ids = await transaction(async () => {
        const out: [number, string][] = [];
        for (const i of batch) {
          const j = jobs[i]!;
          const parentId = j.parentJob !== null ? (targetId.get(j.parentJob) ?? null) : j.parentRef;
          const rec = await put('bookmarkCategories', {
            name: j.name,
            colour: j.colour,
            parentId,
            sortKey: j.sortKey,
          });
          targetId.set(i, rec.id);
          out.push([i, rec.id]);
        }
        return out;
      });
      for (const [, id] of ids) created.categoryIds.push(id);
      done += batch.length;
      onProgress?.({ done, total });
      await yieldToUi();
    }

    // 3. Bookmarks, appended after whatever the target category already holds.
    const queue: { categoryId: string; sortKey: string; link: CategoryJob['links'][number] }[] = [];
    jobs.forEach((j, i) => {
      const categoryId = targetId.get(i)!;
      const existing = liveMarks.filter((b) => b.categoryId === categoryId);
      const keys = sortKeysBetween(lastKey(existing), null, j.links.length);
      j.links.forEach((link, k) => queue.push({ categoryId, sortKey: keys[k]!, link }));
    });
    for (let at = 0; at < queue.length; at += batchSize) {
      const batch = queue.slice(at, at + batchSize);
      const ids = await transaction(async () => {
        const out: string[] = [];
        for (const q of batch) {
          const rec = await put('bookmarks', {
            url: q.link.url,
            title: q.link.title,
            categoryId: q.categoryId,
            tags: q.link.tags,
            notes: q.link.notes,
            sortKey: q.sortKey,
          });
          out.push(rec.id);
        }
        return out;
      });
      created.bookmarkIds.push(...ids);
      done += batch.length;
      onProgress?.({ done, total });
      await yieldToUi();
    }
  } catch (err) {
    // Leave nothing half-imported.
    await undoImport(created).catch(() => undefined);
    throw err;
  }
  return { ...created, mergedCategories, links: created.bookmarkIds.length };
}

/** Soft-deletes exactly what an import created (bookmarks first, then its new categories). */
export async function undoImport(created: CreatedByImport, batchSize = 400): Promise<void> {
  const ids: ['bookmarks' | 'bookmarkCategories', string][] = [
    ...created.bookmarkIds.map((id) => ['bookmarks', id] as ['bookmarks', string]),
    ...created.categoryIds.map(
      (id) => ['bookmarkCategories', id] as ['bookmarkCategories', string],
    ),
  ];
  for (let at = 0; at < ids.length; at += batchSize) {
    const batch = ids.slice(at, at + batchSize);
    await transaction(async () => {
      for (const [collection, id] of batch) await remove(collection, id);
    });
    await yieldToUi();
  }
}
