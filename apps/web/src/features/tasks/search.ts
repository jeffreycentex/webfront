import { ListTodo } from 'lucide-react';
import { reader } from '@/data';
import type { SearchProvider, SearchResult } from '../types';
import { formatShortDate, todayISO } from './dates';
import { scoreMatch } from './logic';

/** Search over task titles and notes. Local data only; never throws. */
export const tasksSearchProvider: SearchProvider = {
  id: 'tasks',
  label: 'Tasks',
  async search(query, limit): Promise<SearchResult[]> {
    try {
      const q = query.trim();
      if (!q) return [];
      const today = todayISO();
      const tasks = await reader.list('tasks');
      return tasks
        .map((t) => {
          const s = Math.max(scoreMatch(t.title, q), scoreMatch(t.notes, q) * 0.6);
          return { t, s };
        })
        .filter((x) => x.s > 0)
        .sort(
          (a, b) =>
            b.s - a.s || (a.t.completedAt === null ? 0 : 1) - (b.t.completedAt === null ? 0 : 1),
        )
        .slice(0, limit)
        .map(({ t, s }) => ({
          id: t.id,
          title: t.title,
          subtitle: t.completedAt
            ? 'Completed'
            : t.dueDate
              ? `Due ${formatShortDate(t.dueDate, today)}`
              : 'Task',
          href: '/tasks',
          score: t.completedAt ? s * 0.8 : s,
          icon: ListTodo,
        }));
    } catch {
      return [];
    }
  },
};
