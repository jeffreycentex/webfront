import { deviceZone, diffDays, parseYmd, type DayItem, type EventLike, type Ymd } from './dates';

/** Formatting helpers. Day labels are built from the calendar date (zone independent). */

const noonUtc = (ymd: Ymd) => {
  const { y, m, d } = parseYmd(ymd);
  return new Date(Date.UTC(y, m - 1, d, 12));
};

export function formatDay(
  ymd: Ymd,
  style:
    'weekday-short' | 'long' | 'month' | 'month-short' | 'weekday-narrow' | 'day' = 'weekday-short',
): string {
  const d = noonUtc(ymd);
  const opts: Intl.DateTimeFormatOptions =
    style === 'long'
      ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }
      : style === 'month'
        ? { month: 'long', year: 'numeric' }
        : style === 'month-short'
          ? { month: 'short' }
          : style === 'weekday-narrow'
            ? { weekday: 'narrow' }
            : style === 'day'
              ? { day: 'numeric' }
              : { weekday: 'short', day: 'numeric', month: 'short' };
  return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: 'UTC' }).format(d);
}

export function formatWeekdayShort(weekday: number): string {
  // 2023-01-01 was a Sunday.
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2023, 0, 1 + weekday, 12)),
  );
}

/** "Today", "Tomorrow", "Yesterday" or null. */
export function relativeDayLabel(ymd: Ymd, today: Ymd): string | null {
  const d = diffDays(today, ymd);
  return d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : d === -1 ? 'Yesterday' : null;
}

export function formatTime(ms: number, zone: string = deviceZone()): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: zone,
  }).format(new Date(ms));
}

/** Compact time for a row: "9:00 AM", "All day", or "until 3:00 PM" for a continuing event. */
export function timeLabel(item: DayItem<EventLike>, zone: string = deviceZone()): string {
  const { span } = item;
  if (span.allDay) return item.dayCount > 1 ? `Day ${item.dayNumber}/${item.dayCount}` : 'All day';
  if (!item.isFirstDay) return item.isLastDay ? `until ${formatTime(span.endMs, zone)}` : 'All day';
  return formatTime(span.startMs, zone);
}

/** Full "when" line for the details popover. */
export function whenLabel(event: EventLike, zone: string = deviceZone()): string {
  if (event.allDay) {
    const start = event.start.slice(0, 10);
    const endExclusive = event.end ? event.end.slice(0, 10) : null;
    const last = endExclusive && endExclusive > start ? lastDay(endExclusive) : start;
    return last === start
      ? `${formatDay(start, 'long')} (all day)`
      : `${formatDay(start, 'weekday-short')} to ${formatDay(last, 'weekday-short')} (all day)`;
  }
  const startMs = Date.parse(event.start);
  const endMs = event.end ? Date.parse(event.end) : NaN;
  const dayOf = (ms: number) =>
    new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: zone,
    }).format(new Date(ms));
  const tz = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short', timeZone: zone })
    .formatToParts(new Date(startMs))
    .find((p) => p.type === 'timeZoneName')?.value;
  if (Number.isNaN(endMs) || endMs <= startMs) {
    return `${dayOf(startMs)}, ${formatTime(startMs, zone)}${tz ? ` ${tz}` : ''}`;
  }
  const sameDay = dayOf(startMs) === dayOf(endMs - 1) || dayOf(startMs) === dayOf(endMs);
  return sameDay
    ? `${dayOf(startMs)}, ${formatTime(startMs, zone)} to ${formatTime(endMs, zone)}${tz ? ` ${tz}` : ''}`
    : `${dayOf(startMs)}, ${formatTime(startMs, zone)} to ${dayOf(endMs)}, ${formatTime(endMs, zone)}${tz ? ` ${tz}` : ''}`;
}

function lastDay(endExclusive: Ymd): Ymd {
  const { y, m, d } = parseYmd(endExclusive);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}
