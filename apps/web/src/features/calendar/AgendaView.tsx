import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, EmptyState, cx } from '@/ui';
import { addDays, groupAgenda, type Ymd } from './dates';
import { formatDay, relativeDayLabel } from './format';
import type { CalendarEvent, CalendarFeed } from './model';
import { AgendaRow } from './rows';

const PAST_STEP = 14;
const PAST_MAX = 30;
const AHEAD_START = 45;
const AHEAD_STEP = 60;
const AHEAD_MAX = 180;

export interface AgendaViewProps {
  events: readonly CalendarEvent[];
  feedById: Map<string, CalendarFeed>;
  today: Ymd;
  now: number;
  zone: string;
  onOpen: (event: CalendarEvent, el: HTMLElement) => void;
  /** Day to scroll to when `jumpKey` changes (defaults to today). */
  focusDay?: Ymd | null;
  jumpKey?: number;
}

/** Dense, day-grouped list. Starts at today; earlier and later ranges load on demand. */
export function AgendaView({
  events,
  feedById,
  today,
  now,
  zone,
  onOpen,
  focusDay,
  jumpKey = 0,
}: AgendaViewProps) {
  const [past, setPast] = useState(0);
  const [ahead, setAhead] = useState(AHEAD_START);
  const root = useRef<HTMLDivElement>(null);

  // A focus day outside the loaded range widens it.
  useEffect(() => {
    if (!focusDay) return;
    const back = Math.min(
      PAST_MAX,
      Math.max(0, Math.ceil((Date.parse(today) - Date.parse(focusDay)) / 86_400_000)),
    );
    if (back > 0) setPast((p) => Math.max(p, back));
    const fwd = Math.ceil((Date.parse(focusDay) - Date.parse(today)) / 86_400_000);
    if (fwd > 0) setAhead((a) => Math.min(AHEAD_MAX, Math.max(a, fwd + 7)));
  }, [focusDay, today]);

  const from = addDays(today, -past);
  const to = addDays(today, ahead);
  const groups = useMemo(
    () => groupAgenda(events, { from, to, today, zone }),
    [events, from, to, today, zone],
  );

  // Scroll to the focus day (or today) on mount and whenever a jump is requested.
  useEffect(() => {
    const target = focusDay ?? today;
    const el = root.current?.querySelector<HTMLElement>(`[data-day="${target}"]`);
    el?.scrollIntoView?.({ block: 'start', behavior: jumpKey > 0 ? 'smooth' : 'auto' });
    // Only on explicit jumps; not on every data change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpKey]);

  const hasAny = groups.some((g) => g.items.length > 0);

  return (
    <div ref={root} className="flex flex-col gap-1.5">
      {past < PAST_MAX && (
        <Button
          variant="ghost"
          size="sm"
          className="self-center"
          onClick={() => setPast((p) => Math.min(PAST_MAX, p + PAST_STEP))}
        >
          Show earlier events
        </Button>
      )}
      <div className="overflow-hidden rounded-md border border-line bg-surface shadow-sm">
        {groups.map((group) => {
          const rel = relativeDayLabel(group.day, today);
          const isPast = group.day < today;
          return (
            <section
              key={group.day}
              data-day={group.day}
              className="scroll-mt-2 border-b border-line last:border-b-0"
            >
              <h3
                className={cx(
                  'flex min-h-6 items-center gap-2 px-2 py-0.5 text-xs font-semibold max-sm:px-3',
                  group.isToday ? 'bg-accent-soft text-accent-text' : 'bg-surface-2 text-fg-2',
                  isPast && 'text-fg-3',
                )}
              >
                <span>{formatDay(group.day)}</span>
                {rel && (
                  <Badge tone={group.isToday ? 'accent' : 'neutral'} className="font-medium">
                    {rel}
                  </Badge>
                )}
                {group.items.length > 0 && (
                  <span className="ml-auto font-normal text-fg-3">{group.items.length}</span>
                )}
              </h3>
              {group.items.length === 0 ? (
                <p className="px-3 py-1 text-xs text-fg-3">Nothing scheduled.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {group.items.map((item) => {
                    const feed = feedById.get(item.event.feedId);
                    const ended = item.isLastDay && !item.span.allDay && item.span.endMs <= now;
                    return (
                      <AgendaRow
                        key={`${item.event.id}:${item.day}`}
                        item={item}
                        colour={feed?.colour ?? 'blue'}
                        zone={zone}
                        past={isPast || ended}
                        onOpen={onOpen}
                        {...(feed ? { feedName: feed.name } : {})}
                      />
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
        {!hasAny && (
          <EmptyState title="No events in this range">
            Events from your enabled calendars appear here.
          </EmptyState>
        )}
      </div>
      {ahead < AHEAD_MAX && (
        <Button
          variant="ghost"
          size="sm"
          className="self-center"
          onClick={() => setAhead((a) => Math.min(AHEAD_MAX, a + AHEAD_STEP))}
        >
          Show later events
        </Button>
      )}
    </div>
  );
}
