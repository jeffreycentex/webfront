import { newId } from '@webfront/shared';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../test/helpers.js';
import { HttpClientError, type HttpGet, type HttpResult } from '../favicons/httpClient.js';
import { register as syncRegister } from '../sync/index.js';
import { decideWrite, latencyBucket, probeService, type ProbeDeps } from './checker.js';
import { createServicesFeature } from './index.js';

const ok = (url: string, status = 200): HttpResult => ({
  status,
  url,
  headers: {},
  body: Buffer.alloc(0),
  truncated: false,
  redirects: 0,
});

const baseCheck = {
  type: 'http' as const,
  url: null,
  method: 'GET' as const,
  expectedStatus: null,
  allowInsecureTls: true,
  timeoutMs: 1000,
};

describe('probeService', () => {
  const deps = (over: Partial<ProbeDeps>): ProbeDeps => ({
    httpGet: async (o) => ok(o.url),
    tcpConnect: async () => {},
    now: (() => {
      let t = 0;
      return () => (t += 10);
    })(),
    ...over,
  });

  it('treats any non-5xx status as up, and 5xx as down', async () => {
    const b = { url: 'https://nas.lan/' };
    expect(
      (await probeService(b, baseCheck, deps({ httpGet: async (o) => ok(o.url, 401) }))).state,
    ).toBe('up');
    const down = await probeService(b, baseCheck, deps({ httpGet: async (o) => ok(o.url, 502) }));
    expect(down).toMatchObject({ state: 'down', message: 'HTTP 502' });
  });

  it('honours expectedStatus, url override, method and insecure TLS', async () => {
    let seen: Parameters<HttpGet>[0] | undefined;
    const d = deps({
      httpGet: async (o) => {
        seen = o;
        return ok(o.url, 204);
      },
    });
    const r = await probeService(
      { url: 'https://a.lan/' },
      { ...baseCheck, url: 'https://a.lan/health', method: 'HEAD', expectedStatus: 200 },
      d,
    );
    expect(r.state).toBe('down');
    expect(seen).toMatchObject({
      url: 'https://a.lan/health',
      method: 'HEAD',
      insecureTls: true,
      maxRedirects: 0,
    });
  });

  it('reports errors and TCP results without throwing', async () => {
    const r = await probeService(
      { url: 'https://a.lan/' },
      baseCheck,
      deps({
        httpGet: async () => {
          throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' });
        },
      }),
    );
    expect(r).toMatchObject({ state: 'down', message: 'ECONNREFUSED' });
    const tcp = await probeService(
      { url: 'https://a.lan/' },
      { type: 'tcp', host: 'db.lan', port: 5432, timeoutMs: 1000 },
      deps({
        tcpConnect: async (h, p) => {
          expect([h, p]).toEqual(['db.lan', 5432]);
        },
      }),
    );
    expect(tcp.state).toBe('up');
    const timeout = await probeService(
      { url: 'https://a.lan/' },
      baseCheck,
      deps({
        httpGet: async () => {
          throw new HttpClientError('timeout', 'Timed out');
        },
      }),
    );
    expect(timeout.message).toBe('Timed out');
  });
});

describe('decideWrite', () => {
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  const up = { state: 'up' as const, latencyMs: 20, message: null };
  const down = { state: 'down' as const, latencyMs: 20, message: 'HTTP 500' };
  const prevUp = {
    state: 'up' as const,
    checkedAt: '2026-01-01T00:00:00.000Z',
    message: null,
    changedAt: '2025-12-31T00:00:00.000Z',
  };

  it('writes first sight, state changes and heartbeats only', () => {
    expect(decideWrite(undefined, up, 0, t0).write).toBe(true);
    expect(decideWrite(prevUp, up, 0, t0 + 60_000).write).toBe(false);
    expect(decideWrite(prevUp, up, 0, t0 + 31 * 60_000).write).toBe(true);
    // A single failure does not flap an up service.
    expect(decideWrite(prevUp, down, 1, t0 + 60_000)).toMatchObject({ write: false, state: 'up' });
    const d = decideWrite(prevUp, down, 2, t0 + 120_000);
    expect(d).toMatchObject({ write: true, state: 'down' });
    expect(d.changedAt).toBe('2026-01-01T00:02:00.000Z');
    // Message change while still down is written but keeps changedAt.
    const prevDown = {
      ...prevUp,
      state: 'down' as const,
      message: 'HTTP 500',
      changedAt: d.changedAt,
    };
    expect(decideWrite(prevDown, { ...down, message: 'ETIMEDOUT' }, 5, t0 + 180_000)).toMatchObject(
      {
        write: true,
        changedAt: d.changedAt,
      },
    );
    expect(decideWrite(prevDown, down, 5, t0 + 180_000).write).toBe(false);
  });

  it('buckets latency', () => {
    expect([latencyBucket(3), latencyBucket(60), latencyBucket(9999)]).toEqual([50, 100, 10_000]);
  });
});

