import { bookmarkFields, safeHttpUrl } from '@webfront/shared';

/**
 * Parser for "Netscape bookmark files", the HTML export every major browser produces.
 *
 * The file is HOSTILE INPUT. It is parsed with `DOMParser` into an inert document (scripts do
 * not run, images and stylesheets are not fetched, nothing is attached to the live page) and
 * only attribute values and `textContent` are read from it. Nothing from the file is ever
 * inserted into the page as HTML. Only http(s) links survive; everything else is counted.
 *
 * Mapping (this app has categories with ONE level of sub-categories):
 * - Top-level wrapper folders ("Bookmarks bar", "Other bookmarks", "Favorites", ...) are unwrapped.
 * - A top-level folder becomes a category, its child folders become sub-categories.
 * - Folders nested deeper are flattened into their sub-category and the deeper folder path is
 *   kept as a tag, for example "Tools / Editors".
 * - Links outside any folder go to a category named "Imported".
 * - Firefox TAGS become tags; `<DD>` descriptions become notes.
 */

export const IMPORT_MAX_BYTES = 20 * 1024 * 1024;
export const IMPORT_MAX_LINKS = 10_000;
export const IMPORTED_CATEGORY_NAME = 'Imported';

export type SkipReason =
  'bookmarklet' | 'place' | 'browser' | 'file' | 'data' | 'other' | 'invalid';

export const SKIP_LABELS: Record<SkipReason, string> = {
  bookmarklet: 'javascript: bookmarklets',
  place: 'place: smart folders',
  browser: 'browser pages (chrome:, about:, edge: ...)',
  file: 'file: links',
  data: 'data: links',
  other: 'other schemes (ftp:, mailto: ...)',
  invalid: 'invalid or too long addresses',
};

export interface ImportLink {
  title: string;
  url: string;
  tags: string[];
  notes: string;
}

/** A folder that becomes a category (top level) or sub-category. `key` is stable per parse. */
export interface ImportFolder {
  key: string;
  name: string;
  links: ImportLink[];
  /** Sub-categories; always empty for a sub-category. */
  subs: ImportFolder[];
}

export interface ParsedImport {
  categories: ImportFolder[];
  skipped: Record<SkipReason, number>;
  skippedTotal: number;
  /** Importable (http/https) links found, before exclusions and duplicate handling. */
  linkCount: number;
}

export type ParseResult = { ok: true; parsed: ParsedImport } | { ok: false; error: string };

export interface ParseLimits {
  maxBytes?: number;
  maxLinks?: number;
}

const MAX_TITLE = 200;
const MAX_TAG = 40;
const MAX_NOTES = 5000;
const MAX_TAGS = 50;
const MAX_DEPTH = 300;

/** Names browsers give their root folders. Compared after lower-casing and dropping non-letters. */
const WRAPPERS = new Set([
  'bookmarksbar',
  'bookmarkstoolbar',
  'bookmarksmenu',
  'bookmarks',
  'otherbookmarks',
  'mobilebookmarks',
  'favorites',
  'favourites',
  'favoritesbar',
  'favouritesbar',
  'favoritesmenu',
]);

const BROWSER_SCHEMES = new Set([
  'chrome',
  'about',
  'edge',
  'brave',
  'vivaldi',
  'opera',
  'chrome-extension',
  'chrome-search',
  'moz-extension',
  'view-source',
  'resource',
  'safari-resource',
]);

export function emptySkipped(): Record<SkipReason, number> {
  return { bookmarklet: 0, place: 0, browser: 0, file: 0, data: 0, other: 0, invalid: 0 };
}

/** Why a raw href cannot be imported, or null when it is a valid http(s) address. */
export function classifyHref(raw: string | null): { url: string } | { skip: SkipReason } {
  const href = (raw ?? '').trim();
  if (!href) return { skip: 'invalid' };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase();
  if (!scheme) return { skip: 'invalid' };
  if (scheme === 'javascript') return { skip: 'bookmarklet' };
  if (scheme === 'place') return { skip: 'place' };
  if (scheme === 'file') return { skip: 'file' };
  if (scheme === 'data') return { skip: 'data' };
  if (BROWSER_SCHEMES.has(scheme)) return { skip: 'browser' };
  if (scheme !== 'http' && scheme !== 'https') return { skip: 'other' };
  const url = safeHttpUrl(href);
  if (!url || !bookmarkFields.shape.url.safeParse(url).success) return { skip: 'invalid' };
  return { url };
}

