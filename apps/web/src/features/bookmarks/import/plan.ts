import type { ImportFolder, ImportLink, ParsedImport } from './parseNetscape';
import { duplicateKey } from './parseNetscape';

/** What the user chose in the preview, and what that means for the write. Pure functions. */

export interface ImportOptions {
  /** 'skip' (default): do not import links already in the app, or repeated in the file. */
  duplicates: 'skip' | 'import';
  /** true (default): put links into an existing category with the same name. */
  merge: boolean;
}

export const DEFAULT_OPTIONS: ImportOptions = { duplicates: 'skip', merge: true };

/** A folder's own links form one "group"; excluding a group excludes exactly those links. */
export interface GroupStats {
  total: number;
  /** Links that will be written (0 when excluded). */
  importing: number;
  duplicatesExisting: number;
  duplicatesInFile: number;
}

export interface SelectedSub {
  folder: ImportFolder;
  links: ImportLink[];
}
export interface SelectedCategory {
  folder: ImportFolder;
  /** Links directly in the category. */
  links: ImportLink[];
  subs: SelectedSub[];
}

export interface Selection {
  categories: SelectedCategory[];
  stats: Map<string, GroupStats>;
  totals: {
    categories: number;
    subcategories: number;
    links: number;
    duplicatesExisting: number;
    duplicatesInFile: number;
  };
}

/** The keys of the link groups under a top-level folder (its own links, then each sub). */
export function groupKeys(top: ImportFolder): string[] {
  return [
    ...(top.links.length > 0 ? [top.key] : []),
    ...top.subs.filter((s) => s.links.length > 0).map((s) => s.key),
  ];
}

export function existingUrlKeys(bookmarks: readonly { url: string }[]): Set<string> {
  const out = new Set<string>();
  for (const b of bookmarks) {
    const k = duplicateKey(b.url);
    if (k) out.add(k);
  }
  return out;
}

/**
 * Walk the included groups in file order and decide which links get written. `off` holds the
 * excluded group keys.
 */
export function buildSelection(
  parsed: ParsedImport,
  off: ReadonlySet<string>,
  options: ImportOptions,
  existing: ReadonlySet<string>,
): Selection {
  const stats = new Map<string, GroupStats>();
  const seen = new Set<string>();
  const totals = {
    categories: 0,
    subcategories: 0,
    links: 0,
    duplicatesExisting: 0,
    duplicatesInFile: 0,
  };

  const pick = (folder: ImportFolder): ImportLink[] => {
    const s: GroupStats = {
      total: folder.links.length,
      importing: 0,
      duplicatesExisting: 0,
      duplicatesInFile: 0,
    };
    stats.set(folder.key, s);
    if (off.has(folder.key)) return [];
    const out: ImportLink[] = [];
    for (const l of folder.links) {
      const k = duplicateKey(l.url) ?? l.url;
      const dupExisting = existing.has(k);
      const dupFile = seen.has(k);
      if (dupExisting) s.duplicatesExisting++;
      else if (dupFile) s.duplicatesInFile++;
      seen.add(k);
      if (options.duplicates === 'skip' && (dupExisting || dupFile)) continue;
      out.push(l);
    }
    s.importing = out.length;
    return out;
  };

  const categories: SelectedCategory[] = [];
  for (const top of parsed.categories) {
    const links = pick(top);
    const subs: SelectedSub[] = [];
    for (const sub of top.subs) {
      const sl = pick(sub);
      if (sl.length > 0) subs.push({ folder: sub, links: sl });
    }
    if (links.length === 0 && subs.length === 0) continue;
    categories.push({ folder: top, links, subs });
    totals.categories++;
    totals.subcategories += subs.length;
    totals.links += links.length + subs.reduce((n, s) => n + s.links.length, 0);
  }
  for (const s of stats.values()) {
    totals.duplicatesExisting += s.duplicatesExisting;
    totals.duplicatesInFile += s.duplicatesInFile;
  }
  return { categories, stats, totals };
}
