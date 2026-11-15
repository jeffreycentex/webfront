/**
 * Local calendar-date helpers and a lightweight natural-language due-date parser.
 *
 * All dates are all-day LOCAL calendar dates as `YYYY-MM-DD` strings. Arithmetic is done on
 * integer year/month/day through `Date.UTC`, so DST changes and the machine's time zone can
 * never shift a result; the only time-zone-dependent step is `todayISO`, which reads the
 * local year/month/day of a `Date`.
 */

export type ISODate = string;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function toISODate(y: number, m: number, d: number): ISODate {
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

export function parseISODate(iso: ISODate): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  return isValidYMD(y, m, d) ? { y, m, d } : null;
}

export function isValidYMD(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= daysInMonth(y, m);
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** The local calendar date of `now`. */
export function todayISO(now: Date = new Date()): ISODate {
  return toISODate(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function addDays(iso: ISODate, days: number): ISODate {
  const p = parseISODate(iso);
  if (!p) return iso;
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  return toISODate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Adds calendar months, clamping the day ("jan 31" + 1 month = "feb 28/29"). */
export function addMonths(iso: ISODate, months: number): ISODate {
  const p = parseISODate(iso);
  if (!p) return iso;
  const total = p.y * 12 + (p.m - 1) + months;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return toISODate(y, m, Math.min(p.d, daysInMonth(y, m)));
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(iso: ISODate): number {
  const p = parseISODate(iso);
  if (!p) return 0;
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
}

/** Whole days from `a` to `b` (b - a). */
export function diffDays(a: ISODate, b: ISODate): number {
  const pa = parseISODate(a);
  const pb = parseISODate(b);
  if (!pa || !pb) return 0;
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86_400_000);
}

const WEEKDAYS: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

/** Weekday number (0 = Sunday) for a typed word ("fri", "friday", "fridays"), or null. */
export function weekdayFromWord(word: string): number | null {
  const w = word.toLowerCase();
  if (w in WEEKDAYS) return WEEKDAYS[w]!;
  if (w.endsWith('s') && w.slice(0, -1) in WEEKDAYS) return WEEKDAYS[w.slice(0, -1)]!;
  return null;
}

/** Number for a digit string or a small number word ("3", "three"), or null. */
export function numberFromWord(word: string): number | null {
  if (/^\d{1,3}$/.test(word)) return Number(word);
  return NUMBER_WORDS[word.toLowerCase()] ?? null;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const UNITS: Record<string, 'd' | 'w' | 'm'> = {
  d: 'd',
  day: 'd',
  days: 'd',
  w: 'w',
  wk: 'w',
  wks: 'w',
  week: 'w',
  weeks: 'w',
  m: 'm',
  mo: 'm',
  mos: 'm',
  month: 'm',
  months: 'm',
};

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

/** Monday of the week containing `iso` (weeks run Monday to Sunday). */
export function weekStart(iso: ISODate): ISODate {
  return addDays(iso, -((weekdayOf(iso) + 6) % 7));
}

/** First date strictly after `today` that falls on `weekday`. */
function nextWeekday(today: ISODate, weekday: number): ISODate {
  const delta = ((weekday - weekdayOf(today) + 6) % 7) + 1;
  return addDays(today, delta);
}

/** Month/day to a date this year, or next year when it has already passed. */
function monthDay(today: ISODate, m: number, d: number, year: number | null): ISODate | null {
  const ty = Number(today.slice(0, 4));
  if (year !== null) return isValidYMD(year, m, d) ? toISODate(year, m, d) : null;
  // This year if still ahead (or today), else the next year where the date exists (Feb 29).
  for (let y = ty; y <= ty + 8; y++) {
    if (!isValidYMD(y, m, d)) continue;
    const iso = toISODate(y, m, d);
    if (iso >= today) return iso;
  }
  return null;
}

function expandYear(raw: string): number {
  const n = Number(raw);
  return raw.length <= 2 ? 2000 + n : n;
}

/**
 * Resolve one complete phrase (already lower-cased, single-spaced) to a date, or null.
 * Supported: today, tonight, tomorrow/tmrw, yesterday, <weekday> (the next one after today),
 * next <weekday> (that weekday in next Monday-to-Sunday week), next week (next Monday),
 * next month, in N days/weeks/months ("in 3 days", "in a week", "in 2w"), "nov 20",
 * "november 20th 2027", "20 nov", "11/20", "11/20/2026", "2026-11-20".
 */
export function resolvePhrase(phrase: string, today: ISODate): ISODate | null {
  const p = phrase.trim().toLowerCase().replace(/,/g, '').replace(/\s+/g, ' ');
  if (!p) return null;

  if (p === 'today' || p === 'tod' || p === 'tonight') return today;
  if (p === 'tomorrow' || p === 'tmrw' || p === 'tmr' || p === 'tom') return addDays(today, 1);
  if (p === 'yesterday') return addDays(today, -1);
  if (p === 'next week') return addDays(weekStart(today), 7);
  if (p === 'next month') return addMonths(today, 1);

  let m = /^(?:(?:on|this) )?([a-z]+)$/.exec(p);
  if (m && m[1] !== undefined && m[1] in WEEKDAYS) return nextWeekday(today, WEEKDAYS[m[1]]!);

  m = /^next ([a-z]+)$/.exec(p);
  if (m && m[1] !== undefined && m[1] in WEEKDAYS) {
    const first = nextWeekday(today, WEEKDAYS[m[1]]!);
    return weekStart(first) === weekStart(today) ? addDays(first, 7) : first;
  }

  m = /^in (\d{1,3}|[a-z]+) ?([a-z]+)$/.exec(p);
  if (m) {
    const n = /^\d+$/.test(m[1]!) ? Number(m[1]) : NUMBER_WORDS[m[1]!];
    const unit = UNITS[m[2]!];
    if (n !== undefined && unit) {
      if (unit === 'd') return addDays(today, n);
      if (unit === 'w') return addDays(today, n * 7);
      return addMonths(today, n);
    }
  }

  m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(p);
  if (m) return isValidYMD(+m[1]!, +m[2]!, +m[3]!) ? toISODate(+m[1]!, +m[2]!, +m[3]!) : null;

  // 11/20, 11/20/2026 (month first; day first when the first number cannot be a month).
  m = /^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2}|\d{4}))?$/.exec(p);
  if (m) {
    let a = +m[1]!;
    let b = +m[2]!;
    if (a > 12 && b <= 12) [a, b] = [b, a];
    return monthDay(today, a, b, m[3] ? expandYear(m[3]) : null);
  }

  // nov 20, november 20th, nov 20 2027
  m = /^([a-z]+) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/.exec(p);
  if (m && m[1] !== undefined && m[1] in MONTHS) {
    return monthDay(today, MONTHS[m[1]]!, +m[2]!, m[3] ? +m[3] : null);
  }

  // 20 nov, 20th of november 2027
  m = /^(\d{1,2})(?:st|nd|rd|th)? (?:of )?([a-z]+)(?: (\d{4}))?$/.exec(p);
  if (m && m[2] !== undefined && m[2] in MONTHS) {
    return monthDay(today, MONTHS[m[2]]!, +m[1]!, m[3] ? +m[3] : null);
  }

  return null;
}

export interface ParsedTask {
  /** The title with the date phrase (and a dangling "on"/"by"/"due") removed. */
  title: string;
  /** Resolved local date, or null when no date phrase was found. */
  dueDate: ISODate | null;
  /** The phrase that was recognised, as typed ('' when none). */
  phrase: string;
}

const CONNECTORS = new Set(['on', 'by', 'due', 'at', 'for', 'until', 'before', 'this', '@']);
const MAX_PHRASE_WORDS = 4;

/**
 * Find a date phrase at the END (preferred) or START of a quick-add line.
 * "pay rent tomorrow" -> { title: 'pay rent', dueDate: tomorrow }. A line that is only a date
 * phrase ("tomorrow") is left alone: the title would be empty.
 */
export function parseTaskInput(input: string, today: ISODate): ParsedTask {
  const clean = input.replace(/\s+/g, ' ').trim();
  const none: ParsedTask = { title: clean, dueDate: null, phrase: '' };
  const words = clean.split(' ').filter(Boolean);
  if (words.length < 2) return none;

  for (const atEnd of [true, false]) {
    for (let k = Math.min(MAX_PHRASE_WORDS, words.length - 1); k >= 1; k--) {
      const phraseWords = atEnd ? words.slice(-k) : words.slice(0, k);
      const rest = atEnd ? words.slice(0, -k) : words.slice(k);
      const date = resolvePhrase(phraseWords.join(' '), today);
      if (!date) continue;
      // Drop a dangling connector next to the phrase ("pay rent on fri", "due fri pay rent").
      while (rest.length > 1) {
        const edge = atEnd ? rest[rest.length - 1]! : rest[0]!;
        if (!CONNECTORS.has(edge.toLowerCase())) break;
        if (atEnd) rest.pop();
        else rest.shift();
      }
      const title = rest.join(' ').trim();
      if (!title || (rest.length === 1 && CONNECTORS.has(title.toLowerCase()))) continue;
      return { title, dueDate: date, phrase: phraseWords.join(' ') };
    }
  }
  return none;
}

export const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
export const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Nov 20" (adds the year when it is not the current one). */
export function formatShortDate(iso: ISODate, today: ISODate): string {
  const p = parseISODate(iso);
  if (!p) return iso;
  const base = `${SHORT_MONTHS[p.m - 1]} ${p.d}`;
  return String(p.y) === today.slice(0, 4) ? base : `${base} ${p.y}`;
}

/** Relative label for chips: "Yesterday", "Today", "Tomorrow", "Fri", "Nov 20", "3d ago". */
export function formatDueLabel(iso: ISODate, today: ISODate): string {
  const diff = diffDays(today, iso);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff < -1 && diff >= -14) return `${-diff}d ago`;
  if (diff > 1 && diff < 7) return SHORT_DAYS[weekdayOf(iso)]!;
  return formatShortDate(iso, today);
}
