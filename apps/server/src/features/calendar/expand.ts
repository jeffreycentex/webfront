import { createHash } from 'node:crypto';
import {
  CALENDAR_WINDOW_DAYS_AHEAD,
  CALENDAR_WINDOW_DAYS_BACK,
  type FieldsOf,
} from '@webfront/shared';
import ical from 'node-ical';
import type { DateWithTimeZone, ParameterValue, VEvent } from 'node-ical';
import { instantForWallClock, isValidZone, systemZone, wallClockIn } from './tz.js';

/**
 * ICS text -> concrete occurrences inside the rolling window.
 *
 * - Timed events become UTC instants (`start`/`end`) plus the original IANA zone in `tz`.
 *   node-ical resolves TZID (including Outlook's Windows names via its mapping table and
 *   VTIMEZONE blocks), RRULE, EXDATE and RECURRENCE-ID overrides.
 * - All-day events become local calendar dates (`YYYY-MM-DD`, exclusive end) and never shift.
 * - Floating times (no TZID, no Z) are read in X-WR-TIMEZONE when the feed names one, else in the
 *   server's own zone.
 * - Cancelled events and cancelled instances are dropped.
 */

const DAY_MS = 86_400_000;
/** Safety cap per feed so a runaway rule cannot flood the sync stream. */
export const MAX_EVENTS_PER_FEED = 5000;

type EventFields = FieldsOf<'calendarEvents'>;

export interface ExpandedEvent {
  /** Deterministic UUID from feed + UID + recurrence instance. */
  id: string;
  fields: EventFields;
}

export interface ExpandResult {
  events: ExpandedEvent[];
  /** Components that could not be expanded (bad data); never fails the whole feed. */
  skipped: number;
  /** True when MAX_EVENTS_PER_FEED truncated the result. */
  truncated: boolean;
}

export interface ExpandOptions {
  feedId: string;
  now: Date;
  /** Override for floating times (tests); defaults to X-WR-TIMEZONE then the system zone. */
  floatingZone?: string;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Local (process zone) calendar date of a node-ical date-only value. */
function localYmd(d: Date): string {
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function text(v: ParameterValue | undefined | null): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  const val = (v as { val?: unknown }).val;
  return val === undefined || val === null ? '' : String(val);
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function safeHttpUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = text(raw as ParameterValue).trim();
  if (!s || s.length > 4096) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function occurrenceId(feedId: string, uid: string, instanceKey: string): string {
  const hex = createHash('sha256').update(`${feedId}\n${uid}\n${instanceKey}`).digest('hex');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function normaliseZone(tz: string | undefined): string | null {
  if (!tz) return null;
  if (tz === 'Etc/UTC' || tz === 'Etc/GMT' || tz === 'Z') return 'UTC';
  return isValidZone(tz) ? tz : null;
}

export function expandIcs(body: string, options: ExpandOptions): ExpandResult {
  const parsed = ical.parseICS(body);
  const calZone = (parsed.vcalendar as { 'WR-TIMEZONE'?: string } | undefined)?.['WR-TIMEZONE'];
  const floatingZone = options.floatingZone ?? (isValidZone(calZone) ? calZone : null);
  const sysZone = systemZone();
  const reinterpretFloating = floatingZone && floatingZone !== sysZone ? floatingZone : null;

  const fromMs = options.now.getTime() - CALENDAR_WINDOW_DAYS_BACK * DAY_MS;
  const toMs = options.now.getTime() + CALENDAR_WINDOW_DAYS_AHEAD * DAY_MS;
  const from = new Date(fromMs);
  const to = new Date(toMs);
  const fromDay = from.toISOString().slice(0, 10);
  const toDay = to.toISOString().slice(0, 10);

  const out = new Map<string, ExpandedEvent>();
  let skipped = 0;

  const isFloating = (d: DateWithTimeZone) => !d.tz && !d.dateOnly;
  /** node-ical read the floating wall clock in the process zone; re-read it in `reinterpretFloating`. */
  const fixFloating = (d: DateWithTimeZone): number => {
    if (!reinterpretFloating || !isFloating(d)) return d.getTime();
    return instantForWallClock(
      {
        year: d.getFullYear(),
        month: d.getMonth() + 1,
        day: d.getDate(),
        hour: d.getHours(),
        minute: d.getMinutes(),
        second: d.getSeconds(),
      },
      reinterpretFloating,
    );
  };

  for (const component of Object.values(parsed)) {
    if (!component || component.type !== 'VEVENT') continue;
    const master = component as VEvent;
    try {
      if (!master.uid || !master.start) continue;
      // A standalone cancelled event (no recurrence) is dropped here; cancelled instances of a
      // recurring event are dropped per instance below.
      const instances = ical.expandRecurringEvent(master, {
        from,
        to,
        expandOngoing: true,
        includeOverrides: true,
        excludeExdates: true,
      });
      for (const inst of instances) {
        const ev = inst.event;
        if (ev.status === 'CANCELLED') continue;
        const recurring = inst.isRecurring || inst.isOverride || Boolean(master.rrule);
        const allDay = inst.isFullDay || Boolean(inst.start.dateOnly);
        const rid = ev.recurrenceid as DateWithTimeZone | undefined;

        let start: string;
        let end: string | null;
        let tz: string | null = null;
        let key = '';

        if (allDay) {
          start = localYmd(inst.start);
          const rawEnd = inst.end ? localYmd(inst.end) : null;
          end = rawEnd && rawEnd > start ? rawEnd : addDaysYmd(start, 1);
          if (!(end > fromDay && start < toDay)) continue;
          if (recurring) key = rid ? (rid.dateOnly ? localYmd(rid) : rid.toISOString()) : start;
        } else {
          const startMs = fixFloating(inst.start);
          const rawEndMs = inst.end ? fixFloating(inst.end) : startMs;
          if (Number.isNaN(startMs)) continue;
          const endMs = Number.isNaN(rawEndMs) ? startMs : rawEndMs;
          if (!(Math.max(endMs, startMs) > fromMs && startMs < toMs)) continue;
          start = new Date(startMs).toISOString();
          end = endMs > startMs ? new Date(endMs).toISOString() : null;
          tz = isFloating(inst.start)
            ? (reinterpretFloating ?? null)
            : normaliseZone(inst.start.tz);
          if (recurring) {
            key = rid
              ? rid.dateOnly
                ? localYmd(rid)
                : new Date(fixFloating(rid)).toISOString()
              : start;
          }
        }

        const title = clip(text(ev.summary).trim() || '(no title)', 1000);
        const location = text(ev.location).trim();
        const description = text(ev.description).trim();
        const id = occurrenceId(options.feedId, master.uid, key);
        out.set(id, {
          id,
          fields: {
            feedId: options.feedId,
            uid: clip(master.uid, 1000),
            title,
            location: location ? clip(location, 1000) : null,
            description: description ? clip(description, 20_000) : null,
            allDay,
            start,
            end,
            url: safeHttpUrl(ev.url ?? master.url),
            recurring,
            tz,
          } as EventFields,
        });
      }
    } catch {
      skipped++;
    }
  }

  let events = [...out.values()];
  let truncated = false;
  if (events.length > MAX_EVENTS_PER_FEED) {
    events.sort((a, b) =>
      a.fields.start < b.fields.start ? -1 : a.fields.start > b.fields.start ? 1 : 0,
    );
    events = events.slice(0, MAX_EVENTS_PER_FEED);
    truncated = true;
  }
  return { events, skipped, truncated };
}

// Re-exported for tests of wall-clock behaviour.
export { wallClockIn };
