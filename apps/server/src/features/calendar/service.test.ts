import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../../../test/helpers.js';
import type { AppContext } from '../../context.js';
import { createCalendarFeature } from './index.js';
import { fetchFeed, normaliseFeedUrl } from './fetchFeed.js';
import type { CalendarService } from './service.js';
import { register as registerSync } from '../sync/index.js';

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

const NOW = new Date('2026-11-14T12:00:00Z');
const SECRET = 'https://calendar.example.com/ical/SECRET-TOKEN-123/basic.ics';
const FEED_ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const FEED_2 = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';

interface Call {
  url: string;
  headers: Record<string, string>;
}

function makeFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = async (input: string, init?: RequestInit) => {
    const call = { url: input, headers: (init?.headers ?? {}) as Record<string, string> };
    calls.push(call);
    return handler(call);
  };
  return { fn, calls };
}

const ics = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/calendar', ...headers } });

const contexts: AppContext[] = [];
afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});

async function setup(handler: Parameters<typeof makeFetch>[0], signedIn = true) {
  const f = makeFetch(handler);
  let service!: CalendarService;
  const { app, ctx } = await createTestApp({
    signedIn,
    features: [
      { name: 'sync', register: registerSync },
      {
        name: 'calendar',
        register: createCalendarFeature({
          fetch: f.fn,
          now: () => NOW,
          autoStart: false,
          onService: (s) => (service = s),
        }),
      },
    ],
  });
  contexts.push(ctx);
  const addFeed = (id = FEED_ID, url = SECRET, extra: Record<string, unknown> = {}) =>
    ctx.records.writeAsServer('calendarFeeds', [
      { id, fields: { name: 'Test', url, colour: 'blue', enabled: true, ...extra } },
    ]);
  const liveEvents = (feedId = FEED_ID) =>
    ctx.records.list('calendarEvents').filter((e) => e.feedId === feedId);
  return { app, ctx, service, calls: f.calls, addFeed, liveEvents };
}

const post = (
  app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> },
  path: string,
) => app.request(path, { method: 'POST' });

