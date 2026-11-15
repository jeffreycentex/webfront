import { describe, expect, it } from 'vitest';
import { parseQuickAdd } from './quickParse';

// 2026-11-14 is a Saturday.
const TODAY = '2026-11-14';
const p = (s: string, opts = {}) => parseQuickAdd(s, TODAY, opts);

describe('repeat phrases', () => {
  const cases: [string, string, Record<string, unknown>][] = [
    ['water plants every day', 'water plants', { unit: 'day', interval: 1 }],
    ['water plants daily', 'water plants', { unit: 'day', interval: 1 }],
    ['Water plants Daily', 'Water plants', { unit: 'day', interval: 1 }],
    ['standup every weekday', 'standup', { unit: 'week', weekdays: [1, 2, 3, 4, 5] }],
    ['standup weekdays', 'standup', { unit: 'week', weekdays: [1, 2, 3, 4, 5] }],
    ['long run every weekend', 'long run', { unit: 'week', weekdays: [0, 6] }],
    ['gym every friday', 'gym', { unit: 'week', interval: 1, weekdays: [5] }],
    ['gym every fri', 'gym', { unit: 'week', weekdays: [5] }],
    ['gym every mon and thu', 'gym', { unit: 'week', weekdays: [1, 4] }],
    ['gym every mon, wed and fri', 'gym', { unit: 'week', weekdays: [1, 3, 5] }],
    ['gym every Monday & Thursday', 'gym', { unit: 'week', weekdays: [1, 4] }],
    ['gym every fridays', 'gym', { unit: 'week', weekdays: [5] }],
    ['review weekly', 'review', { unit: 'week', interval: 1 }],
    ['review weekly on monday', 'review', { unit: 'week', weekdays: [1] }],
    ['review every week', 'review', { unit: 'week', interval: 1 }],
    ['review every 2 weeks', 'review', { unit: 'week', interval: 2 }],
    ['review every two weeks', 'review', { unit: 'week', interval: 2 }],
    ['review every other week', 'review', { unit: 'week', interval: 2 }],
    [
      'review every 2 weeks on mon and thu',
      'review',
      { unit: 'week', interval: 2, weekdays: [1, 4] },
    ],
    ['stretch every 3 days', 'stretch', { unit: 'day', interval: 3 }],
    ['stretch every other day', 'stretch', { unit: 'day', interval: 2 }],
    ['pay rent monthly', 'pay rent', { unit: 'month', interval: 1 }],
    ['pay rent every month', 'pay rent', { unit: 'month', interval: 1 }],
    ['pay rent every month on the 1st', 'pay rent', { unit: 'month', day: 1 }],
    ['pay rent every month on the 15th', 'pay rent', { unit: 'month', day: 15 }],
    ['pay rent monthly on the 15th', 'pay rent', { unit: 'month', day: 15 }],
    ['pay rent every 3 months on the 2nd', 'pay rent', { unit: 'month', interval: 3, day: 2 }],
    ['renew domain every year', 'renew domain', { unit: 'year', interval: 1 }],
    ['renew domain yearly', 'renew domain', { unit: 'year' }],
    ['renew domain annually', 'renew domain', { unit: 'year' }],
    ['renew domain every 2 years', 'renew domain', { unit: 'year', interval: 2 }],
  ];
  it.each(cases)('%s', (input, title, rule) => {
    const r = p(input);
    expect(r.title).toBe(title);
    expect(r.rule).toMatchObject(rule);
    expect(r.repeatPhrase).not.toBe('');
    expect(r.dueDate).not.toBeNull();
  });

  it('first due date: today, or the next matching weekday / day of the month', () => {
    expect(p('x every day').dueDate).toBe('2026-11-14');
    expect(p('x every monday').dueDate).toBe('2026-11-16');
    expect(p('x every sat').dueDate).toBe('2026-11-14');
    expect(p('x every mon and thu').dueDate).toBe('2026-11-16');
    expect(p('x every month on the 15th').dueDate).toBe('2026-11-15');
    expect(p('x every month on the 1st').dueDate).toBe('2026-12-01');
  });

  it('makes weekday and day of the month explicit', () => {
    expect(p('x weekly').rule).toMatchObject({ weekdays: [6] });
    expect(p('x monthly').rule).toMatchObject({ day: 14 });
  });
});

