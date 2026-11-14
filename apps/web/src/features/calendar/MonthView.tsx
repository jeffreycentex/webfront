import { useEffect, useMemo, useRef } from 'react';
import { colourStyle, cx, useIsPhone } from '@/ui';
import {
  buildMonthGrid,
  moveCursor,
  weekdayOrder,
  type DayItem,
  type WeekStart,
  type Ymd,
} from './dates';
import { formatDay, formatWeekdayShort, formatTime } from './format';
import type { CalendarEvent, CalendarFeed } from './model';
import { DayList } from './EventCard';

const MAX_CHIPS = 3;
const MAX_DOTS = 4;

export interface MonthViewProps {
  events: readonly CalendarEvent[];
  feedById: Map<string, CalendarFeed>;
  today: Ymd;
  zone: string;
  weekStart: WeekStart;
  /** The selected day; its month is the one displayed. */
  cursor: Ymd;
  onCursor: (day: Ymd) => void;
  onOpenEvent: (event: CalendarEvent, el: HTMLElement) => void;
  /** Open the "all events of this day" popover (desktop). */
  onOpenDay: (day: Ymd, el: HTMLElement) => void;
  onToday: () => void;
}

function colourOf(feedById: Map<string, CalendarFeed>, item: DayItem<CalendarEvent>) {
  return feedById.get(item.event.feedId)?.colour ?? 'blue';
}

/**
 * Month grid. Desktop: coloured chips per day with "+n more". Phone: a compact dot grid and the
 * selected day's events listed underneath. Arrow keys move the selected day, Home/End jump to the
 * week edges, PageUp/PageDown change month, Enter opens the day, `t` returns to today.
 */