/**
 * Key for duplicate detection: host case, default port, fragment and trailing slash are ignored.
 * http and https stay distinct. Returns null for anything that is not an http(s) URL.
 */
export function duplicateKey(raw: string): string | null {
  const safe = safeHttpUrl(raw);
  if (!safe) return null;
  const u = new URL(safe);
  u.hash = '';
  let path = u.pathname;
  if (path.length > 1) path = path.replace(/\/+$/, '') || '/';
  return `${u.protocol}//${u.host}${path}${u.search}`;
}

function clean(text: string | null | undefined): string {
  // Collapse whitespace and drop control characters.
  // eslint-disable-next-line no-control-regex
  return (text ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const INERT = new Set(['script', 'style', 'template', 'noscript']);

/** Text of an element without script/style content; `lists` = leave nested <dl> lists out. */
function textOf(el: Node, lists = false): string {
  let out = '';
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === 3) out += n.nodeValue ?? '';
    else if (n.nodeType === 1) {
      const name = (n as Element).localName;
      if (INERT.has(name) || (lists && name === 'dl')) continue;
      out += textOf(n, lists);
    }
  }
  return out;
}

function normaliseWrapper(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, '');
}

function parseTags(attr: string | null): string[] {
  if (!attr) return [];
  return attr
    .split(',')
    .map((t) => clean(t).slice(0, MAX_TAG).trim())
    .filter(Boolean);
}

