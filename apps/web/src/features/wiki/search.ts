import MiniSearch from 'minisearch';
import { FileText } from 'lucide-react';
import { reader } from '@/data';
import type { SearchResult } from '../types';
import { sectionColour } from './lib/tree';
import type { RecordOf } from '@webfront/shared';

/**
 * Full-text wiki search (lazy chunk). The MiniSearch index is built on first use and then
 * updated incrementally: each search re-lists pages (cheap, local) at most once a second and
 * only re-indexes pages whose `updatedAt` changed. Title matches are boosted.
 */

type Page = RecordOf<'wikiPages'>;

interface Doc {
  id: string;
  title: string;
  body: string;
}

let index: MiniSearch<Doc> | null = null;
const versions = new Map<string, string>();
let pages: Page[] = [];
let lastRefresh = 0;
let refreshing: Promise<void> | null = null;
const REFRESH_MS = 1000;

function createIndex(): MiniSearch<Doc> {
  return new MiniSearch<Doc>({
    fields: ['title', 'body'],
    storeFields: [],
    searchOptions: { boost: { title: 4 }, prefix: true, fuzzy: 0.15, combineWith: 'AND' },
  });
}

async function refresh(force = false): Promise<void> {
  if (!force && index && Date.now() - lastRefresh < REFRESH_MS) return;
  refreshing ??= (async () => {
    try {
      const list = await reader.list('wikiPages');
      index ??= createIndex();
      const seen = new Set<string>();
      for (const p of list) {
        seen.add(p.id);
        const v = versions.get(p.id);
        if (v === p.updatedAt) continue;
        const doc = { id: p.id, title: p.title, body: p.body };
        if (v === undefined) index.add(doc);
        else index.replace(doc);
        versions.set(p.id, p.updatedAt);
      }
      for (const id of [...versions.keys()]) {
        if (!seen.has(id)) {
          index.discard(id);
          versions.delete(id);
        }
      }
      pages = list;
      lastRefresh = Date.now();
    } finally {
      refreshing = null;
    }
  })();
  await refreshing;
}

/** A one-line excerpt of `body` around the first query term. */
export function snippet(body: string, query: string, radius = 50): string {
  const flat = body
    .replace(/[#>*_`~[\]|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return '';
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
  const lower = flat.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return flat.slice(0, radius * 2) + (flat.length > radius * 2 ? '…' : '');
  const start = Math.max(0, at - radius);
  const end = Math.min(flat.length, at + radius);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

export interface WikiHit {
  page: Page;
  score: number;
  snippet: string;
}

export async function searchWiki(query: string, limit = 20): Promise<WikiHit[]> {
  const q = query.trim();
  if (!q) return [];
  await refresh();
  if (!index) return [];
  let results = index.search(q);
  if (results.length === 0) results = index.search(q, { combineWith: 'OR' });
  const byId = new Map(pages.map((p) => [p.id, p]));
  const top = results[0]?.score ?? 1;
  const out: WikiHit[] = [];
  for (const r of results) {
    const page = byId.get(String(r.id));
    if (!page) continue;
    out.push({ page, score: r.score / top, snippet: snippet(page.body, q) });
    if (out.length >= limit) break;
  }
  return out;
}

/** The feature's `searchProvider.search`: never throws. */
export async function search(query: string, limit: number): Promise<SearchResult[]> {
  try {
    const hits = await searchWiki(query, limit);
    return hits.map((h) => {
      const colour = sectionColour(pages, h.page.id);
      const result: SearchResult = {
        id: h.page.id,
        title: h.page.title,
        href: `/wiki/${h.page.slug}`,
        // Keep wiki results a little below exact bookmark hits.
        score: Math.min(1, 0.25 + 0.65 * h.score),
        icon: FileText,
      };
      if (h.snippet) result.subtitle = h.snippet;
      if (colour) result.colour = colour;
      return result;
    });
  } catch (err) {
    console.warn('wiki search failed', err);
    return [];
  }
}

/** Test hook. */
export function _resetSearchIndex(): void {
  index = null;
  versions.clear();
  pages = [];
  lastRefresh = 0;
}

export { refresh as _refreshSearchIndex };
