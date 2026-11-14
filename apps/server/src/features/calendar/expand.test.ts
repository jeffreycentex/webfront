import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { calendarEventFields } from '@webfront/shared';
import { expandIcs, occurrenceId, addDaysYmd } from './expand.js';
import { instantForWallClock } from './tz.js';

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

const FEED = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const NOW = new Date('2026-11-14T12:00:00Z');

function run(name: string) {
  return expandIcs(fixture(name), { feedId: FEED, now: NOW });
}
const byTitle = (r: ReturnType<typeof run>, title: string) =>
  r.events.filter((e) => e.fields.title === title).map((e) => e.fields);

describe('google-style feed', () => {
  const r = run('google.ics');

  it('produces schema-valid records with deterministic uuid ids', () => {
    expect(r.skipped).toBe(0);
    for (const e of r.events) {
      expect(calendarEventFields.safeParse(e.fields).success).toBe(true);
      expect(e.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    expect(new Set(r.events.map((e) => e.id)).size).toBe(r.events.length);
    expect(run('google.ics').events.map((e) => e.id)).toEqual(r.events.map((e) => e.id));
  });

  it('expands weekly rules with EXDATE, overrides and cancelled instances', () => {
    const standups = r.events
      .filter((e) => e.fields.uid === 'standup-1@google.com')
      .map((e) => e.fields.start)
      .sort();
    expect(standups).toContain('2026-10-19T13:00:00.000Z'); // Mon, EDT
    expect(standups).not.toContain('2026-11-09T14:00:00.000Z'); // EXDATE
    expect(standups).not.toContain('2026-11-23T14:00:00.000Z'); // cancelled instance
    expect(standups).not.toContain('2026-11-18T14:00:00.000Z'); // replaced by the override
    expect(standups).toContain('2026-11-18T19:00:00.000Z'); // 14:00 EST
    expect(standups).toContain('2026-11-16T14:00:00.000Z'); // Monday after DST ends: 09:00 EST
    expect(standups.at(-1)! <= '2026-12-31T23:59:59.000Z').toBe(true);
    const moved = byTitle(r, 'Standup (moved to afternoon)');
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ tz: 'America/New_York', recurring: true });
  });

  it('keeps the same local time across the DST change (weekly Sunday 09:00)', () => {
    const brunch = byTitle(r, 'Sunday brunch')
      .map((e) => e.start)
      .sort();
    expect(brunch[0]).toBe('2026-10-25T13:00:00.000Z');
    expect(brunch[1]).toBe('2026-11-01T14:00:00.000Z');
    expect(brunch[2]).toBe('2026-11-08T14:00:00.000Z');
  });

  it('keys overrides by RECURRENCE-ID so ids survive the instance moving', () => {
    const moved = r.events.find((e) => e.fields.start === '2026-11-18T19:00:00.000Z')!;
    expect(moved.id).toBe(occurrenceId(FEED, 'standup-1@google.com', '2026-11-18T14:00:00.000Z'));
  });

  it('stores all-day events as dates with an exclusive end', () => {
    const [trip] = byTitle(r, 'Lisbon trip');
    expect(trip).toMatchObject({ allDay: true, start: '2026-11-20', end: '2026-11-24', tz: null });
    expect(trip!.description).toContain('Booking ref ABC123');
    const [bday] = byTitle(r, "Sam's birthday");
    expect(bday).toMatchObject({
      allDay: true,
      start: '2027-03-01',
      end: '2027-03-02',
      recurring: true,
    });
  });

  it('keeps UTC events, location and a safe url; drops cancelled and out-of-window events', () => {
    const [dinner] = byTitle(r, 'Dinner');
    expect(dinner).toMatchObject({
      allDay: false,
      start: '2026-12-01T18:00:00.000Z',
      end: '2026-12-01T20:00:00.000Z',
      location: 'Chez Panisse, Berkeley',
      url: 'https://calendar.example.com/event?eid=abc',
      tz: 'UTC',
    });
    expect(byTitle(r, 'Cancelled thing')).toHaveLength(0);
    expect(byTitle(r, 'Long ago')).toHaveLength(0);
  });
});

