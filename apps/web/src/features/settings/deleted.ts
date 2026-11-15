import { HLC_ZERO, isHlcString, parseHlc } from '@webfront/shared';
import { patch, restore, remove, transaction, type DataReader } from '@/data';

/**
 * Data logic for Settings > "Recently deleted". Features never import each other, so the
 * per-type titles and dependency rules live here and rely only on the shared schemas and `@/data`.
 *
 * Deleting is a soft delete (a tombstone). Nothing here removes data for good: tombstones are
 * what makes a delete sync to the other devices.
 */

/**
 * The collections shown. Left out on purpose: `wikiRevisions` (pruned snapshots, not deletions
 * the owner made), `shoppingItems` (their tombstones are the shopping history and the staples),
 * `settings`, and the server-owned collections.
 */
export const DELETED_TYPES = [
  'bookmarks',
  'bookmarkCategories',
  'postits',
  'tasks',
  'shoppingLists',
  'wikiPages',
  'calendarFeeds',
] as const;
export type DeletedType = (typeof DELETED_TYPES)[number];

export const TYPE_LABELS: Record<DeletedType, { singular: string; plural: string }> = {
  bookmarks: { singular: 'Bookmark', plural: 'Bookmarks' },
  bookmarkCategories: { singular: 'Bookmark category', plural: 'Bookmark categories' },
  postits: { singular: 'Post-it', plural: 'Post-its' },
  tasks: { singular: 'Task', plural: 'Tasks' },
  shoppingLists: { singular: 'Shopping list', plural: 'Shopping lists' },
  wikiPages: { singular: 'Wiki page', plural: 'Wiki pages' },
  calendarFeeds: { singular: 'Calendar feed', plural: 'Calendar feeds' },
};

/** Records deleted within this long of their parent's deletion count as "deleted with it". */
export const COMPANION_WINDOW_MS = 60_000;
/** Rows shown per type before "Show more". */
export const PAGE_SIZE = 200;
export const HOUR_MS = 60 * 60 * 1000;

export interface Ref {
  type: DeletedType;
  id: string;
}

export interface DeletedRow extends Ref {
  key: string;
  title: string;
  /** Second line: host, parent category, parent page. */
  detail: string | null;
  /** Milliseconds since the epoch: see `deletedAtOf`. */
  deletedAt: number;
  /** Records that were deleted together with this one and can be restored with it. */
  companions: Ref[];
}

export const rowKey = (type: DeletedType, id: string) => `${type}:${id}`;

interface Envelope {
  id: string;
  updatedAt: string;
  deleted: boolean;
  clocks: Record<string, string>;
}

/**
 * When a record was deleted: the wall time of the HLC stamp on its `deleted` field (written
 * only when the flag changes, so later edits or server touches do not move it), falling back to
 * `updatedAt` for a record without a usable stamp.
 */
export function deletedAtOf(rec: Envelope): number {
  const c = rec.clocks.deleted;
  if (c && c !== HLC_ZERO && isHlcString(c)) return parseHlc(c).wall;
  const t = Date.parse(rec.updatedAt);
  return Number.isNaN(t) ? 0 : t;
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '') ?? '';
  const t = line.trim();
  if (!t) return '(empty post-it)';
  return t.length > 90 ? `${t.slice(0, 89)}…` : t;
}

