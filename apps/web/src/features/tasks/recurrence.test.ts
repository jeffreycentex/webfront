import { describe, expect, it } from 'vitest';
import { addDays, diffDays, todayISO } from './dates';
import {
  describeRule,
  fillRuleForDate,
  firstDueDate,
  formatLastDone,
  formatNextDate,
  nextDueDate,
  normaliseRule,
  sameRule,
  startRule,
  type RepeatRule,
} from './recurrence';

const rule = (
  unit: RepeatRule['unit'],
  interval = 1,
  weekdays: number[] = [],
  day: number | null = null,
): RepeatRule => ({
  unit,
  interval,
  weekdays,
  day,
});

// 2026-11-14 is a Saturday.
const TODAY = '2026-11-14';
const next = (due: string | null, r: RepeatRule, today = TODAY) => nextDueDate(due, r, today);

describe('daily rules', () => {
  it('advances from the due date, not from today, when the task is not overdue', () => {
    expect(next('2026-11-14', rule('day'))).toBe('2026-11-15');
    expect(next('2026-11-20', rule('day'))).toBe('2026-11-21');
    expect(next('2026-11-20', rule('day', 3))).toBe('2026-11-23');
  });
  it('skips forward past today when overdue by several cycles', () => {
    expect(next('2026-11-10', rule('day'))).toBe('2026-11-15');
    expect(next('2026-10-01', rule('day', 7))).toBe('2026-11-19'); // 10-01 + 7k, first > 11-14
    expect(next('2020-01-01', rule('day', 2), '2026-11-14')).toBe('2026-11-15'); // stays on the 2-day grid
  });
  it('stays on the interval grid of the due date', () => {
    const d = next('2026-11-01', rule('day', 5)); // 11-06, 11-11, 11-16
    expect(d).toBe('2026-11-16');
    expect(diffDays('2026-11-01', d) % 5).toBe(0);
  });
  it('crosses month, year and leap boundaries', () => {
    expect(next('2026-12-31', rule('day'), '2026-12-31')).toBe('2027-01-01');
    expect(next('2028-02-28', rule('day'), '2028-02-28')).toBe('2028-02-29');
    expect(next('2027-02-28', rule('day'), '2027-02-28')).toBe('2027-03-01');
  });
  it('treats a missing due date as today', () => {
    expect(next(null, rule('day', 2))).toBe('2026-11-16');
  });
});

describe('weekly rules', () => {
  it('uses the due date weekday when none are chosen', () => {
    expect(next('2026-11-13', rule('week'))).toBe('2026-11-20'); // Fri, today is Sat -> next Fri
    expect(next('2026-11-20', rule('week'))).toBe('2026-11-27');
  });
  it('picks the next chosen weekday', () => {
    const monThu = rule('week', 1, [1, 4]);
    expect(next('2026-11-16', monThu)).toBe('2026-11-19'); // Mon -> Thu
    expect(next('2026-11-19', monThu)).toBe('2026-11-23'); // Thu -> next Mon
    expect(next('2026-11-23', monThu)).toBe('2026-11-26');
  });
  it('catches up when overdue by many weeks without landing in the past', () => {
    const monThu = rule('week', 1, [1, 4]);
    expect(next('2026-08-03', monThu)).toBe('2026-11-16'); // today is Sat 11-14
    expect(next('2026-08-03', monThu, '2026-11-16')).toBe('2026-11-19');
  });
  it('honours the interval, counting weeks from the due date week', () => {
    const everyTwo = rule('week', 2, [1, 4]); // Mon + Thu every 2 weeks
    expect(next('2026-11-16', everyTwo)).toBe('2026-11-19'); // same week, Thu
    expect(next('2026-11-19', everyTwo)).toBe('2026-11-30'); // two weeks after the 16th
    expect(next('2026-11-30', everyTwo)).toBe('2026-12-03');
    // overdue: due 2026-09-07 (Mon) every 2 weeks -> grid weeks of 09-07, 09-21, ... 11-09, 11-23
    expect(next('2026-09-07', everyTwo)).toBe('2026-11-16'); // week 10 is on the grid
  });
  it('weeks run Monday to Sunday', () => {
    expect(next('2026-11-22', rule('week', 1, [0, 1]))).toBe('2026-11-23'); // Sun -> Mon
    expect(next('2026-11-22', rule('week', 2, [0]))).toBe('2026-12-06'); // 2 weeks later Sunday
  });
  it('weekdays rule skips the weekend', () => {
    const wd = rule('week', 1, [1, 2, 3, 4, 5]);
    expect(next('2026-11-13', wd)).toBe('2026-11-16'); // Fri (overdue, today Sat) -> Mon
    expect(next('2026-11-16', wd, '2026-11-16')).toBe('2026-11-17');
  });
  it('a due date off the chosen weekdays still lands on a chosen one', () => {
    expect(next('2026-11-18', rule('week', 1, [5]))).toBe('2026-11-20'); // Wed -> Fri
  });
});

