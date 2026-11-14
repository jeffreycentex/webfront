import { StickyNote } from 'lucide-react';
import { reader } from '@/data';
import type { SearchProvider, SearchResult } from '../types';
import { firstLine } from './text';

/** Search over note text. Results open the post-its page focused on the note. */
export const postitsSearchProvider: SearchProvider = {
  id: 'postits',
  label: 'Post-its',
  async search(query, limit): Promise<SearchResult[]> {
    try {
      const q = query.trim().toLowerCase();
      if (!q) return [];
      const notes = await reader.list('postits');
      return notes
        .flatMap((n) => {
          const i = n.text.toLowerCase().indexOf(q);
          if (i < 0) return [];
          const base = i === 0 ? 0.85 : /\s/.test(n.text[i - 1]!) ? 0.65 : 0.45;
          return [{ n, score: n.archived ? base * 0.8 : base }];
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ n, score }) => ({
          id: n.id,
          title: firstLine(n.text),
          subtitle: n.archived ? 'Archived post-it' : n.pinned ? 'Pinned post-it' : 'Post-it',
          href: `/postits?focus=${encodeURIComponent(n.id)}`,
          score,
          colour: n.colour,
          icon: StickyNote,
        }));
    } catch {
      return [];
    }
  },
};