function mergeTags(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of lists.flat()) {
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

interface Builder {
  top: Map<string, ImportFolder>;
  order: ImportFolder[];
  loose: ImportFolder;
  skipped: Record<SkipReason, number>;
  linkCount: number;
  counter: number;
}

function newFolder(b: Builder, name: string): ImportFolder {
  return { key: `f${b.counter++}`, name, links: [], subs: [] };
}

function topFolder(b: Builder, name: string): ImportFolder {
  const k = name.toLowerCase();
  let f = b.top.get(k);
  if (!f) {
    f = newFolder(b, name);
    b.top.set(k, f);
    b.order.push(f);
  }
  return f;
}

function subFolder(b: Builder, parent: ImportFolder, name: string): ImportFolder {
  const k = name.toLowerCase();
  let f = parent.subs.find((s) => s.name.toLowerCase() === k);
  if (!f) {
    f = newFolder(b, name);
    parent.subs.push(f);
  }
  return f;
}

function place(b: Builder, path: string[], link: ImportLink): void {
  if (path.length === 0) {
    b.loose.links.push(link);
    return;
  }
  const top = topFolder(b, path[0]!);
  if (path.length === 1) {
    top.links.push(link);
    return;
  }
  const sub = subFolder(b, top, path[1]!);
  if (path.length > 2) {
    const deeper = path.slice(2).join(' / ').slice(0, MAX_TAG);
    link = { ...link, tags: mergeTags(link.tags, [deeper]) };
  }
  sub.links.push(link);
}

function readLink(b: Builder, a: Element): ImportLink | null {
  const res = classifyHref(a.getAttribute('href'));
  if ('skip' in res) {
    b.skipped[res.skip]++;
    return null;
  }
  let host = res.url;
  try {
    host = new URL(res.url).hostname.replace(/^www\./, '');
  } catch {
    // keep the url
  }
  const title = clean(textOf(a)).slice(0, MAX_TITLE).trim() || host.slice(0, MAX_TITLE);
  b.linkCount++;
  return { title, url: res.url, tags: mergeTags(parseTags(a.getAttribute('tags'))), notes: '' };
}

interface WalkState {
  pending: { name: string; wrapper: boolean } | null;
  last: ImportLink | null;
}

function walkList(
  b: Builder,
  dl: Element,
  path: string[],
  depth: number,
  inWrapper: boolean,
): void {
  const st: WalkState = { pending: null, last: null };
  const visit = (el: Element, d: number): void => {
    if (d > MAX_DEPTH) {
      // Pathologically deep: stop recursing and take the links below as they are.
      for (const a of Array.from(el.querySelectorAll('a'))) {
        const link = readLink(b, a);
        if (link) place(b, path, link);
      }
      return;
    }
    switch (el.localName) {
      case 'h3': {
        const name = clean(textOf(el)).slice(0, MAX_TITLE) || 'Untitled folder';
        const wrapper =
          path.length === 0 &&
          ((!inWrapper && WRAPPERS.has(normaliseWrapper(name))) ||
            el.hasAttribute('personal_toolbar_folder') ||
            el.hasAttribute('unfiled_bookmarks_folder'));
        st.pending = { name, wrapper };
        st.last = null;
        return;
      }
      case 'a': {
        const link = readLink(b, el);
        if (link) place(b, path, link);
        st.last = link;
        return;
      }
      case 'dl': {
        const p = st.pending;
        st.pending = null;
        st.last = null;
        walkList(
          b,
          el,
          p && !p.wrapper ? [...path, p.name] : path,
          d + 1,
          inWrapper || Boolean(p?.wrapper),
        );
        return;
      }
      case 'dd': {
        const text = clean(textOf(el, true)).slice(0, MAX_NOTES);
        if (text && st.last && !st.last.notes) st.last.notes = text;
        for (const c of Array.from(el.children)) visit(c, d + 1);
        return;
      }
      case 'script':
      case 'style':
      case 'template':
        return;
      default:
        for (const c of Array.from(el.children)) visit(c, d + 1);
    }
  };
  // Children are visited with the folder path of this list; nested lists restart the walk.
  // (`path` inside `visit` is this list's path because `walkList` is re-entered per list.)
  for (const c of Array.from(dl.children)) visit(c, depth);
}

function prune(f: ImportFolder): boolean {
  f.subs = f.subs.filter(prune);
  return f.links.length > 0 || f.subs.length > 0;
}

export function parseBookmarksHtml(text: string, limits: ParseLimits = {}): ParseResult {
  const maxBytes = limits.maxBytes ?? IMPORT_MAX_BYTES;
  const maxLinks = limits.maxLinks ?? IMPORT_MAX_LINKS;
  if (text.length > maxBytes) {
    return {
      ok: false,
      error: `This file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB, which is more than a bookmarks export should be. Nothing was imported.`,
    };
  }
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(text, 'text/html');
  } catch {
    return { ok: false, error: 'This file could not be read as an HTML bookmarks export.' };
  }
  const anchors = doc.querySelectorAll('a').length;
  if (anchors > maxLinks) {
    return {
      ok: false,
      error: `This file contains ${anchors.toLocaleString()} links; the limit is ${maxLinks.toLocaleString()}. Export a smaller folder, or split the file, and try again.`,
    };
  }
  const root = doc.querySelector('dl');
  if (!root || anchors === 0) {
    return {
      ok: false,
      error:
        'No bookmarks were found. Choose the HTML file your browser exported ("Export bookmarks"), not a JSON, CSV or backup file.',
    };
  }

  const b: Builder = {
    top: new Map(),
    order: [],
    loose: { key: 'loose', name: IMPORTED_CATEGORY_NAME, links: [], subs: [] },
    skipped: emptySkipped(),
    linkCount: 0,
    counter: 0,
  };
  walkList(b, root, [], 0, false);

  // "Imported" (loose links) comes last; fold it into a real folder of the same name if any.
  const categories = b.order.filter(prune);
  if (b.loose.links.length > 0) {
    const same = categories.find(
      (c) => c.name.toLowerCase() === IMPORTED_CATEGORY_NAME.toLowerCase(),
    );
    if (same) same.links.unshift(...b.loose.links);
    else categories.push(b.loose);
  }
  const skippedTotal = Object.values(b.skipped).reduce((a, n) => a + n, 0);
  return {
    ok: true,
    parsed: { categories, skipped: b.skipped, skippedTotal, linkCount: b.linkCount },
  };
}