describe('monthly rules', () => {
  it('keeps the day of the month', () => {
    expect(next('2026-11-20', rule('month'))).toBe('2026-12-20');
    expect(next('2026-12-20', rule('month', 2))).toBe('2027-02-20');
  });
  it('clamps to the last day of short months without drifting', () => {
    const r = rule('month', 1, [], 31);
    const feb = next('2027-01-31', r, '2027-01-31');
    expect(feb).toBe('2027-02-28');
    expect(next(feb, r, feb)).toBe('2027-03-31');
    expect(next('2028-01-31', r, '2028-01-31')).toBe('2028-02-29'); // leap year
    expect(next('2026-03-31', r, '2026-03-31')).toBe('2026-04-30');
  });
  it('without a stored day uses the due date day', () => {
    expect(next('2027-01-31', rule('month'), '2027-01-31')).toBe('2027-02-28');
  });
  it('crosses the year end', () => {
    expect(next('2026-12-15', rule('month'), '2026-12-15')).toBe('2027-01-15');
    expect(next('2026-11-30', rule('month', 3), '2026-11-30')).toBe('2027-02-28');
  });
  it('catches up when overdue by many months', () => {
    expect(next('2025-01-15', rule('month', 1, [], 15))).toBe('2026-11-15');
    expect(next('2025-01-15', rule('month', 1, [], 15), '2026-11-15')).toBe('2026-12-15');
    expect(next('2025-01-15', rule('month', 3, [], 15))).toBe('2027-01-15'); // 01,04,07,10 of 2025.. 2026-10, 2027-01
  });
  it('a due date before the remembered day in the same month uses that day', () => {
    expect(next('2026-11-01', rule('month', 1, [], 15), '2026-11-01')).toBe('2026-11-15');
  });
});

describe('yearly rules', () => {
  it('adds years', () => {
    expect(next('2026-11-20', rule('year'))).toBe('2027-11-20');
    expect(next('2026-11-20', rule('year', 2))).toBe('2028-11-20');
  });
  it('Feb 29 falls back to Feb 28 and returns to the 29th in the next leap year', () => {
    expect(next('2028-02-29', rule('year'), '2028-02-29')).toBe('2029-02-28');
    expect(next('2028-02-29', rule('year', 4), '2028-02-29')).toBe('2032-02-29');
    expect(next('2028-02-29', rule('year', 1, [], 29), '2028-02-29')).toBe('2029-02-28');
  });
  it('catches up when overdue by years', () => {
    expect(next('2020-03-05', rule('year'))).toBe('2027-03-05');
  });
});

describe('determinism for two devices', () => {
  const rules = [
    rule('day'),
    rule('day', 3),
    rule('week', 1, [1, 4]),
    rule('week', 2, [2]),
    rule('month', 1, [], 31),
    rule('year'),
  ];
  const dues = ['2026-11-14', '2026-11-10', '2026-10-31', '2026-01-01', '2026-12-25'];

  it('is a pure function of due date, rule and local date', () => {
    for (const r of rules)
      for (const due of dues) {
        const a = nextDueDate(due, r, TODAY);
        const b = nextDueDate(due, structuredClone(r), TODAY);
        expect(b).toBe(a);
      }
  });
  it('never returns a date on or before max(due, today) and is the first such occurrence', () => {
    for (const r of rules)
      for (const due of dues) {
        const n = nextDueDate(due, r, TODAY);
        expect(n > due).toBe(true);
        expect(n > TODAY).toBe(true);
      }
  });
  it('two devices completing the same occurrence on the same day converge', () => {
    // The wall-clock time of completion is not an input at all.
    const r = rule('week', 1, [1, 4]);
    const morning = nextDueDate('2026-11-12', r, todayISO(new Date(2026, 10, 14, 0, 5)));
    const night = nextDueDate('2026-11-12', r, todayISO(new Date(2026, 10, 14, 23, 55)));
    expect(night).toBe(morning);
  });
  it('is stable once applied: completing again moves exactly one occurrence', () => {
    const r = rule('day');
    const once = nextDueDate('2026-11-14', r, TODAY);
    expect(nextDueDate(once, r, TODAY)).toBe(addDays(once, 1));
  });
});