describe('feed refresh', () => {
  it('fetches a new feed, stores occurrences and records status on the feed', async () => {
    const t = await setup(() => ics(fixture('google.ics'), { etag: '"v1"' }));
    t.addFeed();
    await t.service.reconcile();
    expect(t.calls).toHaveLength(1);
    expect(t.liveEvents().length).toBeGreaterThan(20);
    const feed = t.ctx.records.get('calendarFeeds', FEED_ID)!;
    expect(feed.lastError).toBeNull();
    expect(feed.lastFetchedAt).toBe(NOW.toISOString());
    expect(feed.eventCount).toBe(t.liveEvents().length);
    // A second reconcile has nothing to do.
    await t.service.reconcile();
    expect(t.calls).toHaveLength(1);
  });

  it('sends conditional headers and writes nothing on 304', async () => {
    let n = 0;
    const t = await setup((call) => {
      n++;
      if (n === 1)
        return ics(fixture('google.ics'), {
          etag: '"v1"',
          'last-modified': 'Mon, 02 Nov 2026 10:00:00 GMT',
        });
      expect(call.headers['if-none-match']).toBe('"v1"');
      expect(call.headers['if-modified-since']).toBe('Mon, 02 Nov 2026 10:00:00 GMT');
      return new Response(null, { status: 304 });
    });
    t.addFeed();
    await t.service.refreshFeed(FEED_ID);
    const before = t.ctx.records.list('calendarEvents', { includeDeleted: true });
    const r = await t.service.refreshFeed(FEED_ID);
    expect(r).toMatchObject({ ok: true, written: 0 });
    expect(t.calls).toHaveLength(2);
    const after = t.ctx.records.list('calendarEvents', { includeDeleted: true });
    expect(after.map((e) => e.updatedAt)).toEqual(before.map((e) => e.updatedAt));
  });

  it('writes only changed occurrences and tombstones vanished ones', async () => {
    let body = fixture('google.ics');
    const t = await setup(() => ics(body));
    t.addFeed();
    await t.service.refreshFeed(FEED_ID);
    const total = t.liveEvents().length;
    body = body
      .replace('SUMMARY:Dinner', 'SUMMARY:Late dinner')
      .replace(/BEGIN:VEVENT\nDTSTART;VALUE=DATE:20261120[\s\S]*?END:VEVENT\n/, '');
    const r = await t.service.refreshFeed(FEED_ID);
    expect(r.written).toBe(2); // one changed title, one tombstone
    expect(t.liveEvents()).toHaveLength(total - 1);
    expect(t.liveEvents().some((e) => e.title === 'Late dinner')).toBe(true);
    expect(t.liveEvents().some((e) => e.title === 'Lisbon trip')).toBe(false);
  });

  it('removes events when a feed is disabled or deleted, and restores them on re-enable', async () => {
    const t = await setup(() => ics(fixture('outlook.ics')));
    t.addFeed();
    await t.service.reconcile();
    expect(t.liveEvents().length).toBeGreaterThan(5);

    t.ctx.records.writeAsServer('calendarFeeds', [{ id: FEED_ID, fields: { enabled: false } }]);
    await t.service.reconcile();
    expect(t.liveEvents()).toHaveLength(0);
    expect(t.ctx.records.get('calendarFeeds', FEED_ID)!.eventCount).toBe(0);

    t.ctx.records.writeAsServer('calendarFeeds', [{ id: FEED_ID, fields: { enabled: true } }]);
    await t.service.reconcile();
    expect(t.liveEvents().length).toBeGreaterThan(5);

    t.ctx.records.writeAsServer('calendarFeeds', [{ id: FEED_ID, fields: { deleted: true } }]);
    await t.service.reconcile();
    expect(t.liveEvents()).toHaveLength(0);
  });

  it('refetches when the URL changes and keeps feeds separate', async () => {
    const t = await setup((call) =>
      ics(call.url.includes('one') ? fixture('google.ics') : fixture('outlook.ics')),
    );
    t.addFeed(FEED_ID, 'https://x.example.com/one.ics');
    t.addFeed(FEED_2, 'https://x.example.com/two.ics');
    await t.service.reconcile();
    const first = t.liveEvents(FEED_ID).length;
    const second = t.liveEvents(FEED_2).length;
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(0);
    t.ctx.records.writeAsServer('calendarFeeds', [
      { id: FEED_ID, fields: { url: 'https://x.example.com/two.ics' } },
    ]);
    await t.service.reconcile();
    expect(t.calls).toHaveLength(3);
    expect(t.liveEvents(FEED_ID)).toHaveLength(second);
    // Same UIDs in both feeds still get distinct ids.
    const ids = t.ctx.records.list('calendarEvents').map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('reacts to records.changed for calendarFeeds (debounced), without a loop', async () => {
    const t = await setup(() => ics(fixture('google.ics')));
    const stop = t.service.start({ reconcileDelayMs: 0, startDelayMs: 3_600_000 });
    try {
      t.addFeed();
      await new Promise((r) => setTimeout(r, 20));
      await t.service.settled();
      await new Promise((r) => setTimeout(r, 20));
      await t.service.settled();
      expect(t.calls).toHaveLength(1);
      expect(t.liveEvents().length).toBeGreaterThan(0);
    } finally {
      stop();
    }
  });
});

describe('errors never leak the feed URL', () => {
  it('stores a short message for HTTP errors and keeps old events', async () => {
    let fail = false;
    const t = await setup(() =>
      fail ? new Response('nope', { status: 404 }) : ics(fixture('google.ics')),
    );
    t.addFeed();
    await t.service.refreshFeed(FEED_ID);
    const count = t.liveEvents().length;
    fail = true;
    const r = await t.service.refreshFeed(FEED_ID);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('The calendar server answered HTTP 404');
    const feed = t.ctx.records.get('calendarFeeds', FEED_ID)!;
    expect(feed.lastError).toBe(r.error);
    expect(feed.lastError).not.toContain('SECRET');
    expect(t.liveEvents()).toHaveLength(count);
  });

  it('hides network error details that embed the URL', async () => {
    const t = await setup(() => {
      throw new Error(`connect ECONNREFUSED ${SECRET}`);
    });
    t.addFeed();
    const r = await t.service.refreshFeed(FEED_ID);
    expect(r.error).toBe('Could not reach the calendar server');
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });

  it('rejects HTML and unparsable bodies with a clear message', async () => {
    const t = await setup(() => ics('<html>Sign in</html>'));
    t.addFeed();
    const r = await t.service.refreshFeed(FEED_ID);
    expect(r.error).toMatch(/did not return an iCalendar/);
    expect(t.ctx.records.get('calendarFeeds', FEED_ID)!.lastError).toBe(r.error);
  });
});

describe('fetchFeed safety', () => {
  it('rewrites webcal:// to https:// and rejects other schemes', async () => {
    expect(normaliseFeedUrl('webcal://example.com/a.ics').toString()).toBe(
      'https://example.com/a.ics',
    );
    expect(normaliseFeedUrl('WEBCALS://example.com/a.ics').protocol).toBe('https:');
    expect(() => normaliseFeedUrl('file:///etc/passwd')).toThrow();
    expect(() => normaliseFeedUrl('ftp://example.com/a.ics')).toThrow();
    expect(() => normaliseFeedUrl('not a url')).toThrow();
    const f = makeFetch(() => ics('BEGIN:VCALENDAR\nEND:VCALENDAR'));
    await fetchFeed('webcal://example.com/a.ics', { fetch: f.fn });
    expect(f.calls[0]!.url).toBe('https://example.com/a.ics');
  });

  it('follows a limited number of redirects and refuses unsupported targets', async () => {
    let hops = 0;
    const f = makeFetch((call) => {
      if (call.url.endsWith('/final')) return ics('BEGIN:VCALENDAR\nEND:VCALENDAR');
      hops++;
      return new Response(null, { status: 302, headers: { location: '/final' } });
    });
    await expect(fetchFeed('https://a.example.com/start', { fetch: f.fn })).resolves.toMatchObject({
      status: 'ok',
    });
    expect(hops).toBe(1);

    const loop = makeFetch(
      () => new Response(null, { status: 301, headers: { location: '/again' } }),
    );
    await expect(
      fetchFeed('https://a.example.com/x', { fetch: loop.fn, maxRedirects: 3 }),
    ).rejects.toThrow('Too many redirects');
    expect(loop.calls).toHaveLength(4);

    const bad = makeFetch(
      () => new Response(null, { status: 302, headers: { location: 'file:///etc/passwd' } }),
    );
    await expect(fetchFeed('https://a.example.com/x', { fetch: bad.fn })).rejects.toThrow(
      'unsupported address',
    );
  });

  it('enforces the size cap with and without Content-Length', async () => {
    const big = 'BEGIN:VCALENDAR\n' + 'X-PAD:' + 'a'.repeat(5000) + '\nEND:VCALENDAR';
    const a = makeFetch(() => ics(big, { 'content-length': String(big.length) }));
    await expect(
      fetchFeed('https://a.example.com/x', { fetch: a.fn, maxBytes: 1000 }),
    ).rejects.toThrow('too large');
    const b = makeFetch(() => ics(big));
    await expect(
      fetchFeed('https://a.example.com/x', { fetch: b.fn, maxBytes: 1000 }),
    ).rejects.toThrow('too large');
  });

  it('times out slow servers', async () => {
    const f = makeFetch(
      (call) =>
        new Promise<Response>((_, reject) => {
          void call;
          setTimeout(
            () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })),
            30,
          );
        }),
    );
    await expect(fetchFeed(SECRET, { fetch: f.fn, timeoutMs: 10 })).rejects.toThrow(
      'took too long',
    );
  });
});