function host(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** Every tombstoned record of the shown collections, newest deletion first. */
export async function loadDeleted(db: DataReader): Promise<DeletedRow[]> {
  const all = { includeDeleted: true } as const;
  const gone = { includeDeleted: true, filter: (r: { deleted: boolean }) => r.deleted } as const;
  const [bookmarks, categories, postits, tasks, lists, pages, feeds] = await Promise.all([
    db.list('bookmarks', gone),
    db.list('bookmarkCategories', all),
    db.list('postits', gone),
    db.list('tasks', gone),
    db.list('shoppingLists', gone),
    db.list('wikiPages', all),
    db.list('calendarFeeds', gone),
  ]);
  const catById = new Map(categories.map((c) => [c.id, c]));
  const pageById = new Map(pages.map((p) => [p.id, p]));
  const rows: DeletedRow[] = [];
  const add = (
    type: DeletedType,
    rec: Envelope,
    title: string,
    detail: string | null,
    companions: Ref[] = [],
  ) =>
    rows.push({
      key: rowKey(type, rec.id),
      type,
      id: rec.id,
      title,
      detail,
      deletedAt: deletedAtOf(rec),
      companions,
    });

  const deletedBookmarks = bookmarks;
  const deletedCategories = categories.filter((c) => c.deleted);
  const deletedPages = pages.filter((p) => p.deleted);

  for (const b of deletedBookmarks) add('bookmarks', b, b.title, host(b.url));
  for (const c of deletedCategories) {
    const parent = c.parentId ? catById.get(c.parentId) : undefined;
    const t = deletedAtOf(c);
    const companions: Ref[] = [
      ...deletedBookmarks
        .filter((b) => b.categoryId === c.id && Math.abs(deletedAtOf(b) - t) <= COMPANION_WINDOW_MS)
        .map((b) => ({ type: 'bookmarks' as const, id: b.id })),
      ...deletedCategories
        .filter((s) => s.parentId === c.id && Math.abs(deletedAtOf(s) - t) <= COMPANION_WINDOW_MS)
        .map((s) => ({ type: 'bookmarkCategories' as const, id: s.id })),
    ];
    add('bookmarkCategories', c, c.name, parent ? `in ${parent.name}` : null, companions);
  }
  for (const p of postits) add('postits', p, firstLine(p.text), null);
  for (const t of tasks) add('tasks', t, t.title, t.dueDate ? `due ${t.dueDate}` : null);
  for (const l of lists) add('shoppingLists', l, l.name, null);
  for (const p of deletedPages) {
    const parent = p.parentId ? pageById.get(p.parentId) : undefined;
    // Subpages deleted together with this page (deleting a page can take its children along).
    const t = deletedAtOf(p);
    const companions: Ref[] = [];
    const queue = [p.id];
    const seen = new Set(queue);
    while (queue.length > 0) {
      const at = queue.shift()!;
      for (const k of deletedPages) {
        if (k.parentId !== at || seen.has(k.id)) continue;
        if (Math.abs(deletedAtOf(k) - t) > COMPANION_WINDOW_MS) continue;
        seen.add(k.id);
        queue.push(k.id);
        companions.push({ type: 'wikiPages', id: k.id });
      }
    }
    add('wikiPages', p, p.title, parent ? `in ${parent.title}` : null, companions);
  }
  for (const f of feeds) add('calendarFeeds', f, f.name, host(f.url));

  return rows.sort((a, b) => b.deletedAt - a.deletedAt || a.title.localeCompare(b.title));
}

// ---- restoring ----------------------------------------------------------------------------

export interface PlannedPatch {
  type: 'bookmarks' | 'bookmarkCategories' | 'wikiPages';
  id: string;
  changes: Record<string, unknown>;
  /** The values the same fields had before, for Undo. */
  prev: Record<string, unknown>;
}

export interface RestorePlan {
  restores: Ref[];
  patches: PlannedPatch[];
  /** What was restored besides the chosen rows ("its category “Home”"), for the toast. */
  notes: string[];
}

export interface RestoreRequest {
  row: DeletedRow;
  /** Also restore `row.companions` (the bookmarks deleted with a category, subpages of a page). */
  withCompanions: boolean;
}

function uniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const s = `${base}-${n}`.slice(0, 200);
    if (!taken.has(s)) return s;
  }
}

/**
 * Work out what restoring `requests` must do so that everything stays usable, from the data as
 * it is now:
 * - a bookmark whose category is deleted brings the category back too (and a sub-category its
 *   parent); a category that no longer exists at all is detached instead (`categoryId` null);
 * - a restored sub-category whose parent is gone becomes a top-level category;
 * - a restored wiki page whose parent is deleted (or gone) becomes a TOP-LEVEL page rather than
 *   resurrecting the parent: the parent may have been deleted on purpose and the page is what
 *   was asked for. A slug now used by a live page gets a numeric suffix.
 */
