import { safeHttpUrl } from '@webfront/shared';
import { reader } from '@/data';
import type { SearchProvider, SearchResult } from '../types';
import { categoryNameMap, hostOf, rankBookmarks, tokenise } from './model';

/** Dashboard search / command palette results: matching bookmarks that open their URL. */
export const bookmarkSearchProvider: SearchProvider = {
  id: 'bookmarks',
  label: 'Bookmarks',
  async search(query, limit): Promise<SearchResult[]> {
    try {
      if (!query.trim()) return [];
      const [bookmarks, categories] = await Promise.all([
        reader.list('bookmarks'),
        reader.list('bookmarkCategories'),
      ]);
      const names = categoryNameMap(categories);
      const colours = new Map(categories.map((c) => [c.id, c.colour]));
      const max = 100 * Math.max(1, tokenise(query).length);
      return rankBookmarks(bookmarks, categories, query)
        .slice(0, limit)
        .map(({ bookmark: b, score }): SearchResult => {
          const colour = b.categoryId ? colours.get(b.categoryId) : undefined;
          const category = b.categoryId ? names.get(b.categoryId) : undefined;
          return {
            id: b.id,
            title: b.title,
            subtitle: category ? `${hostOf(b.url)} · ${category}` : hostOf(b.url),
            // An unsafe stored URL (javascript:, data:) is never handed to an opener.
            href: safeHttpUrl(b.url) ?? '',
            external: true,
            score: Math.min(1, score / max),
            ...(colour ? { colour } : {}),
          };
        });
    } catch {
      return [];
    }
  },
};
