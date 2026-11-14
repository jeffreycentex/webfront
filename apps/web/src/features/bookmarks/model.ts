import {
  compareBySortKey,
  sortKeyAfter,
  sortKeyBetween,
  sortKeyForIndex,
  type RecordOf,
} from '@webfront/shared';

/** Pure bookmark logic: grouping, filtering and ranking, reordering, URL helpers. */

export type Category = RecordOf<'bookmarkCategories'>;
export type Bookmark = RecordOf<'bookmarks'>;

export interface Section {
  /** null = the "Uncategorised" bucket. */
  category: Category | null;
  bookmarks: Bookmark[];
  children: Section[];
}

export const UNCATEGORISED_ID = '__none__';

export function sectionId(s: Section): string {
  return s.category?.id ?? UNCATEGORISED_ID;
}

/**
 * Group bookmarks under categories (one nesting level). Orphans are tolerated: a sub-category
 * whose parent is missing, deleted or itself nested becomes top level, and a bookmark whose
 * category is missing goes to "Uncategorised" (shown last, only when non-empty).
 */
export function buildSections(
  categories: readonly Category[],
  bookmarks: readonly Bookmark[],
): Section[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const isTop = (c: Category) => {
    if (!c.parentId) return true;
    const p = byId.get(c.parentId);
    return !p || Boolean(p.parentId);
  };
  const sections = new Map<string, Section>(
    categories.map((c) => [c.id, { category: c, bookmarks: [], children: [] }]),
  );
  const uncategorised: Section = { category: null, bookmarks: [], children: [] };
  for (const b of [...bookmarks].sort(compareBySortKey)) {
    const target = b.categoryId ? sections.get(b.categoryId) : undefined;
    (target ?? uncategorised).bookmarks.push(b);
  }
  const top: Section[] = [];
  for (const c of [...categories].sort(compareBySortKey)) {
    const s = sections.get(c.id)!;
    if (isTop(c)) top.push(s);
    else sections.get(c.parentId!)!.children.push(s);
  }
  if (uncategorised.bookmarks.length > 0) top.push(uncategorised);
  return top;
}

/** All bookmarks of a section including its sub-sections, in display order. */
export function sectionBookmarks(s: Section): Bookmark[] {
  return [...s.bookmarks, ...s.children.flatMap((c) => c.bookmarks)];
}

/** Bookmarks in the order they appear on the page. */
export function displayOrder(sections: readonly Section[]): Bookmark[] {
  return sections.flatMap(sectionBookmarks);
}

/* ------------------------------------------------------------------------------------------
 * Filtering and ranking
 * ---------------------------------------------------------------------------------------- */

