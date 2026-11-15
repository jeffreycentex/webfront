import {
  addDays,
  daysInMonth,
  diffDays,
  formatShortDate,
  parseISODate,
  SHORT_DAYS,
  SHORT_MONTHS,
  toISODate,
  todayISO,
  weekdayOf,
  weekStart,
  type ISODate,
} from './dates';
import type { Task } from './logic';

/**
 * Recurrence engine for repeating tasks. Pure functions on `YYYY-MM-DD` strings; all calendar
 * arithmetic goes through the integer helpers in dates.ts, so the process time zone and DST can
 * never change a result. The only wall-clock input is the caller's local `today` string.
 *
 * THE CONVERGENCE RULE (why two offline devices agree):
 *   nextDueDate(dueDate, rule, today) is the first occurrence of the rule STRICTLY AFTER
 *   max(dueDate, today). Occurrences are anchored on the task's current due date (never on the
 *   moment of completion), and the clock only enters as the local date. Completing the same
 *   occurrence on two devices on the same local day therefore writes the same `dueDate`, so
 *   per-field last-writer-wins converges on one advance instead of two. Completing an overdue
 *   task skips every missed cycle in one step. (Devices that complete on different local days
 *   while the task is overdue may legitimately differ by the cycles in between; that is the one
 *   unavoidable dependence on "today".)
 */

export type RepeatRule = NonNullable<Task['repeat']>;
export type RepeatUnit = RepeatRule['unit'];

const MAX_STEPS = 5000;

/** Weekdays used by a weekly rule: its own set, or the due date's weekday when empty. */
function weekdaySet(rule: RepeatRule, due: ISODate): Set<number> {
  return new Set(rule.weekdays.length ? rule.weekdays : [weekdayOf(due)]);
}

function monthlyDate(anchorY: number, anchorM: number, months: number, day: number): ISODate {
  const total = anchorY * 12 + (anchorM - 1) + months;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return toISODate(y, m, Math.min(day, daysInMonth(y, m)));
}

/**
 * The next occurrence of `rule` after completing a task due on `dueDate` (null = no due date,
 * treated as `today`). See the convergence rule above.
 */
export function nextDueDate(dueDate: ISODate | null, rule: RepeatRule, today: ISODate): ISODate {
  const base = dueDate && parseISODate(dueDate) ? dueDate : today;
  const ref = base > today ? base : today;
  const n = Math.max(1, rule.interval);

  if (rule.unit === 'day') {
    const k = Math.max(1, Math.floor(diffDays(base, ref) / n) + 1);
    return addDays(base, k * n);
  }

  if (rule.unit === 'week') {
    const days = weekdaySet(rule, base);
    const baseWeek = weekStart(base);
    const limit = 7 * n + 7;
    for (let i = 1; i <= limit; i++) {
      const d = addDays(ref, i);
      const weeks = Math.floor(diffDays(baseWeek, weekStart(d)) / 7);
      if (weeks % n === 0 && days.has(weekdayOf(d))) return d;
    }
    return addDays(ref, 7 * n); // unreachable for valid rules
  }

  // month / year: step whole months from the base's month; the day is the rule's remembered day
  // (or the due date's own) clamped to the month length.
  const p = parseISODate(base)!;
  const step = rule.unit === 'year' ? 12 * n : n;
  const day = rule.day ?? p.d;
  const pr = parseISODate(ref)!;
  const monthsApart = pr.y * 12 + pr.m - (p.y * 12 + p.m);
  let k = Math.max(0, Math.floor(monthsApart / step) - 1);
  for (let i = 0; i < MAX_STEPS; i++, k++) {
    const d = monthlyDate(p.y, p.m, k * step, day);
    if (d > ref) return d;
  }
  return addDays(ref, 31 * step);
}

/**
 * First due date for a newly set rule on a task with no due date: the first occurrence on or
 * after `from` (today by default): the next matching weekday, or the next matching day of the
 * month; otherwise `from` itself.
 */
