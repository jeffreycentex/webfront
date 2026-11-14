import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  buildMonthGrid,
  diffDays,
  groupAgenda,
  itemsByDay,
  moveCursor,
  spanOf,
  startOfWeek,
  weekdayOf,
  ymdOf,
  zonedParts,
  type EventLike,
} from './dates';

const timed = (id: string, start: string, end: string | null, title = id): EventLike => ({
  id,
  title,
  allDay: false,
  start,
  end,
});
const allDay = (id: string, start: string, end: string | null, title = id): EventLike => ({
  id,
  title,
  allDay: true,
  start,
  end,
});

const LA = 'America/Los_Angeles';
const AKL = 'Pacific/Auckland';
const NY = 'America/New_York';

describe('day arithmetic', () => {
  it('is immune to DST', () => {
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02'); // NY fall back
    expect(addDays('2027-03-14', 1)).toBe('2027-03-15'); // NY spring forward
    expect(diffDays('2026-10-31', '2026-11-02')).toBe(2);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('weeks and months', () => {
    expect(weekdayOf('2026-11-14')).toBe(6); // Saturday
    expect(startOfWeek('2026-11-14', 'monday')).toBe('2026-11-09');
    expect(startOfWeek('2026-11-14', 'sunday')).toBe('2026-11-08');
    expect(startOfWeek('2026-11-15', 'monday')).toBe('2026-11-09'); // Sunday belongs to the prior week
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
  });
  it('zonedParts reads wall clock in a zone', () => {
    const ms = Date.parse('2026-11-14T23:30:00Z');
    expect(zonedParts(ms, LA)).toEqual({ ymd: '2026-11-14', minutes: 15 * 60 + 30 });
    expect(zonedParts(ms, AKL)).toEqual({ ymd: '2026-11-15', minutes: 12 * 60 + 30 });
    expect(ymdOf(Date.parse('2026-11-01T05:30:00Z'), NY)).toBe('2026-11-01');
  });
});

describe('placing events on days across time zones', () => {
  const late = timed('late', '2026-11-14T23:30:00Z', '2026-11-15T00:30:00Z');

  it('puts the same instant on different days in different zones', () => {
    expect(spanOf(late, LA)).toMatchObject({ startDay: '2026-11-14', lastDay: '2026-11-14' });
    expect(spanOf(late, AKL)).toMatchObject({ startDay: '2026-11-15', lastDay: '2026-11-15' });
    expect(spanOf(late, 'UTC')).toMatchObject({ startDay: '2026-11-14', lastDay: '2026-11-15' });
    expect([...itemsByDay([late], '2026-11-10', '2026-11-20', AKL).keys()]).toEqual(['2026-11-15']);
    expect([...itemsByDay([late], '2026-11-10', '2026-11-20', 'UTC').keys()]).toEqual([
      '2026-11-14',
      '2026-11-15',
    ]);
  });

  it('groups an agenda differently per zone', () => {
    const events = [
      timed('a', '2026-11-14T07:00:00Z', '2026-11-14T08:00:00Z'), // LA 23:00 on the 13th
      timed('b', '2026-11-14T09:00:00Z', null), // LA 01:00 on the 14th
    ];
    const la = groupAgenda(events, {
      from: '2026-11-13',
      to: '2026-11-15',
      today: '2026-11-14',
      zone: LA,
    });
    expect(la.map((g) => [g.day, g.items.map((i) => i.event.id)])).toEqual([
      ['2026-11-13', ['a']],
      ['2026-11-14', ['b']],
    ]);
    const utc = groupAgenda(events, {
      from: '2026-11-13',
      to: '2026-11-15',
      today: '2026-11-14',
      zone: 'UTC',
    });
    expect(utc.map((g) => [g.day, g.items.map((i) => i.event.id)])).toEqual([
      ['2026-11-14', ['a', 'b']],
    ]);
  });

  it('keeps all-day events on their date in every zone', () => {
    const holiday = allDay('h', '2026-11-20', '2026-11-21');
    for (const zone of [LA, AKL, 'UTC', 'Asia/Kolkata']) {
      expect([...itemsByDay([holiday], '2026-11-01', '2026-11-30', zone).keys()]).toEqual([
        '2026-11-20',
      ]);
    }
  });

  it('handles a DST fall-back day (25 hours) in New York', () => {
    const e = timed('d', '2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z'); // NY 00:00 Nov 1 to 00:00 Nov 2
    expect(spanOf(e, NY)).toMatchObject({ startDay: '2026-11-01', lastDay: '2026-11-01' });
  });
});

describe('multi-day and midnight placement', () => {
  it('places a multi-day all-day event on each day with an exclusive end', () => {
    const trip = allDay('t', '2026-11-20', '2026-11-24');
    const map = itemsByDay([trip], '2026-11-01', '2026-11-30', LA);
    expect([...map.keys()]).toEqual(['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23']);
    const items = [...map.values()].map((l) => l[0]!);
    expect(items.map((i) => [i.isFirstDay, i.isLastDay, i.dayNumber, i.dayCount])).toEqual([
      [true, false, 1, 4],
      [false, false, 2, 4],
      [false, false, 3, 4],
      [false, true, 4, 4],
    ]);
  });

  it('treats a missing all-day end as one day', () => {
    expect(spanOf(allDay('x', '2026-11-20', null), LA)).toMatchObject({
      startDay: '2026-11-20',
      lastDay: '2026-11-20',
    });
  });

  it('does not spill an event ending exactly at midnight onto the next day', () => {
    const e = timed('m', '2026-11-14T20:00:00Z', '2026-11-15T08:00:00Z'); // LA 12:00 to 00:00
    expect(spanOf(e, LA)).toMatchObject({
      startDay: '2026-11-14',
      lastDay: '2026-11-14',
      endMinutes: 0,
    });
  });

  it('shows a midnight-crossing event on both days', () => {
    const e = timed('nye', '2027-01-01T03:00:00Z', '2027-01-01T07:00:00Z'); // NY 22:00 Dec 31 to 02:00 Jan 1
    const map = itemsByDay([e], '2026-12-30', '2027-01-02', NY);
    expect([...map.keys()]).toEqual(['2026-12-31', '2027-01-01']);
    expect(map.get('2026-12-31')![0]).toMatchObject({ isFirstDay: true, isLastDay: false });
    expect(map.get('2027-01-01')![0]).toMatchObject({ isFirstDay: false, isLastDay: true });
  });

  it('clips to the requested range', () => {
    const trip = allDay('t', '2026-11-20', '2026-11-30');
    expect([...itemsByDay([trip], '2026-11-22', '2026-11-23', LA).keys()]).toEqual([
      '2026-11-22',
      '2026-11-23',
    ]);
    expect(itemsByDay([trip], '2026-12-01', '2026-12-05', LA).size).toBe(0);
  });

  it('orders a day: all-day first (longest first), continuing, then by time, then title', () => {
    const events = [
      timed('t2', '2026-11-14T20:00:00Z', null, 'Late'),
      timed('t1', '2026-11-14T17:00:00Z', null, 'Early'),
      timed('cont', '2026-11-13T22:00:00Z', '2026-11-14T18:00:00Z', 'Overnight'),
      allDay('a1', '2026-11-14', null, 'Single'),
      allDay('a2', '2026-11-13', '2026-11-16', 'Long'),
    ];
    const day = itemsByDay(events, '2026-11-14', '2026-11-14', LA).get('2026-11-14')!;
    expect(day.map((i) => i.event.id)).toEqual(['a2', 'a1', 'cont', 't1', 't2']);
  });
});

describe('agenda grouping', () => {
  it('always includes today and lists only days with events otherwise', () => {
    const groups = groupAgenda([timed('e', '2026-11-18T18:00:00Z', null)], {
      from: '2026-11-14',
      to: '2026-11-30',
      today: '2026-11-14',
      zone: LA,
    });
    expect(groups.map((g) => [g.day, g.isToday, g.items.length])).toEqual([
      ['2026-11-14', true, 0],
      ['2026-11-18', false, 1],
    ]);
  });
  it('omits today when outside the range', () => {
    expect(
      groupAgenda([], { from: '2026-11-15', to: '2026-11-30', today: '2026-11-14', zone: LA }),
    ).toEqual([]);
  });
});

describe('month grid', () => {
  const trip = allDay('trip', '2026-11-28', '2026-12-02');
  const standup = timed('s', '2026-11-16T17:00:00Z', null);

  it('builds whole weeks, Monday first', () => {
    const g = buildMonthGrid('2026-11-14', [], {
      weekStart: 'monday',
      today: '2026-11-14',
      zone: LA,
    });
    expect(g.month).toBe('2026-11-01');
    expect(g.first).toBe('2026-10-26');
    expect(g.last).toBe('2026-12-06'); // Nov 30 is a Monday, so a sixth week is needed
    expect(g.weeks).toHaveLength(6);
    expect(g.weeks.every((w) => w.length === 7)).toBe(true);
    expect(g.weeks[0]![0]).toMatchObject({ day: '2026-10-26', inMonth: false });
    expect(g.weeks[0]![6]).toMatchObject({ day: '2026-11-01', inMonth: true });
    expect(
      g.weeks
        .flat()
        .filter((c) => c.isToday)
        .map((c) => c.day),
    ).toEqual(['2026-11-14']);
  });

  it('builds Sunday-first weeks and handles months needing six rows or four', () => {
    const sun = buildMonthGrid('2026-11-14', [], {
      weekStart: 'sunday',
      today: '2026-11-14',
      zone: LA,
    });
    expect(sun.first).toBe('2026-11-01');
    expect(sun.weeks).toHaveLength(5);
    const feb = buildMonthGrid('2027-02-10', [], {
      weekStart: 'monday',
      today: '2027-02-10',
      zone: LA,
    });
    expect(feb.weeks).toHaveLength(4); // Feb 2027 starts on Monday and has 28 days
    const aug = buildMonthGrid('2026-08-10', [], {
      weekStart: 'monday',
      today: '2026-08-10',
      zone: LA,
    });
    expect(aug.weeks).toHaveLength(6); // Aug 2026 starts on Saturday, 31 days
  });

  it('places events, including a multi-day event crossing the month boundary', () => {
    const g = buildMonthGrid('2026-11-14', [trip, standup], {
      weekStart: 'monday',
      today: '2026-11-14',
      zone: LA,
    });
    const cells = new Map(g.weeks.flat().map((c) => [c.day, c]));
    expect(cells.get('2026-11-16')!.items.map((i) => i.event.id)).toEqual(['s']);
    expect(cells.get('2026-11-28')!.items.map((i) => i.event.id)).toEqual(['trip']);
    expect(cells.get('2026-11-29')!.items.map((i) => i.event.id)).toEqual(['trip']);
    // Exclusive end: the trip covers Dec 1 but not Dec 2, and out-of-month cells still show events.
    expect(cells.get('2026-12-01')).toMatchObject({ inMonth: false });
    expect(cells.get('2026-12-01')!.items).toHaveLength(1);
    expect(cells.get('2026-12-02')!.items).toHaveLength(0);
  });
});

describe('keyboard cursor', () => {
  it('moves by day, week, week edge and month', () => {
    expect(moveCursor('2026-11-14', 'ArrowRight', 'monday')).toBe('2026-11-15');
    expect(moveCursor('2026-11-14', 'ArrowUp', 'monday')).toBe('2026-11-07');
    expect(moveCursor('2026-11-14', 'Home', 'monday')).toBe('2026-11-09');
    expect(moveCursor('2026-11-14', 'End', 'monday')).toBe('2026-11-15');
    expect(moveCursor('2026-11-14', 'End', 'sunday')).toBe('2026-11-14');
    expect(moveCursor('2026-01-31', 'PageDown', 'monday')).toBe('2026-02-28');
    expect(moveCursor('2026-11-14', 'x', 'monday')).toBeNull();
  });
});
