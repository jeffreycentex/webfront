import { ShoppingBasket, ShoppingCart } from 'lucide-react';
import { reader } from '@/data';
import type { SearchProvider, SearchResult } from '../types';
import { nameKey } from './logic';

function score(key: string, q: string): number {
  if (key === q) return 1;
  if (key.startsWith(q)) return 0.85;
  if (key.split(' ').some((w) => w.startsWith(q))) return 0.7;
  return 0.5;
}

/** Search shopping lists and items (local data only; never throws). */
export const shoppingSearch: SearchProvider = {
  id: 'shopping',
  label: 'Shopping',
  async search(query, limit) {
    try {
      const q = nameKey(query);
      if (!q) return [];
      const [lists, items] = await Promise.all([
        reader.list('shoppingLists'),
        reader.list('shoppingItems'),
      ]);
      const byId = new Map(lists.map((l) => [l.id, l]));
      const out: SearchResult[] = [];
      for (const l of lists) {
        const key = nameKey(l.name);
        if (!key.includes(q)) continue;
        out.push({
          id: `list:${l.id}`,
          title: l.name,
          subtitle: 'Shopping list',
          href: `/shopping?list=${l.id}`,
          score: score(key, q) * 0.9,
          colour: l.colour,
          icon: ShoppingCart,
        });
      }
      for (const it of items) {
        const key = nameKey(it.name);
        const list = byId.get(it.listId);
        if (!list || !key.includes(q)) continue;
        out.push({
          id: `item:${it.id}`,
          title: it.name,
          subtitle: `${list.name}${it.checked ? ' · in the trolley' : ''}`,
          href: `/shopping?list=${list.id}`,
          score: score(key, q) * (it.checked ? 0.6 : 0.8),
          colour: list.colour,
          icon: ShoppingBasket,
        });
      }
      return out.sort((a, b) => b.score - a.score).slice(0, limit);
    } catch {
      return [];
    }
  },
};