export function firstDueDate(rule: RepeatRule, from: ISODate): ISODate {
  if (rule.unit === 'week' && rule.weekdays.length) {
    const days = new Set(rule.weekdays);
    for (let i = 0; i < 7; i++) {
      const d = addDays(from, i);
      if (days.has(weekdayOf(d))) return d;
    }
  }
  if (rule.unit === 'month' && rule.day !== null) {
    const p = parseISODate(from)!;
    const here = monthlyDate(p.y, p.m, 0, rule.day);
    return here >= from ? here : monthlyDate(p.y, p.m, rule.interval, rule.day);
  }
  return from;
}

/** Tidy a rule: clamp the interval, sort and de-duplicate weekdays, drop fields the unit ignores. */
export function normaliseRule(rule: RepeatRule): RepeatRule {
  const interval = Math.min(999, Math.max(1, Math.round(rule.interval) || 1));
  const weekdays =
    rule.unit === 'week' ? [...new Set(rule.weekdays)].filter((d) => d >= 0 && d <= 6).sort() : [];
  const day = rule.unit === 'month' || rule.unit === 'year' ? rule.day : null;
  return { unit: rule.unit, interval, weekdays, day };
}

/**
 * Make a rule explicit for a given due date: a weekly rule with no weekdays gets the due
 * date's weekday, a monthly rule with no day keeps the due date's day of the month (so Jan 31
 * -> Feb 28 -> Mar 31 never drifts).
 */
export function fillRuleForDate(rule: RepeatRule, due: ISODate): RepeatRule {
  const r = normaliseRule(rule);
  if (r.unit === 'week' && r.weekdays.length === 0) r.weekdays = [weekdayOf(due)];
  if (r.unit === 'month' && r.day === null) r.day = parseISODate(due)?.d ?? null;
  return r;
}

/**
 * A rule that is ready to store plus the due date it should start on, given the earliest
 * acceptable start (`from`, normally today or an explicit "starting ..." date).
 */
export function startRule(rule: RepeatRule, from: ISODate): { rule: RepeatRule; dueDate: ISODate } {
  const r = normaliseRule(rule);
  const due = firstDueDate(r, from);
  return { rule: fillRuleForDate(r, due), dueDate: due };
}

/** Two rules are the same series definition. */
export function sameRule(a: RepeatRule | null, b: RepeatRule | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.unit === b.unit &&
    a.interval === b.interval &&
    a.day === b.day &&
    a.weekdays.length === b.weekdays.length &&
    a.weekdays.every((d, i) => d === b.weekdays[i])
  );
}

const ORDER = [1, 2, 3, 4, 5, 6, 0]; // Monday first

function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

/** "Every day", "Every 2 weeks on Mon, Thu", "Every month on the 15th", "Every year". */
export function describeRule(rule: RepeatRule): string {
  const n = rule.interval;
  const unit = (u: string) => (n === 1 ? u : `${n} ${u}s`);
  switch (rule.unit) {
    case 'day':
      return `Every ${unit('day')}`;
    case 'week': {
      const days = [...new Set(rule.weekdays)].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
      if (n === 1 && days.join() === '1,2,3,4,5') return 'Every weekday';
      if (n === 1 && days.join() === '6,0') return 'Every weekend';
      const base = `Every ${unit('week')}`;
      return days.length ? `${base} on ${days.map((d) => SHORT_DAYS[d]).join(', ')}` : base;
    }
    case 'month':
      return `Every ${unit('month')}${rule.day ? ` on the ${ordinal(rule.day)}` : ''}`;
    case 'year':
      return `Every ${unit('year')}`;
  }
}

/** "Fri 21 Nov" (adds the year when it is not the current one). */
export function formatNextDate(iso: ISODate, today: ISODate): string {
  const p = parseISODate(iso);
  if (!p) return iso;
  const base = `${SHORT_DAYS[weekdayOf(iso)]} ${p.d} ${SHORT_MONTHS[p.m - 1]}`;
  return String(p.y) === today.slice(0, 4) ? base : `${base} ${p.y}`;
}

/** "today", "yesterday", "3 days ago", "2 weeks ago", "5 months ago" for a UTC ISO timestamp. */
export function formatLastDone(completedAt: string, today: ISODate): string {
  const t = new Date(completedAt);
  if (Number.isNaN(t.getTime())) return '';
  const days = diffDays(todayISO(t), today);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 730) return `${Math.floor(days / 30)} months ago`;
  return formatShortDate(todayISO(t), today);
}
