import { ListTodo } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router';
import { patch, useCollection } from '@/data';
import { Badge, Checkbox, cx, EmptyState, Panel, Skeleton, useIsPhone, useToast } from '@/ui';
import { formatDueLabel } from './dates';
import { GROUP_LABEL, groupTasks, type GroupId, type Task } from './logic';
import { QuickAdd } from './QuickAdd';
import { useToday } from './useToday';

const OPEN_GROUPS: GroupId[] = ['overdue', 'today', 'upcoming', 'none'];

/**
 * Dashboard widget `tasks`: quick add plus open tasks in the Tasks page's order (overdue, today,
 * upcoming, no date), capped. `query` (the dashboard search box) filters titles live; the
 * "+n more" count and the header count follow the filter so the panel stays consistent.
 */
export default function TasksWidget({ query }: { query?: string }) {
  const tasks = useCollection('tasks');
  const today = useToday();
  const phone = useIsPhone();
  const { toast } = useToast();
  const max = phone ? 5 : 8;
  const q = (query ?? '').trim().toLowerCase();

  const rows = useMemo(() => {
    const groups = groupTasks(tasks ?? [], today);
    return OPEN_GROUPS.flatMap((g) =>
      groups[g]
        .filter((t) => !q || t.title.toLowerCase().includes(q))
        .map((t) => ({ task: t, group: g })),
    );
  }, [tasks, today, q]);

  const shown = rows.slice(0, max);
  const more = rows.length - shown.length;

  const complete = async (t: Task) => {
    await patch('tasks', t.id, { completedAt: new Date().toISOString() });
    toast({
      title: `Done: ${t.title}`,
      action: { label: 'Undo', onClick: () => void patch('tasks', t.id, { completedAt: null }) },
    });
  };

  return (
    <Panel
      title="Tasks"
      colour="teal"
      icon={<ListTodo className="size-3.5" aria-hidden />}
      flush={false}
      actions={
        <>
          <Badge aria-label={`${rows.length} open`}>{rows.length}</Badge>
          <Link to="/tasks" className="px-1 text-xs text-accent-text hover:underline">
            All
          </Link>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <QuickAdd today={today} />
        {tasks === undefined ? (
          <Skeleton className="h-16" />
        ) : rows.length === 0 ? (
          <EmptyState
            title={q ? 'No matching tasks' : 'Nothing to do'}
            icon={<ListTodo />}
            className="py-3"
          >
            {q ? 'No open task title matches the search.' : 'Add a task above.'}
          </EmptyState>
        ) : (
          <ul className="-mx-2 flex flex-col divide-y divide-line border-y border-line">
            {shown.map(({ task, group }, i) => (
              <li
                key={task.id}
                data-task-id={task.id}
                className={cx(
                  'border-l-2',
                  group === 'overdue' && 'border-l-bad bg-bad-soft/40',
                  group === 'today' && 'border-l-warn bg-warn-soft/40',
                  group !== 'overdue' && group !== 'today' && 'border-l-transparent',
                )}
              >
                {(i === 0 || shown[i - 1]!.group !== group) && (
                  <p className="label-caps px-2 pt-1 text-fg-3 max-sm:px-3">{GROUP_LABEL[group]}</p>
                )}
                <div className="flex min-h-(--row-h) items-center gap-1.5 px-2 text-sm max-sm:px-3">
                  <Checkbox
                    checked={false}
                    onChange={() => void complete(task)}
                    aria-label={`Complete ${task.title}`}
                    className="min-h-0"
                  />
                  <Link
                    to="/tasks"
                    className="min-w-0 flex-1 truncate py-0.5 hover:underline max-sm:py-2.5"
                  >
                    {task.title}
                  </Link>
                  {task.dueDate && (
                    <Badge
                      tone={group === 'overdue' ? 'bad' : group === 'today' ? 'warn' : 'neutral'}
                      className="shrink-0"
                    >
                      {formatDueLabel(task.dueDate, today)}
                    </Badge>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {more > 0 && (
          <Link to="/tasks" className="px-0.5 text-xs text-accent-text hover:underline">
            +{more} more
          </Link>
        )}
      </div>
    </Panel>
  );
}
