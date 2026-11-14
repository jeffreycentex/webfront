import { sortKeysBetween } from '@webfront/shared';
import { describe, expect, it } from 'vitest';
import { countDue, flattenGroups, groupTasks, reorderKey, scoreMatch, type Task } from './logic';

const T = '2026-11-14';
let n = 0;
const task = (over: Partial<Task>): Task => {
  n++;
  return {
    id: `id-${String(n).padStart(3, '0')}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deleted: false,
    clocks: {},
    title: `t${n}`,
    notes: '',
    dueDate: null,
    completedAt: null,
    sortKey: 'a0',
    ...over,
  } as Task;
};

describe('groupTasks', () => {
  it('splits by due date relative to local today', () => {
    const tasks = [
      task({ title: 'late', dueDate: '2026-11-13' }),
      task({ title: 'now', dueDate: T }),
      task({ title: 'soon', dueDate: '2026-11-15' }),
      task({ title: 'whenever' }),
      task({ title: 'done', dueDate: '2026-11-01', completedAt: '2026-11-10T10:00:00.000Z' }),
    ];
    const g = groupTasks(tasks, T);
    expect(g.overdue.map((t) => t.title)).toEqual(['late']);
    expect(g.today.map((t) => t.title)).toEqual(['now']);
    expect(g.upcoming.map((t) => t.title)).toEqual(['soon']);
    expect(g.none.map((t) => t.title)).toEqual(['whenever']);
    expect(g.completed.map((t) => t.title)).toEqual(['done']);
  });
  it('regroups when the day rolls over', () => {
    const tasks = [task({ title: 'a', dueDate: T })];
    expect(groupTasks(tasks, T).today).toHaveLength(1);
    expect(groupTasks(tasks, '2026-11-15').overdue).toHaveLength(1);
  });
  it('orders overdue and upcoming by date, others by sortKey', () => {
    const [k1, k2, k3] = sortKeysBetween(null, null, 3) as [string, string, string];
    const g = groupTasks(
      [
        task({ title: 'b', dueDate: '2026-11-12', sortKey: k1 }),
        task({ title: 'a', dueDate: '2026-11-10', sortKey: k3 }),
        task({ title: 'c', dueDate: '2026-11-12', sortKey: k2 }),
        task({ title: 'n2', sortKey: k2 }),
        task({ title: 'n1', sortKey: k1 }),
      ],
      T,
    );
    expect(g.overdue.map((t) => t.title)).toEqual(['a', 'b', 'c']);
    expect(g.none.map((t) => t.title)).toEqual(['n1', 'n2']);
  });
  it('lists completed newest first', () => {
    const g = groupTasks(
      [
        task({ title: 'old', completedAt: '2026-11-01T00:00:00.000Z' }),
        task({ title: 'new', completedAt: '2026-11-12T00:00:00.000Z' }),
      ],
      T,
    );
    expect(g.completed.map((t) => t.title)).toEqual(['new', 'old']);
  });
  it('flattens, hiding completed unless shown', () => {
    const g = groupTasks(
      [task({ title: 'x' }), task({ title: 'y', completedAt: '2026-11-12T00:00:00.000Z' })],
      T,
    );
    expect(flattenGroups(g, false).map((t) => t.title)).toEqual(['x']);
    expect(flattenGroups(g, true).map((t) => t.title)).toEqual(['x', 'y']);
  });
  it('counts overdue plus due today, open only', () => {
    const tasks = [
      task({ dueDate: '2026-11-01' }),
      task({ dueDate: T }),
      task({ dueDate: '2026-11-20' }),
      task({ dueDate: T, completedAt: '2026-11-14T08:00:00.000Z' }),
      task({}),
    ];
    expect(countDue(tasks, T)).toBe(2);
  });
});

describe('reorderKey', () => {
  const [a, b, c, d] = sortKeysBetween(null, null, 4) as [string, string, string, string];
  const list = [
    { id: 'A', sortKey: a },
    { id: 'B', sortKey: b },
    { id: 'C', sortKey: c },
    { id: 'D', sortKey: d },
  ];
  const apply = (id: string, over: string) => {
    const key = reorderKey(list, id, over);
    if (!key) return list.map((x) => x.id);
    return list
      .map((x) => (x.id === id ? { ...x, sortKey: key } : x))
      .sort((p, q) => (p.sortKey < q.sortKey ? -1 : 1))
      .map((x) => x.id);
  };
  it('moves down', () => expect(apply('A', 'C')).toEqual(['B', 'C', 'A', 'D']));
  it('moves up', () => expect(apply('D', 'B')).toEqual(['A', 'D', 'B', 'C']));
  it('moves to the ends', () => {
    expect(apply('A', 'D')).toEqual(['B', 'C', 'D', 'A']);
    expect(apply('D', 'A')).toEqual(['D', 'A', 'B', 'C']);
  });
  it('returns null for no-ops and unknown ids', () => {
    expect(reorderKey(list, 'A', 'A')).toBeNull();
    expect(reorderKey(list, 'A', 'Z')).toBeNull();
  });
});

describe('scoreMatch', () => {
  it('ranks prefix > word start > substring', () => {
    expect(scoreMatch('Pay rent', 'pay')).toBeGreaterThan(scoreMatch('Go pay rent', 'pay'));
    expect(scoreMatch('Go pay rent', 'pay')).toBeGreaterThan(scoreMatch('Repay rent', 'pay'));
    expect(scoreMatch('abc', 'zzz')).toBe(0);
    expect(scoreMatch('abc', '  ')).toBe(0);
  });
});