describe('HTTP endpoints', () => {
  it('POST /api/calendar/feeds/:id/refresh and /api/calendar/refresh', async () => {
    const t = await setup(() => ics(fixture('google.ics')));
    t.addFeed();
    const one = await post(t.app, `/api/calendar/feeds/${FEED_ID}/refresh`);
    expect(one.status).toBe(200);
    const body = (await one.json()) as {
      ok: boolean;
      results: Array<{ feedId: string; events: number }>;
    };
    expect(body.ok).toBe(true);
    expect(body.results[0]!.events).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain('SECRET');

    const all = await post(t.app, '/api/calendar/refresh');
    expect(all.status).toBe(200);
    expect(((await all.json()) as { results: unknown[] }).results).toHaveLength(1);
  });

  it('404 for unknown feeds, 400 for bad ids, 401 when signed out', async () => {
    const t = await setup(() => ics(fixture('google.ics')));
    expect((await post(t.app, `/api/calendar/feeds/${FEED_2}/refresh`)).status).toBe(404);
    expect((await post(t.app, '/api/calendar/feeds/nope/refresh')).status).toBe(400);
    const out = await setup(() => ics(fixture('google.ics')), false);
    expect((await post(out.app, '/api/calendar/refresh')).status).toBe(401);
  });
});
