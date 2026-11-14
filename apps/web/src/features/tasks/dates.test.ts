import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  diffDays,
  formatDueLabel,
  parseTaskInput,
  resolvePhrase,
  todayISO,
  weekdayOf,
} from './dates';

// 2026-11-14 is a Saturday.
const TODAY = '2026-11-14';
const parse = (s: string, today = TODAY) => parseTaskInput(s, today);

describe('calendar arithmetic', () => {
  it('knows weekdays', () => {
    expect(weekdayOf(TODAY)).toBe(6);
    expect(weekdayOf('2026-11-16')).toBe(1);
  });
  it('adds days across month, year and leap boundaries', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2027-03-01', -1)).toBe('2027-02-28');
    expect(addDays('2026-11-14', -14)).toBe('2026-10-31');
  });
  it('is unaffected by DST transitions', () => {
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02');
    expect(diffDays('2026-03-01', '2026-04-01')).toBe(31);
  });
  it('clamps months', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-12-15', 2)).toBe('2027-02-15');
  });
  it('todayISO uses the local calendar date', () => {
    expect(todayISO(new Date(2026, 10, 14, 0, 5))).toBe('2026-11-14');
    expect(todayISO(new Date(2026, 10, 14, 23, 59, 59))).toBe('2026-11-14');
    expect(todayISO(new Date(2027, 0, 1, 0, 0))).toBe('2027-01-01');
  });
});

describe('resolvePhrase', () => {
  const cases: Array<[string, string | null]> = [
    ['today', TODAY],
    ['Tonight', TODAY],
    ['tomorrow', '2026-11-15'],
    ['tmrw', '2026-11-15'],
    ['yesterday', '2026-11-13'],
    ['sun', '2026-11-15'],
    ['monday', '2026-11-16'],
    ['fri', '2026-11-20'],
    ['sat', '2026-11-21'], // today is Saturday: the NEXT one
    ['this fri', '2026-11-20'],
    ['on friday', '2026-11-20'],
    ['next fri', '2026-11-20'],
    ['next mon', '2026-11-16'],
    ['next week', '2026-11-16'],
    ['next month', '2026-12-14'],
    ['in 3 days', '2026-11-17'],
    ['in 1 day', '2026-11-15'],
    ['in 2 weeks', '2026-11-28'],
    ['in a week', '2026-11-21'],
    ['in two days', '2026-11-16'],
    ['in 2w', '2026-11-28'],
    ['in 10d', '2026-11-24'],
    ['in 1 month', '2026-12-14'],
    ['nov 20', '2026-11-20'],
    ['Nov 20th', '2026-11-20'],
    ['november 20', '2026-11-20'],
    ['nov 14', TODAY],
    ['nov 13', '2027-11-13'], // already passed: next year
    ['jan 5', '2027-01-05'],
    ['dec 25, 2028', '2028-12-25'],
    ['20 nov', '2026-11-20'],
    ['3rd of dec', '2026-12-03'],
    ['2026-12-01', '2026-12-01'],
    ['11/20', '2026-11-20'],
    ['11/20/2027', '2027-11-20'],
    ['20/11', '2026-11-20'],
    ['feb 30', null],
    ['2026-02-30', null],
    ['13/45', null],
    ['banana', null],
    ['may', null],
    ['in x days', null],
    ['', null],
  ];
  it.each(cases)('%s -> %s', (phrase, expected) => {
    expect(resolvePhrase(phrase, TODAY)).toBe(expected);
  });

  it('handles Feb 29 on non-leap years', () => {
    expect(resolvePhrase('feb 30', '2026-11-14')).toBe(null);
    expect(resolvePhrase('feb 29', '2026-11-14')).toBe('2028-02-29');
    expect(resolvePhrase('feb 29', '2027-11-14')).toBe('2028-02-29');
  });
  it('rolls into next year from late December', () => {
    expect(resolvePhrase('tomorrow', '2026-12-31')).toBe('2027-01-01');
    expect(resolvePhrase('fri', '2026-12-31')).toBe('2027-01-01');
  });
  it('treats "next <weekday>" as next Monday-Sunday week', () => {
    // Wednesday 2026-11-11: "fri" is this week, "next fri" is the week after.
    expect(resolvePhrase('fri', '2026-11-11')).toBe('2026-11-13');
    expect(resolvePhrase('next fri', '2026-11-11')).toBe('2026-11-20');
    expect(resolvePhrase('next tue', '2026-11-11')).toBe('2026-11-17');
  });
});

describe('parseTaskInput', () => {
  it('extracts a trailing date', () => {
    expect(parse('pay rent tomorrow')).toEqual({
      title: 'pay rent',
      dueDate: '2026-11-15',
      phrase: 'tomorrow',
    });
  });
  it('handles multi-word phrases', () => {
    expect(parse('renew passport in 3 days')).toMatchObject({
      title: 'renew passport',
      dueDate: '2026-11-17',
    });
    expect(parse('book flights nov 20')).toMatchObject({
      title: 'book flights',
      dueDate: '2026-11-20',
    });
    expect(parse('dentist next fri')).toMatchObject({ title: 'dentist', dueDate: '2026-11-20' });
  });
  it('drops connector words', () => {
    expect(parse('call mum on fri')).toMatchObject({ title: 'call mum', dueDate: '2026-11-20' });
    expect(parse('submit report by tomorrow')).toMatchObject({ title: 'submit report' });
    expect(parse('taxes due nov 20')).toMatchObject({ title: 'taxes', dueDate: '2026-11-20' });
  });
  it('finds a leading date', () => {
    expect(parse('tomorrow buy milk')).toMatchObject({ title: 'buy milk', dueDate: '2026-11-15' });
  });
  it('prefers the longest trailing phrase', () => {
    expect(parse('party november 20 2027')).toMatchObject({
      title: 'party',
      dueDate: '2027-11-20',
    });
  });
  it('leaves text without dates alone', () => {
    expect(parse('buy milk')).toEqual({ title: 'buy milk', dueDate: null, phrase: '' });
    expect(parse('  spaced   out  ')).toMatchObject({ title: 'spaced out', dueDate: null });
  });
  it('does not turn a bare date phrase into an empty title', () => {
    expect(parse('tomorrow')).toEqual({ title: 'tomorrow', dueDate: null, phrase: '' });
    expect(parse('on friday')).toMatchObject({ dueDate: null });
  });
  it('is stable for the same instant in any local zone (pure string math)', () => {
    expect(parse('x tomorrow', '2026-03-07').dueDate).toBe('2026-03-08');
    expect(parse('x tomorrow', '2026-03-08').dueDate).toBe('2026-03-09');
    expect(parse('x in 7 days', '2026-10-28').dueDate).toBe('2026-11-04');
  });
});

describe('formatDueLabel', () => {
  it('uses friendly labels near today', () => {
    expect(formatDueLabel('2026-11-14', TODAY)).toBe('Today');
    expect(formatDueLabel('2026-11-15', TODAY)).toBe('Tomorrow');
    expect(formatDueLabel('2026-11-13', TODAY)).toBe('Yesterday');
    expect(formatDueLabel('2026-11-10', TODAY)).toBe('4d ago');
    expect(formatDueLabel('2026-11-18', TODAY)).toBe('Wed');
    expect(formatDueLabel('2026-12-25', TODAY)).toBe('Dec 25');
    expect(formatDueLabel('2027-01-02', TODAY)).toBe('Jan 2 2027');
  });
});
