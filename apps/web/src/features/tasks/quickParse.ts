import {
  numberFromWord,
  parseTaskInput,
  resolvePhrase,
  weekdayFromWord,
  type ISODate,
} from './dates';
import { startRule, type RepeatRule } from './recurrence';

/**
 * Quick-add parsing: a repeat phrase and/or a date phrase at the end of the text.
 *
 * Repeat phrases (always at the END, optionally followed by "starting <date>"):
 *   daily, weekly, monthly, yearly, annually, weekdays, weekends,
 *   every day|week|month|year|weekday|weekend, every other day|week|..., every N days|weeks|...,
 *   every <weekday> [and <weekday>...] ("every mon and thu"), every [N] weeks on <weekdays>,
 *   every month on the 15th, monthly on the 15th, every year on nov 20.
 * The title is whatever is left; the phrase is never allowed to swallow the whole input, so the
 * title is never empty and a title that merely contains "every" ("every little thing") is left
 * alone.
 */

export interface ParsedQuickAdd {
  title: string;
  /** First due date: the explicit date, or the rule's first occurrence; null when neither. */
  dueDate: ISODate | null;
  /** The date phrase as typed ('' when none). */
  datePhrase: string;
  /** Ready-to-store repeat rule (weekdays / day filled in), or null. */
  rule: RepeatRule | null;
  /** The repeat phrase as typed ('' when none). */
  repeatPhrase: string;
}

type Unit = RepeatRule['unit'];
interface Tail {
  unit: Unit;
  interval: number;
  weekdays: number[];
  day: number | null;
}

const UNIT_WORDS: Record<string, Unit> = {
  day: 'day',
  days: 'day',
  week: 'week',
  weeks: 'week',
  month: 'month',
  months: 'month',
  year: 'year',
  years: 'year',
  yr: 'year',
  yrs: 'year',
};

const MAX_REPEAT_WORDS = 9;
const CONNECTORS = new Set([
  'on',
  'by',
  'due',
  'at',
  'for',
  'starting',
  'starts',
  'beginning',
  'begins',
  'from',
]);

/** "mon and thu", "mon, thu", "mon & thu" as weekday numbers, or null when it is not such a list. */
function weekdayList(words: string[]): number[] | null {
  if (!words.length) return null;
  const out: number[] = [];
  let pendingAnd = false;
  for (const w of words) {
    if (w === 'and') {
      if (!out.length || pendingAnd) return null;
      pendingAnd = true;
      continue;
    }
    const d = weekdayFromWord(w);
    if (d === null) return null;
    out.push(d);
    pendingAnd = false;
  }
  return pendingAnd ? null : out;
}

/** "on the 15th", "on 15th", "15th", "the 1st" -> day number. */
function monthDayWords(words: string[]): number | null {
  let w = words;
  if (w[0] === 'on') w = w.slice(1);
  if (w[0] === 'the') w = w.slice(1);
  if (w.length !== 1) return null;
  const m = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(w[0]!);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 31 ? n : null;
}

/** Interpret ALL of `w` (lower-case words) as one repeat phrase, or null. */
function parseTail(w: string[]): Tail | null {
  const tail = (unit: Unit, interval: number, rest: string[]): Tail | null => {
    if (rest.length === 0) return { unit, interval, weekdays: [], day: null };
    if (unit === 'week' && rest[0] === 'on') {
      const days = weekdayList(rest.slice(1));
      return days ? { unit, interval, weekdays: days, day: null } : null;
    }
    if (unit === 'month' && rest[0] === 'on') {
      const day = monthDayWords(rest);
      return day ? { unit, interval, weekdays: [], day } : null;
    }
    return null;
  };

  const first = w[0];
  if (first === undefined) return null;
  if (first === 'daily') return w.length === 1 ? tail('day', 1, []) : null;
  if (first === 'weekly') return tail('week', 1, w.slice(1));
  if (first === 'monthly') return tail('month', 1, w.slice(1));
  if (first === 'yearly' || first === 'annually')
    return w.length === 1 ? tail('year', 1, []) : null;
  if (first === 'weekdays' && w.length === 1)
    return { unit: 'week', interval: 1, weekdays: [1, 2, 3, 4, 5], day: null };
  if (first === 'weekends' && w.length === 1)
    return { unit: 'week', interval: 1, weekdays: [6, 0], day: null };

  if (first !== 'every') return null;
  let rest = w.slice(1);
  if (!rest.length) return null;

  if ((rest[0] === 'weekday' || rest[0] === 'weekdays') && rest.length === 1)
    return { unit: 'week', interval: 1, weekdays: [1, 2, 3, 4, 5], day: null };
  if ((rest[0] === 'weekend' || rest[0] === 'weekends') && rest.length === 1)
    return { unit: 'week', interval: 1, weekdays: [6, 0], day: null };

  let interval = 1;
  let explicit = false;
  if (rest[0] === 'other') {
    interval = 2;
    explicit = true;
    rest = rest.slice(1);
  } else {
    const n = rest[0]! === 'a' || rest[0] === 'an' ? null : numberFromWord(rest[0]!);
    if (n !== null && n >= 1 && rest[1] !== undefined && rest[1] in UNIT_WORDS) {
      interval = n;
      explicit = true;
      rest = rest.slice(1);
    }
  }
  const unit = rest[0] !== undefined ? UNIT_WORDS[rest[0]] : undefined;
  if (unit) {
    // "every 3 day" is tolerated; "every days" is not a phrase.
    if (!explicit && rest[0]!.endsWith('s')) return null;
    return tail(unit, interval, rest.slice(1));
  }
  // every <weekday list>, every other <weekday>
  const days = weekdayList(rest);
  if (days) return { unit: 'week', interval, weekdays: days, day: null };
  return null;
}

