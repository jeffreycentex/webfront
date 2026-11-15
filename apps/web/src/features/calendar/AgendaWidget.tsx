import { CalendarDays } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useCollection } from '@/data';
import { Badge, Checkbox, EmptyState, Panel, Skeleton, cx, useToast } from '@/ui';
// Deliberate exception to "features never import each other": completing a task must follow the
// tasks feature's recurrence rules, which live in one place.
import { completeTask, undoComplete } from '../tasks/actions';
import { EventDetails } from './EventCard';
import { addDays, deviceZone, groupAgenda, type Ymd } from './dates';
import { formatDay, relativeDayLabel } from './format';
import { feedColour, useCalendar, useNow, type CalendarEvent } from './model';
import { AgendaRow } from './rows';
import { todayYmd } from './dates';

/** Days shown: today and the next few. */
export const WIDGET_DAYS = 5;

/** Dashboard widget: today and the next days, calendar events merged with due and overdue to-dos. */
export default function AgendaWidget() {
  const cal = useCalendar();
  const tasks = useCollection('tasks');
  const { toast } = useToast();
  const now = useNow(60_000);
  const today = todayYmd(now);
  const zone = useMemo(() => deviceZone(), []);
  const [open, setOpen] = useState<{ event: CalendarEvent; el: HTMLElement } | null>(null);

  const last = addDays(today, WIDGET_DAYS - 1);
  const groups = useMemo(
    () => groupAgenda(cal.visibleEvents, { from: today, to: last, today, zone }),
    [cal.visibleEvents, today, last, zone],
  );
  const { overdue, dueByDay } = useMemo(() => {
    const byDay = new Map<Ymd, NonNullable<typeof tasks>>();
    const late: NonNullable<typeof tasks> = [];
    for (const t of tasks ?? []) {
      if (t.completedAt || !t.dueDate) continue;
      if (t.dueDate < today) late.push(t);
      else if (t.dueDate <= last) byDay.set(t.dueDate, [...(byDay.get(t.dueDate) ?? []), t]);
    }
    late.sort(
      (a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? '') || a.title.localeCompare(b.title),
    );
    return { overdue: late, dueByDay: byDay };
  }, [tasks, today, last]);

  const complete = async (id: string, title: string) => {
    const task = (tasks ?? []).find((t) => t.id === id);
    if (!task) return;
    // Shared completion logic: a recurring task rolls its due date forward instead of ending.
    const result = await completeTask(task, today);
    toast({
      title: result.kind === 'rolled' ? `${title}: ${result.message}` : `Done: ${title}`,
      action: { label: 'Undo', onClick: () => void undoComplete(result) },
    });
  };

  const loading = cal.loading || tasks === undefined;
  const days: Ymd[] = Array.from({ length: WIDGET_DAYS }, (_, i) => addDays(today, i));
  const groupByDay = new Map(groups.map((g) => [g.day, g]));
  const totalItems =
    overdue.length +
    groups.reduce((n, g) => n + g.items.length, 0) +
    [...dueByDay.values()].reduce((n, l) => n + l.length, 0);

  const taskRow = (t: { id: string; title: string; dueDate: string | null }, late: boolean) => (
    <li
      key={t.id}
      className={cx(
        'flex min-h-(--row-h) items-center gap-2 border-l-[3px] px-2 text-sm max-sm:px-3',
        late ? 'border-l-bad bg-bad-soft' : 'border-l-fg-3',
      )}
    >
      <Checkbox
        aria-label={`Complete ${t.title}`}
        checked={false}
        onChange={() => void complete(t.id, t.title)}
      />
      <span className="min-w-0 flex-1 truncate">{t.title}</span>
      {late && t.dueDate && (
        <span className="shrink-0 text-xs font-medium text-bad-text">
          due {formatDay(t.dueDate)}
        </span>
      )}
      {!late && <span className="shrink-0 text-2xs uppercase tracking-wide text-fg-3">To-do</span>}
    </li>
  );

  return (
    <Panel
      title="Today"
      colour="blue"
      icon={<CalendarDays className="size-3.5" aria-hidden />}
      actions={
        <>
          {overdue.length > 0 && <Badge tone="bad">{overdue.length} overdue</Badge>}
          <Link to="/calendar" className="px-1 text-xs text-accent-text hover:underline">
            Calendar
          </Link>
        </>
      }
    >
      {loading ? (
        <div className="flex flex-col gap-1.5 p-2">
          <Skeleton className="h-4" />
          <Skeleton className="h-4" />
        </div>
      ) : (
        <div>
          {overdue.length > 0 && (
            <section aria-label="Overdue">
              <h3 className="bg-bad-soft px-2 py-0.5 text-xs font-semibold text-bad-text max-sm:px-3">
                Overdue
              </h3>
              <ul className="divide-y divide-line">{overdue.map((t) => taskRow(t, true))}</ul>
            </section>
          )}
          {days.map((day) => {
            const group = groupByDay.get(day);
            const due = dueByDay.get(day) ?? [];
            const isToday = day === today;
            if (!isToday && (group?.items.length ?? 0) === 0 && due.length === 0) return null;
            const rel = relativeDayLabel(day, today);
            return (
              <section key={day} aria-label={formatDay(day, 'long')}>
                <h3
                  className={cx(
                    'flex min-h-6 items-center gap-2 px-2 py-0.5 text-xs font-semibold max-sm:px-3',
                    isToday ? 'bg-accent-soft text-accent-text' : 'bg-surface-2 text-fg-2',
                  )}
                >
                  <span>{rel ?? formatDay(day)}</span>
                  {rel && <span className="font-normal text-fg-3">{formatDay(day)}</span>}
                </h3>
                {(group?.items.length ?? 0) + due.length === 0 ? (
                  <p className="px-3 py-1 text-xs text-fg-3">Nothing scheduled.</p>
                ) : (
                  <ul className="divide-y divide-line">
                    {group?.items
                      .filter((i) => i.span.allDay)
                      .map((item) => (
                        <AgendaRow
                          key={`${item.event.id}:${day}`}
                          item={item}
                          colour={feedColour(cal.feedById.get(item.event.feedId))}
                          zone={zone}
                          compact
                          onOpen={(event, el) => setOpen({ event, el })}
                        />
                      ))}
                    {due.map((t) => taskRow(t, false))}
                    {group?.items
                      .filter((i) => !i.span.allDay)
                      .map((item) => (
                        <AgendaRow
                          key={`${item.event.id}:${day}`}
                          item={item}
                          colour={feedColour(cal.feedById.get(item.event.feedId))}
                          zone={zone}
                          compact
                          past={isToday && item.isLastDay && item.span.endMs <= now}
                          onOpen={(event, el) => setOpen({ event, el })}
                        />
                      ))}
                  </ul>
                )}
              </section>
            );
          })}
          {totalItems === 0 && cal.feeds.length === 0 && (
            <EmptyState title="No calendars yet" className="py-3">
              Add a calendar feed on the Calendar page.
            </EmptyState>
          )}
        </div>
      )}
      {open && (
        <EventDetails
          event={open.event}
          feed={cal.feedById.get(open.event.feedId)}
          colour={feedColour(cal.feedById.get(open.event.feedId))}
          anchor={open.el}
          zone={zone}
          onClose={() => setOpen(null)}
        />
      )}
    </Panel>
  );
}
