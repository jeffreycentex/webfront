/**
 * Pure calendar maths for the agenda and month views.
 *
 * Days are `YYYY-MM-DD` strings ("Ymd") and all day arithmetic goes through `Date.UTC`, so the
 * device zone and DST can never shift a result. Timed events are UTC instants and are placed on
 * days in a caller-supplied IANA `zone` (default: the device zone), which is what makes the
 * grouping testable across time zones. All-day events carry plain dates and never move.
 */

export type Ymd = string;
export type WeekStart = 'monday' | 'sunday';

/** The fields of a calendar event the views need (a subset of the synced record). */
export interface EventLike {
  id: string;
  title: string;
  allDay: boolean;
  /** ISO UTC instant for timed events, `YYYY-MM-DD` for all-day events. */
  start: string;
  /** Exclusive end, same format; null when the feed gave none. */
  end: string | null;
}

const DAY_MS = 86_400_000;
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function deviceZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(zone: string): Intl.DateTimeFormat {
  let f = dayFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    dayFormatters.set(zone, f);
  }
  return f;
}

/** Calendar day and minutes since local midnight of an instant in `zone`. */
export function zonedParts(ms: number, zone: string = deviceZone()): { ymd: Ymd; minutes: number } {
  const parts = dayFormatter(zone).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return {
    ymd: `${pad(get('year'), 4)}-${pad(get('month'))}-${pad(get('day'))}`,
    minutes: (get('hour') % 24) * 60 + get('minute'),
  };
}

export function ymdOf(ms: number, zone?: string): Ymd {
  return zonedParts(ms, zone).ymd;
}

export function todayYmd(now: number = Date.now(), zone?: string): Ymd {
  return ymdOf(now, zone);
}

export function parseYmd(ymd: Ymd): { y: number; m: number; d: number } {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return { y, m, d };
}

export function toYmd(y: number, m: number, d: number): Ymd {
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
}

const utcMs = (ymd: Ymd) => {
  const { y, m, d } = parseYmd(ymd);
  return Date.UTC(y, m - 1, d);
};