describe('time-zone safety', () => {
  it('gives the same result in every process time zone', () => {
    const original = process.env.TZ;
    const results = new Set<string>();
    try {
      for (const tz of [
        'UTC',
        'America/Los_Angeles',
        'Pacific/Auckland',
        'Pacific/Kiritimati',
        'Europe/London',
      ]) {
        process.env.TZ = tz;
        const out = [
          // spans the DST changes of 2026 in several hemispheres
          nextDueDate('2026-03-07', rule('day'), '2026-03-07'),
          nextDueDate('2026-03-28', rule('week', 1, [0, 6]), '2026-03-28'),
          nextDueDate('2026-10-24', rule('week', 2, [6]), '2026-10-24'),
          nextDueDate('2026-01-31', rule('month', 1, [], 31), '2026-01-31'),
          nextDueDate('2026-04-01', rule('day', 1), '2026-11-01'),
          nextDueDate('2025-10-25', rule('month', 6, [], 25), '2026-11-14'),
        ].join('|');
        results.add(out);
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
    expect([...results]).toEqual([
      '2026-03-08|2026-03-29|2026-11-07|2026-02-28|2026-11-02|2027-04-25',
    ]);
  });
});

describe('first due date and rule helpers', () => {
  it('first due date is today unless weekdays or a day of the month are fixed', () => {
    expect(firstDueDate(rule('day', 2), TODAY)).toBe(TODAY);
    expect(firstDueDate(rule('week', 1, [6]), TODAY)).toBe(TODAY); // today is Saturday
    expect(firstDueDate(rule('week', 1, [1, 4]), TODAY)).toBe('2026-11-16');
    expect(firstDueDate(rule('month', 1, [], 20), TODAY)).toBe('2026-11-20');
    expect(firstDueDate(rule('month', 1, [], 1), TODAY)).toBe('2026-12-01');
    expect(firstDueDate(rule('month', 1, [], 31), '2026-02-10')).toBe('2026-02-28');
  });
  it('startRule makes the rule explicit', () => {
    expect(startRule(rule('week'), TODAY)).toEqual({ rule: rule('week', 1, [6]), dueDate: TODAY });
    expect(startRule(rule('month'), '2026-01-31')).toEqual({
      rule: rule('month', 1, [], 31),
      dueDate: '2026-01-31',
    });
    expect(startRule(rule('week', 1, [4, 1]), TODAY)).toEqual({
      rule: rule('week', 1, [1, 4]),
      dueDate: '2026-11-16',
    });
  });
  it('normalises weekdays, interval and irrelevant fields', () => {
    expect(normaliseRule({ unit: 'day', interval: 0, weekdays: [3, 3], day: 5 })).toEqual(
      rule('day'),
    );
    expect(normaliseRule({ unit: 'week', interval: 2.4, weekdays: [4, 1, 4], day: 5 })).toEqual(
      rule('week', 2, [1, 4]),
    );
    expect(fillRuleForDate(rule('week'), '2026-11-16').weekdays).toEqual([1]);
  });
  it('compares rules', () => {
    expect(sameRule(rule('week', 1, [1]), rule('week', 1, [1]))).toBe(true);
    expect(sameRule(rule('week', 1, [1]), rule('week', 2, [1]))).toBe(false);
    expect(sameRule(null, null)).toBe(true);
    expect(sameRule(null, rule('day'))).toBe(false);
  });
});

describe('plain-language text', () => {
  it('describes rules', () => {
    expect(describeRule(rule('day'))).toBe('Every day');
    expect(describeRule(rule('day', 3))).toBe('Every 3 days');
    expect(describeRule(rule('week'))).toBe('Every week');
    expect(describeRule(rule('week', 2, [4, 1]))).toBe('Every 2 weeks on Mon, Thu');
    expect(describeRule(rule('week', 1, [0, 6]))).toBe('Every weekend');
    expect(describeRule(rule('week', 1, [5, 4, 3, 2, 1]))).toBe('Every weekday');
    expect(describeRule(rule('week', 1, [0, 1]))).toBe('Every week on Mon, Sun');
    expect(describeRule(rule('month', 1, [], 15))).toBe('Every month on the 15th');
    expect(describeRule(rule('month', 2, [], 1))).toBe('Every 2 months on the 1st');
    expect(describeRule(rule('month', 1, [], 22))).toBe('Every month on the 22nd');
    expect(describeRule(rule('month', 1, [], 13))).toBe('Every month on the 13th');
    expect(describeRule(rule('year'))).toBe('Every year');
  });
  it('formats the next date', () => {
    expect(formatNextDate('2026-11-21', TODAY)).toBe('Sat 21 Nov');
    expect(formatNextDate('2027-01-01', TODAY)).toBe('Fri 1 Jan 2027');
  });
  it('formats the last completion relative to today', () => {
    const at = (d: number) => new Date(2026, 10, d, 12, 0).toISOString();
    expect(formatLastDone(at(14), TODAY)).toBe('today');
    expect(formatLastDone(at(13), TODAY)).toBe('yesterday');
    expect(formatLastDone(at(11), TODAY)).toBe('3 days ago');
    expect(formatLastDone(new Date(2026, 9, 20, 12).toISOString(), TODAY)).toBe('3 weeks ago');
    expect(formatLastDone(new Date(2026, 5, 14, 12).toISOString(), TODAY)).toBe('5 months ago');
    expect(formatLastDone('nonsense', TODAY)).toBe('');
  });
});