describe('services feature', () => {
  async function setup(httpGet: HttpGet, clock = { t: Date.parse('2026-03-01T12:00:00Z') }) {
    const made = await createTestApp({
      signedIn: true,
      features: [
        { name: 'sync', register: syncRegister },
        {
          name: 'services',
          register: createServicesFeature({
            httpGet,
            now: () => clock.t,
            jitterMs: 0,
            autoStart: false,
          }),
        },
      ],
    });
    return { ...made, clock };
  }
  const addBookmark = (
    ctx: Awaited<ReturnType<typeof setup>>['ctx'],
    over: Record<string, unknown> = {},
  ) => {
    const id = newId();
    ctx.records.writeAsServer('bookmarks', [
      {
        id,
        fields: {
          url: 'https://svc.lan/',
          title: 'Svc',
          sortKey: 'a0',
          isService: true,
          serviceCheck: baseCheck,
          ...over,
        } as never,
      },
    ]);
    return id;
  };
  const post = (app: Awaited<ReturnType<typeof setup>>['app'], path: string, body?: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });

  it('writes statuses only on change and cleans up removed services', async () => {
    let status = 200;
    const { app, ctx, clock } = await setup(async (o) => ok(o.url, status));
    const id = addBookmark(ctx);
    addBookmark(ctx, { isService: false, serviceCheck: null }); // not a service

    const first = await (await post(app, '/api/services/check-now')).json();
    expect(first).toEqual({ checked: 1 });
    let rec = ctx.records.get('serviceStatuses', id)!;
    expect(rec).toMatchObject({ bookmarkId: id, state: 'up', message: null });
    const seq1 = ctx.records.maxSeq();

    clock.t += 60_000;
    await post(app, '/api/services/check-now');
    expect(ctx.records.maxSeq()).toBe(seq1); // nothing changed, no sync traffic

    status = 503;
    clock.t += 60_000;
    await post(app, '/api/services/check-now');
    expect(ctx.records.get('serviceStatuses', id)!.state).toBe('up'); // one blip tolerated
    clock.t += 60_000;
    await post(app, '/api/services/check-now');
    rec = ctx.records.get('serviceStatuses', id)!;
    expect(rec).toMatchObject({ state: 'down', message: 'HTTP 503' });
    expect(rec.changedAt).toBe('2026-03-01T12:03:00.000Z');

    ctx.records.writeAsServer('bookmarks', [{ id, fields: { deleted: true } }]);
    await post(app, '/api/services/check-now');
    expect(ctx.records.list('serviceStatuses')).toHaveLength(0);
  });

  it('check-links reports ok, dead and redirected bookmarks', async () => {
    const { app, ctx } = await setup(async (o) => {
      if (o.url.includes('dead')) return ok(o.url, 404);
      if (o.url.includes('boom')) throw Object.assign(new Error('x'), { code: 'ENOTFOUND' });
      if (o.url.includes('moved')) return { ...ok('https://elsewhere.test/', 200), redirects: 1 };
      return ok(o.url, 200);
    });
    const a = addBookmark(ctx, { url: 'https://fine.test/', isService: false, serviceCheck: null });
    const b = addBookmark(ctx, { url: 'https://dead.test/', isService: false, serviceCheck: null });
    const c = addBookmark(ctx, { url: 'https://boom.test/', isService: false, serviceCheck: null });
    const d = addBookmark(ctx, {
      url: 'https://moved.test/',
      isService: false,
      serviceCheck: null,
    });
    const body = (await (await post(app, '/api/services/check-links')).json()) as {
      results: Array<{
        id: string;
        state: string;
        message: string | null;
        finalUrl: string | null;
      }>;
    };
    const by = Object.fromEntries(body.results.map((r) => [r.id, r]));
    expect(by[a]!.state).toBe('ok');
    expect(by[b]).toMatchObject({ state: 'dead', message: 'HTTP 404' });
    expect(by[c]).toMatchObject({ state: 'dead', message: 'ENOTFOUND' });
    expect(by[d]).toMatchObject({ state: 'redirected', finalUrl: 'https://elsewhere.test/' });

    const only = (await (await post(app, '/api/services/check-links', { ids: [a] })).json()) as {
      results: unknown[];
    };
    expect(only.results).toHaveLength(1);
  });

  it('check-links refuses oversized bodies', async () => {
    const { app } = await setup(async (o) => ok(o.url, 200));
    const res = await post(app, '/api/services/check-links', { pad: 'x'.repeat(300 * 1024) });
    expect(res.status).toBe(413);
  });

  it('requires auth', async () => {
    const { app } = await createTestApp({
      features: [
        { name: 'sync', register: syncRegister },
        { name: 'services', register: createServicesFeature({ autoStart: false }) },
      ],
    });
    expect((await post(app, '/api/services/check-now')).status).toBe(401);
  });
});