export function addDays(ymd: Ymd, n: number): Ymd {
  return new Date(utcMs(ymd) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function diffDays(a: Ymd, b: Ymd): number {
  return Math.round((utcMs(b) - utcMs(a)) / DAY_MS);
}

/** 0 = Sunday ... 6 = Saturday. */
export function weekdayOf(ymd: Ymd): number {
  return new Date(utcMs(ymd)).getUTCDay();
}

export function startOfWeek(ymd: Ymd, weekStart: WeekStart): Ymd {
  const wd = weekdayOf(ymd);
  const back = weekStart === 'monday' ? (wd + 6) % 7 : wd;
  return addDays(ymd, -back);
}

export function startOfMonth(ymd: Ymd): Ymd {
  const { y, m } = parseYmd(ymd);
  return toYmd(y, m, 1);
}

export function daysInMonth(ymd: Ymd): number {
  const { y, m } = parseYmd(ymd);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Same day-of-month `n` months away, clamped to the target month's length. */
export function addMonths(ymd: Ymd, n: number): Ymd {
  const { y, m, d } = parseYmd(ymd);
  const first = toYmd(y, m + n, 1);
  return addDays(first, Math.min(d, daysInMonth(first)) - 1);
}

export function sameMonth(a: Ymd, b: Ymd): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}

/* ------------------------------------------------------------------------------------------ */

export interface EventSpan {
  allDay: boolean;
  /** Instant of the start (all-day: UTC midnight of the date, only used for ordering). */
  startMs: number;
  /** Instant of the exclusive end (equals startMs when the event has no end). */
  endMs: number;
  /** First and last calendar day the event occupies in the viewer's zone (inclusive). */
  startDay: Ymd;
  lastDay: Ymd;
  /** Minutes since midnight in the zone (timed events only; 0 for all-day). */
  startMinutes: number;
  endMinutes: number;
}

export function spanOf(event: EventLike, zone: string = deviceZone()): EventSpan {
  if (event.allDay) {
    const startDay = event.start.slice(0, 10);
    const endExclusive = event.end ? event.end.slice(0, 10) : addDays(startDay, 1);
    const lastDay = endExclusive > startDay ? addDays(endExclusive, -1) : startDay;
    return {
      allDay: true,
      startMs: utcMs(startDay),
      endMs: utcMs(addDays(lastDay, 1)),
      startDay,
      lastDay,
      startMinutes: 0,
      endMinutes: 0,
    };
  }
  const startMs = Date.parse(event.start);
  const rawEnd = event.end ? Date.parse(event.end) : startMs;
  const endMs = Number.isNaN(rawEnd) || rawEnd < startMs ? startMs : rawEnd;
  const s = zonedParts(startMs, zone);
  // The end is exclusive: an event ending exactly at midnight does not occupy the next day.
  const e = endMs > startMs ? zonedParts(endMs - 1, zone) : s;
  const endLocal = endMs > startMs ? zonedParts(endMs, zone) : s;
  return {
    allDay: false,
    startMs,
    endMs,
    startDay: s.ymd,
    lastDay: e.ymd,
    startMinutes: s.minutes,
    endMinutes: endLocal.minutes,
  };
}

/** One event as it appears on one day. */
export interface DayItem<T extends EventLike = EventLike> {
  event: T;
  span: EventSpan;
  day: Ymd;
  /** The event began on this day (otherwise it continues from an earlier day). */
  isFirstDay: boolean;
  /** The event ends on this day. */
  isLastDay: boolean;
  /** 1-based position among the days the event covers, and how many there are. */
  dayNumber: number;
  dayCount: number;
}

/** Sort within a day: all-day (multi-day first), then by start time, then title. */
export function compareDayItems(a: DayItem, b: DayItem): number {
  if (a.span.allDay !== b.span.allDay) return a.span.allDay ? -1 : 1;
  if (a.span.allDay) {
    const la = diffDays(a.span.startDay, a.span.lastDay);
    const lb = diffDays(b.span.startDay, b.span.lastDay);
    if (la !== lb) return lb - la;
  } else if (a.span.startMs !== b.span.startMs) {
    // Events continuing from earlier days sort before ones starting today.
    if (a.isFirstDay !== b.isFirstDay) return a.isFirstDay ? 1 : -1;
    return a.span.startMs - b.span.startMs;
  }
  return a.event.title.localeCompare(b.event.title) || a.event.id.localeCompare(b.event.id);
}

/** Longest span (in days) we expand per event; a guard against malformed feeds. */
const MAX_SPAN_DAYS = 120;

/**
 * Place events on days within [fromDay, toDay] (inclusive). Multi-day and midnight-crossing
 * events appear on every day they occupy. Days with no items are absent from the map.
 */
export function itemsByDay<T extends EventLike>(
  events: readonly T[],
  fromDay: Ymd,
  toDay: Ymd,
  zone: string = deviceZone(),
): Map<Ymd, DayItem<T>[]> {
  const out = new Map<Ymd, DayItem<T>[]>();
  for (const event of events) {
    const span = spanOf(event, zone);
    if (span.lastDay < fromDay || span.startDay > toDay) continue;
    const dayCount = Math.min(diffDays(span.startDay, span.lastDay) + 1, MAX_SPAN_DAYS);
    const first = span.startDay < fromDay ? fromDay : span.startDay;
    const last = span.lastDay > toDay ? toDay : span.lastDay;
    for (let day = first, guard = 0; day <= last && guard < MAX_SPAN_DAYS * 4; guard++) {
      const dayNumber = diffDays(span.startDay, day) + 1;
      if (dayNumber <= dayCount) {
        const list = out.get(day) ?? [];
        list.push({
          event,
          span,
          day,
          isFirstDay: day === span.startDay,
          isLastDay: day === span.lastDay,
          dayNumber,
          dayCount,
        });
        out.set(day, list);
      }
      day = addDays(day, 1);
    }
  }
  for (const list of out.values()) list.sort(compareDayItems);
  return out;
}

export interface AgendaGroup<T extends EventLike = EventLike> {
  day: Ymd;
  isToday: boolean;
  items: DayItem<T>[];
}

/**
 * Agenda: day groups from `from` to `to` (inclusive) that have events, plus `today` when it is
 * inside the range even if it has none (so "jump to today" always has a target).
 */
export function groupAgenda<T extends EventLike>(
  events: readonly T[],
  options: { from: Ymd; to: Ymd; today: Ymd; zone?: string },
): AgendaGroup<T>[] {
  const { from, to, today, zone } = options;
  const map = itemsByDay(events, from, to, zone);
  const days = new Set(map.keys());
  if (today >= from && today <= to) days.add(today);
  return [...days]
    .sort()
    .map((day) => ({ day, isToday: day === today, items: map.get(day) ?? [] }));
}

/* ------------------------------------------------------------------------------------------ */

export interface MonthCell<T extends EventLike = EventLike> {
  day: Ymd;
  inMonth: boolean;
  isToday: boolean;
  items: DayItem<T>[];
}

export interface MonthGrid<T extends EventLike = EventLike> {
  /** First day of the displayed month. */
  month: Ymd;
  first: Ymd;
  last: Ymd;
  weeks: MonthCell<T>[][];
}

/** Weeks (rows of 7) covering the month containing `anchor`, padded to whole weeks. */
export function buildMonthGrid<T extends EventLike>(
  anchor: Ymd,
  events: readonly T[],
  options: { weekStart: WeekStart; today: Ymd; zone?: string },
): MonthGrid<T> {
  const month = startOfMonth(anchor);
  const first = startOfWeek(month, options.weekStart);
  const lastOfMonth = addDays(month, daysInMonth(month) - 1);
  const weekCount = Math.ceil((diffDays(first, lastOfMonth) + 1) / 7);
  const last = addDays(first, weekCount * 7 - 1);
  const map = itemsByDay(events, first, last, options.zone);
  const weeks: MonthCell<T>[][] = [];
  for (let w = 0; w < weekCount; w++) {
    const row: MonthCell<T>[] = [];
    for (let d = 0; d < 7; d++) {
      const day = addDays(first, w * 7 + d);
      row.push({
        day,
        inMonth: sameMonth(day, month),
        isToday: day === options.today,
        items: map.get(day) ?? [],
      });
    }
    weeks.push(row);
  }
  return { month, first, last, weeks };
}

/** Weekday indexes (0 = Sunday) in display order for a week start. */
export function weekdayOrder(weekStart: WeekStart): number[] {
  return weekStart === 'monday' ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];
}

/** Next month-grid cursor for a keyboard key, or null when the key is not a navigation key. */
export function moveCursor(cursor: Ymd, key: string, weekStart: WeekStart): Ymd | null {
  switch (key) {
    case 'ArrowLeft':
      return addDays(cursor, -1);
    case 'ArrowRight':
      return addDays(cursor, 1);
    case 'ArrowUp':
      return addDays(cursor, -7);
    case 'ArrowDown':
      return addDays(cursor, 7);
    case 'Home':
      return startOfWeek(cursor, weekStart);
    case 'End':
      return addDays(startOfWeek(cursor, weekStart), 6);
    case 'PageUp':
      return addMonths(cursor, -1);
    case 'PageDown':
      return addMonths(cursor, 1);
    default:
      return null;
  }
}