export function MonthView({
  events,
  feedById,
  today,
  zone,
  weekStart,
  cursor,
  onCursor,
  onOpenEvent,
  onOpenDay,
  onToday,
}: MonthViewProps) {
  const phone = useIsPhone();
  const grid = useMemo(
    () => buildMonthGrid(cursor, events, { weekStart, today, zone }),
    [cursor, events, weekStart, today, zone],
  );
  const cells = useRef(new Map<string, HTMLElement>());
  const focusAfterMove = useRef(false);

  useEffect(() => {
    if (focusAfterMove.current) {
      focusAfterMove.current = false;
      cells.current.get(cursor)?.focus({ preventScroll: false });
    }
  }, [cursor]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target as HTMLElement;
    if (!target.hasAttribute('data-cell')) return;
    if (e.key === 't') {
      e.preventDefault();
      focusAfterMove.current = true;
      onToday();
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!phone) onOpenDay(cursor, target);
      return;
    }
    const next = moveCursor(cursor, e.key, weekStart);
    if (next) {
      e.preventDefault();
      focusAfterMove.current = true;
      onCursor(next);
    }
  };

  const selected = grid.weeks.flat().find((c) => c.day === cursor);

  return (
    <div className="flex flex-col gap-2">
      <div
        role="grid"
        aria-label={formatDay(grid.month, 'month')}
        onKeyDown={onKeyDown}
        className="overflow-hidden rounded-md border border-line bg-surface shadow-sm"
      >
        <div role="row" className="grid grid-cols-7 border-b border-line bg-surface-2">
          {weekdayOrder(weekStart).map((wd) => (
            <div
              key={wd}
              role="columnheader"
              className="px-1.5 py-0.5 text-center text-2xs font-semibold uppercase tracking-wide text-fg-3 sm:text-left"
            >
              {formatWeekdayShort(wd)}
            </div>
          ))}
        </div>
        {grid.weeks.map((week) => (
          <div
            key={week[0]!.day}
            role="row"
            className="grid grid-cols-7 border-b border-line last:border-b-0"
          >
            {week.map((cell) => {
              const isCursor = cell.day === cursor;
              const dayNum = Number(cell.day.slice(8));
              const label = `${formatDay(cell.day, 'long')}${cell.isToday ? ', today' : ''}, ${
                cell.items.length === 0 ? 'no events' : `${cell.items.length} events`
              }`;
              return (
                <div
                  key={cell.day}
                  role="gridcell"
                  data-cell
                  data-day={cell.day}
                  ref={(el) => {
                    if (el) cells.current.set(cell.day, el);
                    else cells.current.delete(cell.day);
                  }}
                  tabIndex={isCursor ? 0 : -1}
                  aria-selected={isCursor}
                  aria-label={label}
                  onClick={(e) => {
                    onCursor(cell.day);
                    if (!phone && e.target === e.currentTarget)
                      onOpenDay(cell.day, e.currentTarget);
                  }}
                  className={cx(
                    'relative min-w-0 border-r border-line outline-none last:border-r-0',
                    phone ? 'min-h-[3.25rem] p-1' : 'min-h-[6.5rem] p-1',
                    !cell.inMonth && 'bg-surface-2/60 text-fg-3',
                    cell.isToday && 'bg-accent-soft/50',
                    isCursor && 'ring-2 ring-inset ring-accent',
                    'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
                  )}
                >
                  <div
                    className={cx('flex items-center', phone ? 'justify-center' : 'justify-start')}
                  >
                    <span
                      className={cx(
                        'inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs tabular-nums',
                        cell.isToday
                          ? 'bg-accent font-semibold text-accent-fg'
                          : cell.inMonth
                            ? 'font-medium text-fg'
                            : 'text-fg-3',
                      )}
                    >
                      {dayNum === 1 && !phone ? `${formatDay(cell.day, 'month-short')} 1` : dayNum}
                    </span>
                  </div>
                  {phone ? (
                    <div className="mt-0.5 flex flex-wrap justify-center gap-0.5" aria-hidden>
                      {cell.items.slice(0, MAX_DOTS).map((item) => (
                        <span
                          key={item.event.id}
                          style={colourStyle(colourOf(feedById, item))}
                          className="size-1.5 rounded-full bg-[var(--c)]"
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="mt-0.5 flex flex-col gap-px">
                      {cell.items.slice(0, MAX_CHIPS).map((item) => (
                        <button
                          key={`${item.event.id}`}
                          type="button"
                          tabIndex={-1}
                          onClick={(e) => {
                            e.stopPropagation();
                            onCursor(cell.day);
                            onOpenEvent(item.event, e.currentTarget);
                          }}
                          style={colourStyle(colourOf(feedById, item))}
                          title={item.event.title}
                          className={cx(
                            'flex h-[18px] w-full min-w-0 items-center gap-1 rounded-sm border-l-[3px] border-[color:var(--c)] bg-[var(--c-soft)] px-1 text-left text-2xs leading-none text-fg hover:brightness-95',
                            !cell.inMonth && 'opacity-70',
                          )}
                        >
                          {!item.isFirstDay && <span aria-hidden>{'◂'}</span>}
                          {!item.span.allDay && item.isFirstDay && (
                            <span className="shrink-0 tabular-nums text-fg-2">
                              {formatTime(item.span.startMs, zone)
                                .replace(/\s?([AP])M$/i, '$1')
                                .toLowerCase()}
                            </span>
                          )}
                          <span className="truncate font-medium">{item.event.title}</span>
                        </button>
                      ))}
                      {cell.items.length > MAX_CHIPS && (
                        <button
                          type="button"
                          tabIndex={-1}
                          onClick={(e) => {
                            e.stopPropagation();
                            onCursor(cell.day);
                            onOpenDay(cell.day, e.currentTarget);
                          }}
                          className="self-start rounded-sm px-1 text-2xs font-medium text-accent-text hover:underline"
                        >
                          +{cell.items.length - MAX_CHIPS} more
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {phone && selected && (
        <section className="overflow-hidden rounded-md border border-line bg-surface shadow-sm">
          <h3 className="bg-surface-2 px-3 py-1 text-xs font-semibold text-fg-2">
            {formatDay(selected.day, 'long')}
          </h3>
          <DayList items={selected.items} feedById={feedById} zone={zone} onOpen={onOpenEvent} />
        </section>
      )}
    </div>
  );
}
