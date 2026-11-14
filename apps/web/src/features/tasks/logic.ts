import { compareBySortKey, sortKeyForIndex, type RecordOf } from '@webfront/shared';

/** Pure grouping / ordering logic for the to-do list (no React, no data layer). */

export type Task = RecordOf<'tasks'>;

export type GroupId = 'overdue' | 'today' | 'upcoming' | 'none' | 'completed';

export interface TaskGroups {
  overdue: Task[];
  today: Task[];
  upcoming: Task[];
  none: Task[];
  completed: Task[];
}

export const GROUP_ORDER: GroupId[] = ['overdue', 'today', 'upcoming', 'none', 'completed'];

export const GROUP_LABEL: Record<GroupId, string> = {
  overdue: 'Overdue',
  today: 'Today',
  upcoming: 'Upcoming',
  none: 'No date',
  completed: 'Completed',
};

const byDateThenKey = (a: Task, b: Task) =>
  (a.dueDate ?? '').localeCompare(b.dueDate ?? '') || compareBySortKey(a, b);

const byCompletedDesc = (a: Task, b: Task) =>
  (b.completedAt ?? '') < (a.completedAt ?? '')
    ? -1
    : (b.completedAt ?? '') > (a.completedAt ?? '')
      ? 1
      : compareBySortKey(a, b);

/**
 * Split tasks into the five groups. `today` is the viewer's LOCAL date (`YYYY-MM-DD`); due
 * dates compare as plain strings, which is correct for zero-padded ISO dates.
 * - overdue: open, dueDate < today (oldest first, then manual order)
 * - today: open, dueDate === today (manual order)
 * - upcoming: open, dueDate > today (soonest first, then manual order)
 * - none: open, no date (manual order)
 * - completed: completedAt set (most recently completed first)
 */
export function groupTasks(tasks: readonly Task[], today: string): TaskGroups {
  const g: TaskGroups = { overdue: [], today: [], upcoming: [], none: [], completed: [] };
  for (const t of tasks) {
    if (t.completedAt !== null) g.completed.push(t);
    else if (t.dueDate === null) g.none.push(t);
    else if (t.dueDate < today) g.overdue.push(t);
    else if (t.dueDate === today) g.today.push(t);
    else g.upcoming.push(t);
  }
  g.overdue.sort(byDateThenKey);
  g.upcoming.sort(byDateThenKey);
  g.today.sort(compareBySortKey);
  g.none.sort(compareBySortKey);
  g.completed.sort(byCompletedDesc);
  return g;
}

/** Flat visible order (for keyboard navigation), skipping the completed group when collapsed. */
export function flattenGroups(g: TaskGroups, showCompleted: boolean): Task[] {
  const out = [...g.overdue, ...g.today, ...g.upcoming, ...g.none];
  return showCompleted ? [...out, ...g.completed] : out;
}

/** Number of open tasks that are overdue or due today. */
export function countDue(tasks: readonly Task[], today: string): number {
  let n = 0;
  for (const t of tasks)
    if (t.completedAt === null && t.dueDate !== null && t.dueDate <= today) n++;
  return n;
}

/**
 * New sortKey for moving `activeId` onto the position of `overId` within `ordered` (the
 * group's current display order, including the moved item). Mirrors dnd-kit's `arrayMove`.
 * Returns null when nothing changes.
 */
export function reorderKey(
  ordered: readonly { id: string; sortKey: string }[],
  activeId: string,
  overId: string,
): string | null {
  const from = ordered.findIndex((t) => t.id === activeId);
  const to = ordered.findIndex((t) => t.id === overId);
  if (from < 0 || to < 0 || from === to) return null;
  const rest = ordered.filter((t) => t.id !== activeId);
  return sortKeyForIndex(rest, to);
}

/** Search score: prefix beats word-start beats substring; 0 = no match. */
export function scoreMatch(text: string, query: string): number {
  const t = text.toLowerCase();
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const i = t.indexOf(q);
  if (i < 0) return 0;
  if (i === 0) return 0.9;
  return /\s/.test(t[i - 1]!) ? 0.7 : 0.5;
}
