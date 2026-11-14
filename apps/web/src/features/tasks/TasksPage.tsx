import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  sortableKeyboardCoordinates,
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { ChevronRight, ListTodo } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { patch, remove, restore, transaction, useCollection } from '@/data';
import {
  Badge,
  Button,
  cx,
  EmptyState,
  PageHeader,
  Skeleton,
  useHotkeys,
  useIsPhone,
  useToast,
} from '@/ui';
import {
  countDue,
  flattenGroups,
  GROUP_LABEL,
  groupTasks,
  reorderKey,
  type GroupId,
  type Task,
} from './logic';
import { QuickAdd } from './QuickAdd';
import { TaskRow } from './TaskRow';
import { useToday } from './useToday';

const OPEN_GROUPS: GroupId[] = ['overdue', 'today', 'upcoming', 'none'];

export function TasksPage() {
  const tasks = useCollection('tasks');
  const today = useToday();
  const phone = useIsPhone();
  const { toast } = useToast();
  const quickRef = useRef<HTMLInputElement>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const groups = useMemo(() => groupTasks(tasks ?? [], today), [tasks, today]);
  const visible = useMemo(() => flattenGroups(groups, showCompleted), [groups, showCompleted]);
  const due = countDue(tasks ?? [], today);
  const overdue = groups.overdue.length;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const toggle = useCallback((t: Task) => {
    void patch('tasks', t.id, {
      completedAt: t.completedAt === null ? new Date().toISOString() : null,
    });
  }, []);

  const del = useCallback(
    (t: Task) => {
      void remove('tasks', t.id).then(() =>
        toast({
          title: 'Task deleted',
          description: t.title,
          action: { label: 'Undo', onClick: () => void restore('tasks', t.id) },
        }),
      );
    },
    [toast],
  );

  const clearCompleted = () => {
    const ids = groups.completed.map((t) => t.id);
    if (!ids.length) return;
    void transaction(async () => {
      for (const id of ids) await remove('tasks', id);
    }).then(() =>
      toast({
        title: `Cleared ${ids.length} completed`,
        action: {
          label: 'Undo',
          onClick: () =>
            void transaction(async () => {
              for (const id of ids) await restore('tasks', id);
            }),
        },
      }),
    );
  };

  const move = (delta: number) => {
    if (!visible.length) return;
    const i = visible.findIndex((t) => t.id === selectedId);
    const next =
      visible[
        Math.max(
          0,
          Math.min(visible.length - 1, i < 0 ? (delta > 0 ? 0 : visible.length - 1) : i + delta),
        )
      ];
    if (!next) return;
    setSelectedId(next.id);
    document
      .querySelector<HTMLElement>(`[data-task-id="${next.id}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  };

  const selected = visible.find((t) => t.id === selectedId) ?? null;
  // True when focus is on a control that handles the key itself (checkbox, button, link).
  const onControl = (e: KeyboardEvent) =>
    e.target instanceof HTMLElement && !!e.target.closest('button, input, a, select, textarea');

  useHotkeys(
    {
      n: (e) => {
        e.preventDefault();
        quickRef.current?.focus();
      },
      arrowdown: (e) => {
        e.preventDefault();
        move(1);
      },
      j: (e) => {
        e.preventDefault();
        move(1);
      },
      arrowup: (e) => {
        e.preventDefault();
        move(-1);
      },
      k: (e) => {
        e.preventDefault();
        move(-1);
      },
      x: (e) => {
        if (!selected) return false;
        e.preventDefault();
        toggle(selected);
      },
      space: (e) => {
        if (!selected || onControl(e)) return false;
        e.preventDefault();
        toggle(selected);
      },
      e: (e) => {
        if (!selected) return false;
        e.preventDefault();
        setEditingId(selected.id);
      },
      delete: (e) => {
        if (!selected) return false;
        e.preventDefault();
        del(selected);
      },
      backspace: (e) => {
        if (!selected || onControl(e)) return false;
        e.preventDefault();
        del(selected);
      },
      escape: () => {
        if (editingId) setEditingId(null);
        else setSelectedId(null);
        return false;
      },
    },
    { preventDefault: false },
  );

  const onDragEnd = (group: GroupId, ordered: Task[]) => (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;
    const key = reorderKey(ordered, String(active.id), String(over.id));
    if (key) void patch('tasks', String(active.id), { sortKey: key });
    void group;
  };

  const renderRow = (t: Task, group: GroupId) => (
    <TaskRow
      key={t.id}
      task={t}
      group={group}
      today={today}
      phone={phone}
      selected={selectedId === t.id}
      editing={editingId === t.id}
      onSelect={() => setSelectedId(t.id)}
      onEdit={() => {
        setSelectedId(t.id);
        setEditingId(t.id);
      }}
      onEditDone={() => setEditingId(null)}
      onToggle={() => toggle(t)}
      onDelete={() => del(t)}
    />
  );

  const openCount = OPEN_GROUPS.reduce((n, g) => n + groups[g].length, 0);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-2 p-3 max-sm:p-0 max-sm:pb-4">
      <PageHeader title="Tasks" icon={<ListTodo />} className="max-sm:px-3 max-sm:pt-2">
        {overdue > 0 && <Badge tone="bad">{overdue} overdue</Badge>}
        {groups.today.length > 0 && <Badge tone="warn">{groups.today.length} today</Badge>}
        {due === 0 && tasks && <span className="text-xs text-fg-3">Nothing due</span>}
      </PageHeader>
      <QuickAdd today={today} inputRef={quickRef} className="max-sm:px-3" />

      {tasks === undefined ? (
        <div className="flex flex-col gap-1 px-3" aria-busy>
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-4/5" />
          <Skeleton className="h-5 w-3/5" />
        </div>
      ) : openCount === 0 && groups.completed.length === 0 ? (
        <EmptyState title="No tasks yet" icon={<ListTodo />}>
          Type above and press Enter. Add a date in plain words: “tomorrow”, “fri”, “nov 20”, “in 3
          days”.
        </EmptyState>
      ) : (
        <>
          {openCount === 0 && (
            <EmptyState title="All done" icon={<ListTodo />}>
              Nothing open. Enjoy it.
            </EmptyState>
          )}
          {OPEN_GROUPS.map((g) => {
            const list = groups[g];
            if (!list.length) return null;
            return (
              <section
                key={g}
                aria-label={GROUP_LABEL[g]}
                className="overflow-hidden rounded-md border border-line bg-surface shadow-sm max-sm:rounded-none max-sm:border-x-0"
              >
                <GroupHeader group={g} count={list.length} />
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={onDragEnd(g, list)}
                >
                  <SortableContext
                    items={list.map((t) => t.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <ul className="divide-y divide-line">{list.map((t) => renderRow(t, g))}</ul>
                  </SortableContext>
                </DndContext>
              </section>
            );
          })}
          {groups.completed.length > 0 && (
            <section
              aria-label="Completed"
              className="overflow-hidden rounded-md border border-line bg-surface shadow-sm max-sm:rounded-none max-sm:border-x-0"
            >
              <div className="flex min-h-(--row-h) items-center gap-1 bg-surface-2 pr-2">
                <button
                  type="button"
                  aria-expanded={showCompleted}
                  onClick={() => setShowCompleted((v) => !v)}
                  className="label-caps flex min-h-(--row-h) flex-1 items-center gap-1 px-2 text-left text-fg-2 max-sm:px-3"
                >
                  <ChevronRight
                    aria-hidden
                    className={cx('size-3.5 transition-transform', showCompleted && 'rotate-90')}
                  />
                  Completed
                  <Badge>{groups.completed.length}</Badge>
                </button>
                <Button size="sm" variant="ghost" onClick={clearCompleted}>
                  Clear completed
                </Button>
              </div>
              {showCompleted && (
                <ul className="divide-y divide-line border-t border-line">
                  {groups.completed.map((t) => renderRow(t, 'completed'))}
                </ul>
              )}
            </section>
          )}
        </>
      )}
      <p className="hidden px-1 text-xs text-fg-3 sm:block">
        n new · ↑/↓ move · x or space complete · e edit · Delete remove
      </p>
    </div>
  );
}

function GroupHeader({ group, count }: { group: GroupId; count: number }) {
  const tone = group === 'overdue' ? 'bad' : group === 'today' ? 'warn' : 'neutral';
  return (
    <h2
      className={cx(
        'label-caps flex min-h-(--row-h) items-center gap-1.5 border-b border-line px-2 max-sm:px-3',
        group === 'overdue' && 'bg-bad-soft text-bad-text',
        group === 'today' && 'bg-warn-soft text-warn-text',
        tone === 'neutral' && 'bg-surface-2 text-fg-2',
      )}
    >
      {GROUP_LABEL[group]}
      <Badge tone={tone}>{count}</Badge>
    </h2>
  );
}