interface Found {
  tail: Tail;
  /** Title words before the phrase (dangling connectors removed). */
  rest: string[];
  /** The phrase as typed. */
  phrase: string;
  /** Index in the searched words where the phrase starts, and its word count. */
  start: number;
  length: number;
}

/** The repeat phrase that ends `words`, with the words before it; null when none. */
function findRepeatAtEnd(words: string[]): Found | null {
  const lower = words.map((w) =>
    w
      .toLowerCase()
      .replace(/[,;]+$/g, '')
      .replace(/^&$/, 'and'),
  );
  for (let i = Math.max(1, words.length - MAX_REPEAT_WORDS); i < words.length; i++) {
    const tail = parseTail(lower.slice(i));
    if (!tail) continue;
    const rest = words.slice(0, i);
    // Drop a dangling connector ("pay rent on every friday").
    while (rest.length > 1 && CONNECTORS.has(rest[rest.length - 1]!.toLowerCase())) rest.pop();
    if (!rest.length || (rest.length === 1 && CONNECTORS.has(rest[0]!.toLowerCase()))) continue;
    return { tail, rest, phrase: words.slice(i).join(' '), start: i, length: words.length - i };
  }
  return null;
}

const toRule = (t: Tail): RepeatRule => ({
  unit: t.unit,
  interval: t.interval,
  weekdays: t.weekdays,
  day: t.day,
});

export interface QuickAddOptions {
  /** The user removed the repeat chip: keep the repeat words in the title. */
  ignoreRepeat?: boolean;
  /** The user removed the date chip: keep the date words in the title. */
  ignoreDate?: boolean;
}

/**
 * Parse quick-add text into title, first due date and repeat rule. Examples:
 *   "pay rent every month on the 1st"        -> monthly on the 1st, due the next 1st
 *   "water plants every 3 days starting tomorrow" -> every 3 days, due tomorrow
 *   "gym every mon and thu"                  -> weekly Mon+Thu, due the next of those
 *   "call mum fri"                           -> a plain due date, no rule
 * With `ignoreRepeat` / `ignoreDate` (a removed chip) the matching words stay in the title.
 */
export function parseQuickAdd(
  input: string,
  today: ISODate,
  opts: QuickAddOptions = {},
): ParsedQuickAdd {
  const clean = input.replace(/\s+/g, ' ').trim();
  const words = clean.split(' ').filter(Boolean);
  const none: ParsedQuickAdd = {
    title: clean,
    dueDate: null,
    datePhrase: '',
    rule: null,
    repeatPhrase: '',
  };
  const plain = (): ParsedQuickAdd => {
    if (opts.ignoreDate) return none;
    const p = parseTaskInput(clean, today);
    return {
      title: p.title,
      dueDate: p.dueDate,
      datePhrase: p.phrase,
      rule: null,
      repeatPhrase: '',
    };
  };
  if (words.length < 2) return none;

  const build = (
    found: Found,
    date: ISODate | null,
    datePhrase: string,
    after: string[],
    rest: string[] = found.rest,
  ): ParsedQuickAdd => {
    const useDate = !opts.ignoreDate && date !== null;
    if (opts.ignoreRepeat) {
      // Keep the repeat words in the title; a combined date still applies.
      const title = [...rest, found.phrase, ...(useDate ? [] : after)].join(' ').trim();
      return {
        title,
        dueDate: useDate ? date : null,
        datePhrase: useDate ? datePhrase : '',
        rule: null,
        repeatPhrase: '',
      };
    }
    const started = startRule(toRule(found.tail), useDate ? date : today);
    const title = [...rest, ...(useDate ? [] : after)].join(' ').trim();
    return {
      title,
      dueDate: started.dueDate,
      datePhrase: useDate ? datePhrase : '',
      rule: started.rule,
      repeatPhrase: found.phrase,
    };
  };

  // 1. "<title> <repeat> [starting] <date>": a date after the repeat phrase.
  for (let k = Math.min(4, words.length - 2); k >= 1; k--) {
    const datePhrase = words.slice(-k).join(' ');
    const date = resolvePhrase(datePhrase, today);
    if (!date) continue;
    const before = words.slice(0, -k);
    while (before.length > 1 && CONNECTORS.has(before[before.length - 1]!.toLowerCase()))
      before.pop();
    const found = findRepeatAtEnd(before);
    if (found) return build(found, date, datePhrase, words.slice(found.start + found.length));
  }

  // 2. "<title> <repeat>", then an optional date elsewhere in the title ("tomorrow water plants daily").
  const found = findRepeatAtEnd(words);
  if (found) {
    if (!opts.ignoreDate) {
      const dated = parseTaskInput(found.rest.join(' '), today);
      if (dated.dueDate && dated.title)
        return build(found, dated.dueDate, dated.phrase, [], dated.title.split(' '));
    }
    return build(found, null, '', []);
  }

  // 3. Just a date (or nothing).
  return plain();
}