describe('outlook-style feed', () => {
  const r = run('outlook.ics');

  it('maps Windows zone names and follows DST', () => {
    const sync = r.events.filter((e) => e.fields.uid.startsWith('0400000082')).map((e) => e.fields);
    const byStart = new Map(sync.map((e) => [e.start, e]));
    expect(byStart.get('2026-10-27T14:00:00.000Z')?.tz).toBe('America/New_York'); // EDT
    expect(byStart.has('2026-11-03T15:00:00.000Z')).toBe(true); // EST
    expect(byStart.has('2026-11-10T15:00:00.000Z')).toBe(false); // moved
    expect(byStart.get('2026-11-10T15:30:00.000Z')?.title).toBe('Team sync (late start)');
    expect(sync[0]!.location).toBe('Teams Meeting');
  });

  it('handles W. Europe Standard Time without a VTIMEZONE block', () => {
    const [call] = byTitle(r, 'Berlin call');
    expect(call).toMatchObject({ start: '2026-12-15T08:00:00.000Z', tz: 'Europe/Berlin' });
  });

  it('handles multi-day all-day events and events spanning midnight', () => {
    const [holiday] = byTitle(r, 'Holiday');
    expect(holiday).toMatchObject({ allDay: true, start: '2026-12-24', end: '2026-12-28' });
    const [nye] = byTitle(r, "New Year's Eve party (spans midnight)");
    expect(nye).toMatchObject({
      start: '2027-01-01T03:00:00.000Z',
      end: '2027-01-01T07:00:00.000Z',
    });
  });

  it('applies the spring-forward offset', () => {
    const [e] = byTitle(r, 'Monday after spring-forward');
    expect(e!.start).toBe('2027-03-15T13:00:00.000Z'); // EDT
  });
});

describe('window and floating times', () => {
  it('only includes occurrences inside 30 days back / 180 days ahead', () => {
    const r = run('google.ics');
    for (const e of r.events) {
      const start = e.fields.allDay
        ? Date.parse(`${e.fields.start}T00:00:00Z`)
        : Date.parse(e.fields.start);
      expect(start).toBeGreaterThan(NOW.getTime() - 31 * 86_400_000);
      expect(start).toBeLessThan(NOW.getTime() + 181 * 86_400_000);
    }
  });

  const floating = `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//\nX-WR-TIMEZONE:Asia/Tokyo\nBEGIN:VEVENT\nUID:f1\nDTSTAMP:20261001T000000Z\nDTSTART:20261120T090000\nDTEND:20261120T100000\nSUMMARY:Floating\nEND:VEVENT\nEND:VCALENDAR\n`;

  it('reads floating times in X-WR-TIMEZONE', () => {
    const r = expandIcs(floating, { feedId: FEED, now: NOW });
    expect(r.events[0]!.fields).toMatchObject({
      start: '2026-11-20T00:00:00.000Z',
      end: '2026-11-20T01:00:00.000Z',
      tz: 'Asia/Tokyo',
    });
  });

  it('keeps all-day dates unchanged whatever the server zone', () => {
    const before = process.env.TZ;
    const ics = `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//\nBEGIN:VEVENT\nUID:d1\nDTSTAMP:20261001T000000Z\nDTSTART;VALUE=DATE:20261120\nDTEND;VALUE=DATE:20261122\nSUMMARY:Two days\nEND:VEVENT\nEND:VCALENDAR\n`;
    try {
      for (const zone of ['Pacific/Auckland', 'America/Los_Angeles', 'UTC']) {
        process.env.TZ = zone;
        const r = expandIcs(ics, { feedId: FEED, now: NOW });
        expect(r.events[0]!.fields).toMatchObject({ start: '2026-11-20', end: '2026-11-22' });
      }
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });
});

describe('helpers', () => {
  const w = (year: number, month: number, day: number, hour: number, minute = 0) => ({
    year,
    month,
    day,
    hour,
    minute,
    second: 0,
  });
  const iso = (ms: number) => new Date(ms).toISOString();
  it('wall clock to instant, including DST gap and overlap', () => {
    expect(iso(instantForWallClock(w(2026, 11, 20, 9), 'Asia/Tokyo'))).toBe(
      '2026-11-20T00:00:00.000Z',
    );
    // 01:30 happens twice on 2026-11-01 in New York: the earlier instant (EDT) wins.
    expect(iso(instantForWallClock(w(2026, 11, 1, 1, 30), 'America/New_York'))).toBe(
      '2026-11-01T05:30:00.000Z',
    );
    // 02:30 does not exist on 2027-03-14: moves forward to 03:30 EDT.
    expect(iso(instantForWallClock(w(2027, 3, 14, 2, 30), 'America/New_York'))).toBe(
      '2027-03-14T07:30:00.000Z',
    );
  });
  it('addDaysYmd', () => {
    expect(addDaysYmd('2026-12-31', 1)).toBe('2027-01-01');
  });
});
