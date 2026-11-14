import { CalendarDays, ChevronLeft, ChevronRight, RefreshCw, Settings2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import {
  Button,
  DropdownMenu,
  EmptyState,
  IconButton,
  Modal,
  PageHeader,
  Skeleton,
  Spinner,
  Tabs,
  cx,
  colourStyle,
  useHotkeys,
  useIsPhone,
  useOnline,
  useToast,
} from '@/ui';
import { AgendaView } from './AgendaView';
import { DayDetails, EventDetails } from './EventCard';
import { FeedManager } from './FeedManager';
import { MonthView } from './MonthView';
import { addMonths, deviceZone, itemsByDay, type Ymd } from './dates';
import { formatDay } from './format';
import {
  feedColour,
  toggleFeedHidden,
  useCalendar,
  useNow,
  useWeekStart,
  type CalendarEvent,
} from './model';
import { refreshCalendars } from './refresh';
import { todayYmd } from './dates';

type View = 'agenda' | 'month';

type Popover =
  | { kind: 'event'; event: CalendarEvent; el: HTMLElement }
  | { kind: 'day'; day: Ymd; el: HTMLElement };

const YMD = /^\d{4}-\d{2}-\d{2}$/;

interface NavState {
  jump?: number;
  refresh?: number;
  addFeed?: number;
}

export function CalendarPage() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const { toast } = useToast();
  const online = useOnline();
  const phone = useIsPhone();
  const zone = useMemo(() => deviceZone(), []);
  const now = useNow();
  const today = todayYmd(now);
  const cal = useCalendar();
  const [weekStart, setWeekStart] = useWeekStart();

  const view: View = params.get('view') === 'month' ? 'month' : 'agenda';
  const dateParam = params.get('date');
  const focusDay = dateParam && YMD.test(dateParam) ? dateParam : null;

  const [cursor, setCursor] = useState<Ymd>(focusDay ?? today);
  const [jumpKey, setJumpKey] = useState(0);
  const [popover, setPopover] = useState<Popover | null>(null);
  const [feedsOpen, setFeedsOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const setView = useCallback(
    (next: View) =>
      setParams(
        (p) => {
          const q = new URLSearchParams(p);
          if (next === 'agenda') q.delete('view');
          else q.set('view', next);
          return q;
        },
        { replace: true },
      ),
    [setParams],
  );

  const goToday = useCallback(() => {
    setCursor(todayYmd());
    setJumpKey((k) => k + 1);
    setPopover(null);
    setParams(
      (p) => {
        const q = new URLSearchParams(p);
        q.delete('date');
        return q;
      },
      { replace: true },
    );
  }, [setParams]);

  // Search results link here with ?date=YYYY-MM-DD.
  useEffect(() => {
    if (focusDay) {
      setCursor(focusDay);
      setJumpKey((k) => k + 1);
    }
  }, [focusDay]);

  const doRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await refreshCalendars();
      toast(
        res.ok
          ? { title: 'Calendars refreshed', description: `${res.events} events`, tone: 'success' }
          : {
              title: 'Some calendars could not be refreshed',
              description: res.error ?? undefined,
              tone: 'error',
            },
      );
    } catch (err) {
      toast({ title: 'Refresh failed', description: (err as Error).message, tone: 'error' });
    } finally {
      setRefreshing(false);
    }
  }, [toast]);

  // Commands navigate here with a timestamp in location.state.
  const handled = useRef<NavState>({});
  useEffect(() => {
    const s = (location.state ?? {}) as NavState;
    if (s.jump && s.jump !== handled.current.jump) goToday();
    if (s.refresh && s.refresh !== handled.current.refresh) void doRefresh();
    if (s.addFeed && s.addFeed !== handled.current.addFeed) {
      setAdding(true);
      setFeedsOpen(true);
    }
    handled.current = s;
  }, [location.state, goToday, doRefresh]);

  useHotkeys({
    t: goToday,
    a: () => setView('agenda'),
    m: () => setView('month'),
  });

  const closePopover = () => setPopover(null);
  const openEvent = (event: CalendarEvent, el: HTMLElement) =>
    setPopover({ kind: 'event', event, el });
  const openDay = (day: Ymd, el: HTMLElement) => setPopover({ kind: 'day', day, el });

  const popoverDayItems = useMemo(() => {
    if (popover?.kind !== 'day') return [];
    return itemsByDay(cal.visibleEvents, popover.day, popover.day, zone).get(popover.day) ?? [];
  }, [popover, cal.visibleEvents, zone]);

  const shownFeeds = cal.feeds.filter((f) => f.enabled);
  const noFeeds = !cal.loading && cal.feeds.length === 0;

  return (
    <div>
      <PageHeader
        title="Calendar"
        icon={<CalendarDays aria-hidden />}
        actions={
          <>
            <IconButton
              label={online ? 'Refresh calendars' : 'Refresh calendars (offline)'}
              icon={refreshing ? <Spinner /> : <RefreshCw />}
              disabled={!online || refreshing || shownFeeds.length === 0}
              onClick={() => void doRefresh()}
            />
            <DropdownMenu
              trigger={<IconButton label="Calendar options" icon={<Settings2 />} />}
              items={[
                {
                  label: 'Week starts on Monday',
                  checked: weekStart === 'monday',
                  onSelect: () => setWeekStart('monday'),
                },
                {
                  label: 'Week starts on Sunday',
                  checked: weekStart === 'sunday',
                  onSelect: () => setWeekStart('sunday'),
                },
                'separator',
                {
                  label: 'Manage feeds…',
                  onSelect: () => {
                    setAdding(false);
                    setFeedsOpen(true);
                  },
                },
              ]}
            />
          </>
        }
      >
        <Tabs
          variant="pill"
          label="Calendar view"
          value={view}
          onValueChange={(v) => setView(v === 'month' ? 'month' : 'agenda')}
          items={[
            { id: 'agenda', label: 'Agenda' },
            { id: 'month', label: 'Month' },
          ]}
        />
        <Button size="sm" onClick={goToday}>
          Today
        </Button>
        {view === 'month' && (
          <span className="flex items-center gap-0.5">
            <IconButton
              label="Previous month"
              size="sm"
              icon={<ChevronLeft />}
              onClick={() => setCursor((c) => addMonths(c, -1))}
            />
            <h2 className="min-w-28 text-center text-sm font-semibold" aria-live="polite">
              {formatDay(cursor, 'month')}
            </h2>
            <IconButton
              label="Next month"
              size="sm"
              icon={<ChevronRight />}
              onClick={() => setCursor((c) => addMonths(c, 1))}
            />
          </span>
        )}
      </PageHeader>

      {shownFeeds.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1" aria-label="Calendars">
          {shownFeeds.map((feed) => {
            const off = cal.hidden.has(feed.id);
            return (
              <li key={feed.id}>
                <button
                  type="button"
                  aria-pressed={!off}
                  title={off ? `Show ${feed.name}` : `Hide ${feed.name}`}
                  onClick={() => toggleFeedHidden(feed.id)}
                  style={colourStyle(feed.colour)}
                  className={cx(
                    'inline-flex h-5 max-w-48 items-center gap-1.5 rounded-full border px-2 text-xs max-sm:h-8',
                    off
                      ? 'border-line bg-transparent text-fg-3 line-through'
                      : 'border-[color:var(--c)] bg-[var(--c-soft)] font-medium text-fg',
                  )}
                >
                  <span
                    aria-hidden
                    className={cx(
                      'size-2 shrink-0 rounded-full',
                      off ? 'border border-[color:var(--c)]' : 'bg-[var(--c)]',
                    )}
                  />
                  <span className="truncate">{feed.name}</span>
                  {feed.lastError && feed.enabled && (
                    <span
                      className="size-1.5 shrink-0 rounded-full bg-bad"
                      title={feed.lastError}
                    />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {cal.loading ? (
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-6" />
          <Skeleton className="h-6" />
          <Skeleton className="h-6" />
        </div>
      ) : noFeeds ? (
        <div className="rounded-md border border-line bg-surface">
          <EmptyState
            title="No calendars yet"
            icon={<CalendarDays />}
            action={
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  setAdding(true);
                  setFeedsOpen(true);
                }}
              >
                Add calendar feed
              </Button>
            }
          >
            Paste the ICS link of an Outlook or Google calendar. Events then work offline on every
            device.
          </EmptyState>
        </div>
      ) : view === 'agenda' ? (
        <AgendaView
          events={cal.visibleEvents}
          feedById={cal.feedById}
          today={today}
          now={now}
          zone={zone}
          onOpen={openEvent}
          focusDay={focusDay}
          jumpKey={jumpKey}
        />
      ) : (
        <MonthView
          events={cal.visibleEvents}
          feedById={cal.feedById}
          today={today}
          zone={zone}
          weekStart={weekStart}
          cursor={cursor}
          onCursor={setCursor}
          onOpenEvent={openEvent}
          onOpenDay={openDay}
          onToday={goToday}
        />
      )}
      {!phone && view === 'month' && !noFeeds && !cal.loading && (
        <p className="mt-1.5 text-2xs text-fg-3">
          Arrow keys move, Enter opens a day, PageUp and PageDown change month, T jumps to today.
        </p>
      )}

      {popover?.kind === 'event' && (
        <EventDetails
          event={popover.event}
          feed={cal.feedById.get(popover.event.feedId)}
          colour={feedColour(cal.feedById.get(popover.event.feedId))}
          anchor={popover.el}
          zone={zone}
          onClose={closePopover}
        />
      )}
      {popover?.kind === 'day' && (
        <DayDetails
          day={popover.day}
          items={popoverDayItems}
          feedById={cal.feedById}
          anchor={popover.el}
          zone={zone}
          onClose={closePopover}
          onOpen={openEvent}
        />
      )}

      <Modal open={feedsOpen} onClose={() => setFeedsOpen(false)} title="Calendar feeds" size="lg">
        <FeedManager key={adding ? 'add' : 'list'} startAdding={adding} />
      </Modal>
    </div>
  );
}