export async function planRestore(
  db: DataReader,
  requests: readonly RestoreRequest[],
): Promise<RestorePlan> {
  const all = { includeDeleted: true } as const;
  const needCats = requests.some(
    (r) => r.row.type === 'bookmarks' || r.row.type === 'bookmarkCategories',
  );
  const needPages = requests.some((r) => r.row.type === 'wikiPages');
  const [cats, pages] = await Promise.all([
    needCats ? db.list('bookmarkCategories', all) : Promise.resolve([]),
    needPages ? db.list('wikiPages', all) : Promise.resolve([]),
  ]);
  const catById = new Map(cats.map((c) => [c.id, c]));
  const pageById = new Map(pages.map((p) => [p.id, p]));

  const restores: Ref[] = [];
  const patches: PlannedPatch[] = [];
  const notes: string[] = [];
  const queued = new Set<string>();
  const explicit = new Set<string>();

  const addRestore = (type: DeletedType, id: string) => {
    const k = rowKey(type, id);
    if (queued.has(k)) return false;
    queued.add(k);
    restores.push({ type, id });
    return true;
  };

  for (const { row, withCompanions } of requests) {
    explicit.add(row.key);
    if (withCompanions) for (const c of row.companions) explicit.add(rowKey(c.type, c.id));
  }

  /** Make sure category `id` will be live. Returns false if it does not exist at all. */
  const ensureCategory = (id: string, depth = 0): boolean => {
    const c = catById.get(id);
    if (!c) return false;
    if (!c.deleted || queued.has(rowKey('bookmarkCategories', id)) || depth > 3) return true;
    if (c.parentId && !ensureCategory(c.parentId, depth + 1)) {
      patches.push({
        type: 'bookmarkCategories',
        id,
        changes: { parentId: null },
        prev: { parentId: c.parentId },
      });
    }
    addRestore('bookmarkCategories', id);
    if (!explicit.has(rowKey('bookmarkCategories', id))) notes.push(`its category “${c.name}”`);
    return true;
  };

  const restoringPages = new Set<string>();
  for (const { row, withCompanions } of requests) {
    if (row.type !== 'wikiPages') continue;
    restoringPages.add(row.id);
    if (withCompanions) for (const c of row.companions) restoringPages.add(c.id);
  }
  const takenSlugs = new Set(pages.filter((p) => !p.deleted).map((p) => p.slug));

  const planPage = (id: string) => {
    const p = pageById.get(id);
    if (!p || !addRestore('wikiPages', id)) return;
    const changes: Record<string, unknown> = {};
    const prev: Record<string, unknown> = {};
    if (p.parentId) {
      const parent = pageById.get(p.parentId);
      const parentLive = parent && (!parent.deleted || restoringPages.has(parent.id));
      if (!parentLive) {
        changes.parentId = null;
        prev.parentId = p.parentId;
        notes.push(`“${p.title}” as a top-level page`);
      }
    }
    const slug = uniqueSlug(p.slug, takenSlugs);
    takenSlugs.add(slug);
    if (slug !== p.slug) {
      changes.slug = slug;
      prev.slug = p.slug;
      notes.push(`“${p.title}” renamed to /${slug}`);
    }
    if (Object.keys(changes).length > 0) patches.push({ type: 'wikiPages', id, changes, prev });
  };

  for (const { row, withCompanions } of requests) {
    const refs: Ref[] = [row, ...(withCompanions ? row.companions : [])];
    for (const ref of refs) {
      switch (ref.type) {
        case 'bookmarks': {
          addRestore('bookmarks', ref.id);
          break;
        }
        case 'bookmarkCategories':
          ensureCategory(ref.id);
          break;
        case 'wikiPages':
          planPage(ref.id);
          break;
        default:
          addRestore(ref.type, ref.id);
      }
    }
  }

  // Bookmarks need a usable category.
  if (needCats) {
    const bookmarkIds = new Set<string>();
    for (const { row, withCompanions } of requests) {
      if (row.type === 'bookmarks') bookmarkIds.add(row.id);
      if (withCompanions)
        for (const c of row.companions) if (c.type === 'bookmarks') bookmarkIds.add(c.id);
    }
    if (bookmarkIds.size > 0) {
      const bms = await db.list('bookmarks', {
        includeDeleted: true,
        filter: (b) => bookmarkIds.has(b.id),
      });
      for (const b of bms) {
        if (!b.categoryId) continue;
        if (!ensureCategory(b.categoryId)) {
          patches.push({
            type: 'bookmarks',
            id: b.id,
            changes: { categoryId: null },
            prev: { categoryId: b.categoryId },
          });
          notes.push(`“${b.title}” as uncategorised`);
        }
      }
    }
  }

  return { restores, patches, notes };
}

/** Write a plan through `@/data` (one transaction). Resolves with an Undo that re-deletes. */
export async function applyPlan(plan: RestorePlan): Promise<() => Promise<void>> {
  await transaction(async () => {
    for (const r of plan.restores) await restore(r.type, r.id);
    for (const p of plan.patches) await patch(p.type, p.id, p.changes as never);
  });
  return async () => {
    await transaction(async () => {
      for (const p of plan.patches) await patch(p.type, p.id, p.prev as never);
      for (const r of [...plan.restores].reverse()) await remove(r.type, r.id);
    });
  };
}