export function tokenise(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function wordStart(text: string, token: string): boolean {
  return text.startsWith(token) || text.includes(' ' + token) || text.includes('-' + token);
}

/**
 * Score of one token against a bookmark: the best field wins. 0 = no match.
 * title: prefix 100, word start 80, substring 60; tag 50 (exact 70); host 45; category 30;
 * url 20; notes 10; username 5.
 */
function tokenScore(b: Bookmark, categoryName: string, token: string): number {
  const title = b.title.toLowerCase();
  let best = 0;
  if (title.startsWith(token)) best = 100;
  else if (wordStart(title, token)) best = 80;
  else if (title.includes(token)) best = 60;
  for (const tag of b.tags) {
    const t = tag.toLowerCase();
    if (t === token) best = Math.max(best, 70);
    else if (t.includes(token)) best = Math.max(best, 50);
  }
  if (best < 45 && hostOf(b.url).toLowerCase().includes(token)) best = 45;
  if (best < 30 && categoryName.toLowerCase().includes(token)) best = 30;
  if (best < 20 && b.url.toLowerCase().includes(token)) best = 20;
  if (best < 10 && b.notes.toLowerCase().includes(token)) best = 10;
  if (best < 5 && (b.username ?? '').toLowerCase().includes(token)) best = 5;
  return best;
}

/** Score for the whole query: every token must match; 0 = not a match. */
export function scoreBookmark(
  b: Bookmark,
  categoryName: string,
  tokens: readonly string[],
): number {
  if (tokens.length === 0) return 1;
  let total = 0;
  for (const t of tokens) {
    const s = tokenScore(b, categoryName, t);
    if (s === 0) return 0;
    total += s;
  }
  return total;
}

export function categoryNameMap(categories: readonly Category[]): Map<string, string> {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const names = new Map<string, string>();
  for (const c of categories) {
    const parent = c.parentId ? byId.get(c.parentId) : undefined;
    names.set(c.id, parent ? `${parent.name} ${c.name}` : c.name);
  }
  return names;
}

export interface RankedBookmark {
  bookmark: Bookmark;
  score: number;
}

/** Matching bookmarks, best first (ties keep page order). */
export function rankBookmarks(
  bookmarks: readonly Bookmark[],
  categories: readonly Category[],
  query: string,
): RankedBookmark[] {
  const tokens = tokenise(query);
  const names = categoryNameMap(categories);
  return bookmarks
    .map((bookmark, i) => ({
      bookmark,
      i,
      score: scoreBookmark(
        bookmark,
        bookmark.categoryId ? (names.get(bookmark.categoryId) ?? '') : '',
        tokens,
      ),
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(({ bookmark, score }) => ({ bookmark, score }));
}

/** Keep only the bookmarks in `keep`, dropping sections that end up empty. */
export function filterSections(sections: readonly Section[], keep: ReadonlySet<string>): Section[] {
  const out: Section[] = [];
  for (const s of sections) {
    const bookmarks = s.bookmarks.filter((b) => keep.has(b.id));
    const children = filterSections(s.children, keep);
    if (bookmarks.length > 0 || children.length > 0) out.push({ ...s, bookmarks, children });
  }
  return out;
}

/* ------------------------------------------------------------------------------------------
 * Reordering (fractional sort keys)
 * ---------------------------------------------------------------------------------------- */

/**
 * The sort key for placing item `movingId` at `toIndex` within `siblings` (any order; the
 * moving item may be among them and is excluded). One field changes, so the move merges cleanly.
 */
export function sortKeyForMove(
  siblings: readonly { id: string; sortKey: string }[],
  movingId: string,
  toIndex: number,
): string {
  const sorted = siblings.filter((s) => s.id !== movingId).sort(compareBySortKey);
  return sortKeyForIndex(sorted, toIndex);
}

/** Key for appending to the end of `siblings`. */
export function sortKeyForAppend(siblings: readonly { sortKey: string }[]): string {
  let last: string | null = null;
  for (const s of siblings) if (last === null || s.sortKey > last) last = s.sortKey;
  return sortKeyAfter(last);
}

/** Key for "move up/down by one" (`delta` -1 / +1), or null when already at the edge. */
export function sortKeyForStep(
  siblings: readonly { id: string; sortKey: string }[],
  movingId: string,
  delta: -1 | 1,
): string | null {
  const sorted = [...siblings].sort(compareBySortKey);
  const from = sorted.findIndex((s) => s.id === movingId);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= sorted.length) return null;
  return sortKeyForMove(sorted, movingId, to);
}

export { sortKeyBetween };

/* ------------------------------------------------------------------------------------------
 * URLs and the bookmarklet
 * ---------------------------------------------------------------------------------------- */

/** Make a typed/pasted address into a full URL (adds https://), or null if it cannot be one. */
export function normaliseUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s || /\s/.test(s)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.href;
  } catch {
    return null;
  }
}

/** Title fallback when the server cannot supply one (offline): the hostname. */
export function fallbackTitle(url: string): string {
  return hostOf(url) || url;
}

/**
 * The `javascript:` bookmarklet that opens the capture window for the current page. The origin
 * is baked in; the page's own URL and title are passed in the query string.
 */
export function buildBookmarklet(origin: string): string {
  const base = JSON.stringify(`${origin}/capture`);
  const code =
    `(function(){var u=encodeURIComponent(location.href),t=encodeURIComponent(document.title||'');` +
    `window.open(${base}+'?url='+u+'&title='+t,'webfront_capture',` +
    `'popup=yes,width=440,height=560,noopener=no');})();`;
  return `javascript:${code}`;
}

/** Only http(s) URLs may come from the capture query string. */
export function parseCaptureParams(search: string): { url: string; title: string } {
  const p = new URLSearchParams(search);
  const url = normaliseUrl(p.get('url') ?? '') ?? '';
  return { url, title: (p.get('title') ?? '').trim().slice(0, 200) };
}

/** Letter + palette colour for the favicon fallback. */
export function avatarLetter(title: string, url: string): string {
  const src = (title.trim() || hostOf(url)).replace(/^[^\p{L}\p{N}]+/u, '');
  return (src[0] ?? '?').toUpperCase();
}

/* ------------------------------------------------------------------------------------------
 * Category pickers
 * ---------------------------------------------------------------------------------------- */

export interface CategoryOption {
  id: string;
  label: string;
  depth: 0 | 1;
}

/** Categories flattened for a <select>: parents followed by their sub-categories. */
export function categoryOptions(categories: readonly Category[]): CategoryOption[] {
  const out: CategoryOption[] = [];
  for (const s of buildSections(categories, [])) {
    if (!s.category) continue;
    out.push({ id: s.category.id, label: s.category.name, depth: 0 });
    for (const c of s.children) {
      if (c.category)
        out.push({ id: c.category.id, label: `${s.category.name} / ${c.category.name}`, depth: 1 });
    }
  }
  return out;
}