describe('combined with dates', () => {
  it('"starting" date after the phrase', () => {
    const r = p('water plants every 3 days starting tomorrow');
    expect(r.title).toBe('water plants');
    expect(r.rule).toMatchObject({ unit: 'day', interval: 3 });
    expect(r.dueDate).toBe('2026-11-15');
    expect(r.datePhrase).toBe('tomorrow');
  });
  it('from / bare date after the phrase', () => {
    expect(p('water plants every 3 days from nov 20').dueDate).toBe('2026-11-20');
    expect(p('pay rent every month tomorrow').dueDate).toBe('2026-11-15');
    expect(p('pay rent every month starting dec 1').dueDate).toBe('2026-12-01');
  });
  it('a start date moves to the first matching weekday', () => {
    const r = p('gym every mon and thu starting tomorrow'); // Sunday
    expect(r.dueDate).toBe('2026-11-16');
    expect(r.rule).toMatchObject({ weekdays: [1, 4] });
  });
  it('"on <weekday>" and "on <date>" with the phrase', () => {
    const r = p('review every 2 weeks on mon');
    expect(r.title).toBe('review');
    expect(r.rule).toMatchObject({ unit: 'week', interval: 2, weekdays: [1] });
    expect(r.dueDate).toBe('2026-11-16');
    const y = p('birthday card every year on nov 20');
    expect(y.title).toBe('birthday card');
    expect(y.rule).toMatchObject({ unit: 'year' });
    expect(y.dueDate).toBe('2026-11-20');
  });
  it('a date at the start of the text still applies', () => {
    const r = p('tomorrow water plants every day');
    expect(r.title).toBe('water plants');
    expect(r.dueDate).toBe('2026-11-15');
    expect(r.rule).toMatchObject({ unit: 'day' });
  });
  it('an "on" before the phrase is dropped from the title', () => {
    expect(p('pay rent on every month').title).toBe('pay rent');
  });
  it('plain dates still work without a rule', () => {
    const r = p('call mum fri');
    expect(r).toMatchObject({
      title: 'call mum',
      dueDate: '2026-11-20',
      rule: null,
      repeatPhrase: '',
    });
  });
});

describe('false positives and empty titles', () => {
  it.each([
    'every little thing',
    'every day is a school day',
    'Read Every Day Matters',
    'call every plumber in town',
    'weekly report template draft',
    'buy a weekly pass',
    'pick up the monthly magazine now',
    'daily news',
    'every',
    'every day',
    'daily',
    'every friday',
    'weekdays',
    'monthly',
  ])('%s has no rule', (input) => {
    const r = p(input);
    expect(r.rule).toBeNull();
    expect(r.title.length).toBeGreaterThan(0);
  });
  it('the phrase must be at the end', () => {
    const r = p('every day pick up milk');
    expect(r.rule).toBeNull();
    expect(r.title).toBe('every day pick up milk');
  });
  it('rejects malformed phrases', () => {
    expect(p('x every days').rule).toBeNull();
    expect(p('x every 0 days').rule).toBeNull();
    expect(p('x every month on the 40th').rule).toBeNull();
    expect(p('x every mon and').rule).toBeNull();
    expect(p('x every 2 mondays').rule).toBeNull();
  });
  it('never returns an empty title', () => {
    for (const s of [
      'every day',
      'x',
      ' ',
      'daily tomorrow',
      'on every friday',
      'every mon and thu',
    ])
      expect(p(s).title.length > 0 || s.trim() === '').toBe(true);
  });
});

describe('removing a chip keeps the words in the title', () => {
  it('repeat chip removed', () => {
    const r = p('water plants every 3 days', { ignoreRepeat: true });
    expect(r).toMatchObject({ title: 'water plants every 3 days', rule: null, dueDate: null });
  });
  it('repeat chip removed but the combined date stays', () => {
    const r = p('water plants every 3 days starting tomorrow', { ignoreRepeat: true });
    expect(r).toMatchObject({
      title: 'water plants every 3 days',
      rule: null,
      dueDate: '2026-11-15',
    });
  });
  it('date chip removed but the repeat stays', () => {
    const r = p('water plants every 3 days starting tomorrow', { ignoreDate: true });
    expect(r.rule).toMatchObject({ unit: 'day', interval: 3 });
    expect(r.title).toBe('water plants starting tomorrow');
    expect(r.dueDate).toBe('2026-11-14');
  });
  it('both removed', () => {
    const r = p('water plants every 3 days starting tomorrow', {
      ignoreDate: true,
      ignoreRepeat: true,
    });
    expect(r).toMatchObject({ rule: null, dueDate: null });
    expect(r.title).toBe('water plants every 3 days starting tomorrow');
  });
});
