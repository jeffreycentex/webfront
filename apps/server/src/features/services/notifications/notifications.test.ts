import { API, CSRF_HEADER, SESSION_COOKIE, newId } from '@webfront/shared';
import { describe, expect, it } from 'vitest';
import { allowAllGuard, createTestConfig } from '../../../../test/helpers.js';
import { createApp } from '../../../app.js';
import { createContext, type AppContext } from '../../../context.js';
import { openDatabase, type Db } from '../../../db/database.js';
import { runMigrations } from '../../../db/migrate.js';
import { createLogger } from '../../../logger.js';
import { createAuthFeature } from '../../auth/index.js';
import type { HttpGet, HttpResult } from '../../favicons/httpClient.js';
import { register as syncRegister } from '../../sync/index.js';
import { createServicesFeature } from '../index.js';
import { formatDuration, linkUrl, targetHost } from './alerts.js';
import type { Notifier, NotifierEnv } from './notifier.js';
import { deliver, encodeMessage, type PushoverHttpResponse } from './pushover.js';

/* -------------------------------------------------------------------------------------------
 * Harness: injected clock, injected HTTP probe, injected Pushover transport, captured logs.
 * No network, no ports.
 * ----------------------------------------------------------------------------------------- */

const TOKEN = 'AppToken0123456789abcdefghijKL';
const USER = 'UserKey9876543210zyxwvutsrqPQR';
const TOKEN2 = 'ZZToken0123456789abcdefghijkWX';
const MIN = 60_000;
const ALLOWED_FIELDS = new Set([
  'token',
  'user',
  'title',
  'message',
  'priority',
  'url',
  'url_title',
  'sound',
  'device',
  'timestamp',
]);

const ok200: PushoverHttpResponse = { status: 200, body: '{"status":1,"request":"r-1"}' };

interface HarnessOptions {
  db?: Db;
  env?: NotifierEnv;
  clock?: { t: number };
  logs?: string[];
}

async function harness(o: HarnessOptions = {}) {
  const clock = o.clock ?? { t: Date.parse('2026-03-01T12:00:00Z') };
  const logs = o.logs ?? [];
  const db = o.db ?? openDatabase(':memory:');
  if (!o.db) runMigrations(db);
  const logger = createLogger({ level: 'debug', write: (line) => logs.push(line) });
  const ctx = createContext({ config: createTestConfig(), db, logger });
  ctx.installAuthGuard(allowAllGuard);

  /** Probe answer per URL: an HTTP status, or 'refused'. */
  const probe = new Map<string, number | 'refused'>();
  const httpGet: HttpGet = async (req) => {
    const s = probe.get(req.url) ?? 200;
    if (s === 'refused') throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' });
    const r: HttpResult = {
      status: s,
      url: req.url,
      headers: {},
      body: Buffer.alloc(0),
      truncated: false,
      redirects: 0,
    };
    return r;
  };

  const sent: URLSearchParams[] = [];
  const responses: Array<PushoverHttpResponse | Error> = [];
  const sleeps: number[] = [];
  let gate: Promise<void> | null = null;
  const pushoverSend = async (body: string) => {
    sent.push(new URLSearchParams(body));
    if (gate) await gate;
    const next = responses.shift() ?? ok200;
    if (next instanceof Error) throw next;
    return next;
  };

  let notifier!: Notifier;
  const app = await createApp(ctx, {
    serveWeb: false,
    features: [
      { name: 'sync', register: syncRegister },
      {
        name: 'services',
        register: createServicesFeature({
          httpGet,
          now: () => clock.t,
          jitterMs: 0,
          autoStart: false,
          pushoverSend,
          sleep: async (ms) => {
            sleeps.push(ms);
          },
          env: o.env ?? {},
          onNotifier: (n) => (notifier = n),
        }),
      },
    ],
  });

  const bodies: string[] = [];
  const request = async (method: string, path: string, body?: unknown) => {
    const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
    if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
    const res = await app.request(path, init);
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
  };

  const addService = (
    title: string,
    url: string,
    over: Record<string, unknown> = {},
  ): { id: string; url: string } => {
    const id = newId();
    ctx.records.writeAsServer('bookmarks', [
      {
        id,
        fields: {
          url,
          title,
          sortKey: 'a0',
          isService: true,
          serviceCheck: {
            type: 'http',
            url: null,
            method: 'GET',
            expectedStatus: null,
            allowInsecureTls: true,
            timeoutMs: 1000,
          },
          ...over,
        } as never,
      },
    ]);
    return { id, url };
  };

  /** Advance the clock one interval and run a sweep; wait for deliveries. */
  const sweep = async (advanceMs = MIN) => {
    clock.t += advanceMs;
    const r = await app.request(`${API.services}/check-now`, { method: 'POST' });
    expect(r.status).toBe(200);
    await notifier.idle();
  };

  const configure = (over: Record<string, unknown> = {}, options: Record<string, unknown> = {}) =>
    request('PUT', API.notifications, {
      enabled: true,
      token: TOKEN,
      userKey: USER,
      options: { ...options },
      ...over,
    });

  return {
    app,
    ctx,
    db,
    clock,
    logs,
    probe,
    sent,
    responses,
    sleeps,
    bodies,
    request,
    addService,
    sweep,
    configure,
    notifier: () => notifier,
    setGate: (g: Promise<void> | null) => (gate = g),
  };
}

const down = (h: Awaited<ReturnType<typeof harness>>, url: string) => h.probe.set(url, 503);
const up = (h: Awaited<ReturnType<typeof harness>>, url: string) => h.probe.set(url, 200);

/** Bring a fresh service to a seen-up baseline. */
async function baseline(h: Awaited<ReturnType<typeof harness>>) {
  await h.sweep();
  await h.sweep();
}

/* -------------------------------------------------------------------------------------------
 * Alert rules
 * ----------------------------------------------------------------------------------------- */

describe('service outage alerts', () => {
  it('alerts exactly once per confirmed transition, with the recovery duration', async () => {
    const h = await harness();
    await h.configure();
    const s = h.addService('NAS', 'https://admin:pw@nas.lan:8443/ui?key=secret#x');
    await baseline(h);
    expect(h.sent).toHaveLength(0);

    down(h, s.url);
    await h.sweep(); // first failure: tolerated by the checker
    expect(h.sent).toHaveLength(0);
    await h.sweep(); // confirmed down
    expect(h.sent).toHaveLength(1);
    const m = h.sent[0]!;
    expect(m.get('title')).toBe('Down: NAS');
    expect(m.get('message')).toBe('NAS (nas.lan:8443) is down: HTTP 503');
    expect(m.get('priority')).toBe('0');
    expect(m.get('url')).toBe('https://nas.lan:8443/ui');
    expect(m.get('url_title')).toBe('Open NAS');
    expect(m.get('token')).toBe(TOKEN);
    expect(m.get('user')).toBe(USER);
    expect(m.toString()).not.toContain('secret');
    expect(m.toString()).not.toContain('admin');

    for (let i = 0; i < 5; i++) await h.sweep();
    expect(h.sent).toHaveLength(1); // still down: nothing more (no reminders by default)

    up(h, s.url);
    await h.sweep();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]!.get('title')).toBe('Up: NAS');
    expect(h.sent[1]!.get('message')).toBe('NAS (nas.lan:8443) is back up after 6 min down');
    await h.sweep();
    await h.sweep();
    expect(h.sent).toHaveLength(2);
  });

  it('flapping: each confirmed transition alerts once; single blips do not', async () => {
    const h = await harness();
    await h.configure();
    const s = h.addService('Plex', 'https://plex.lan/');
    await baseline(h);
    const pattern = [503, 200, 503, 200, 503, 503, 200, 503, 503, 503, 200];
    for (const status of pattern) {
      h.probe.set(s.url, status);
      await h.sweep();
    }
    expect(h.sent.map((m) => m.get('title'))).toEqual([
      'Down: Plex',
      'Up: Plex',
      'Down: Plex',
      'Up: Plex',
    ]);
  });

  it('does not alert after a restart for services already down, and resumes correctly', async () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    const clock = { t: Date.parse('2026-03-01T12:00:00Z') };
    const h1 = await harness({ db, clock });
    await h1.configure();
    const alerted = h1.addService('Alerted', 'https://a.lan/');
    await baseline(h1);
    down(h1, alerted.url);
    await h1.sweep();
    await h1.sweep();
    expect(h1.sent).toHaveLength(1);
    await h1.ctx.close();

    // "Restart": a new server on the same database; the checker's failure counts are gone.
    const h2 = await harness({ db, clock });
    down(h2, alerted.url);
    for (let i = 0; i < 4; i++) await h2.sweep();
    expect(h2.sent).toHaveLength(0);
    up(h2, alerted.url);
    await h2.sweep();
    expect(h2.sent.map((m) => m.get('title'))).toEqual(['Up: Alerted']);
    expect(h2.sent[0]!.get('message')).toContain('after 5 min');
  });

  it('never alerts on the first sighting of a down service (upgrade, newly flagged)', async () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    const clock = { t: Date.parse('2026-03-01T12:00:00Z') };
    const h1 = await harness({ db, clock });
    await h1.configure();
    const s = h1.addService('Broken', 'https://broken.lan/');
    down(h1, s.url);
    for (let i = 0; i < 5; i++) await h1.sweep();
    expect(h1.sent).toHaveLength(0);
    await h1.ctx.close();

    const h2 = await harness({ db, clock });
    down(h2, s.url);
    for (let i = 0; i < 3; i++) await h2.sweep();
    up(h2, s.url);
    await h2.sweep();
    expect(h2.sent).toHaveLength(0); // never reported down, so no recovery either
    down(h2, s.url);
    await h2.sweep();
    await h2.sweep();
    expect(h2.sent.map((m) => m.get('title'))).toEqual(['Down: Broken']);
  });

  it('waits for the minimum down time, and stays silent for shorter outages', async () => {
    const h = await harness();
    await h.configure({}, { minDownMinutes: 5 });
    const s = h.addService('Wiki', 'https://wiki.lan/');
    await baseline(h);

    // Short outage: confirmed down, back after 2 minutes. Nothing at all.
    down(h, s.url);
    await h.sweep();
    await h.sweep();
    await h.sweep();
    up(h, s.url);
    await h.sweep();
    expect(h.sent).toHaveLength(0);

    // Long outage.
    down(h, s.url);
    await h.sweep();
    await h.sweep(); // confirmed at T
    for (let i = 1; i <= 4; i++) await h.sweep(); // T+1..T+4
    expect(h.sent).toHaveLength(0);
    await h.sweep(); // T+5
    expect(h.sent.map((m) => m.get('title'))).toEqual(['Down: Wiki']);
    up(h, s.url);
    await h.sweep();
    expect(h.sent.map((m) => m.get('title'))).toEqual(['Down: Wiki', 'Up: Wiki']);
  });

  it('sends repeat reminders while still down', async () => {
    const h = await harness();
    await h.configure({}, { repeatMinutes: 30, downPriority: 'high' });
    const s = h.addService('Router', 'https://router.lan/');
    await baseline(h);
    down(h, s.url);
    await h.sweep();
    await h.sweep();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.get('priority')).toBe('1');
    await h.sweep(10 * MIN);
    await h.sweep(10 * MIN);
    expect(h.sent).toHaveLength(1);
    await h.sweep(10 * MIN); // 30 min after the alert
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]!.get('title')).toBe('Still down: Router');
    expect(h.sent[1]!.get('message')).toBe('Router (router.lan) still down after 30 min: HTTP 503');
    expect(h.sent[1]!.get('priority')).toBe('1');
    await h.sweep(30 * MIN);
    expect(h.sent).toHaveLength(3);
    expect(h.sent[2]!.get('message')).toContain('still down after 1 h');
  });

  it('combines several services in one message per sweep, for down and recovery', async () => {
    const h = await harness();
    await h.configure({}, { recoveryPriority: 'low', sound: 'siren', device: 'phone' });
    const a = h.addService('Alpha', 'https://alpha.lan/');
    const b = h.addService('Beta', 'https://beta.lan/');
    const c = h.addService('Gamma', 'https://gamma.lan/');
    await baseline(h);
    for (const s of [a, b, c]) h.probe.set(s.url, 'refused');
    await h.sweep();
    await h.sweep();
    expect(h.sent).toHaveLength(1);
    const m = h.sent[0]!;
    expect(m.get('title')).toBe('3 services down');
    expect(m.get('message')!.split('\n')).toEqual([
      '• Alpha (alpha.lan) is down: ECONNREFUSED',
      '• Beta (beta.lan) is down: ECONNREFUSED',
      '• Gamma (gamma.lan) is down: ECONNREFUSED',
    ]);
    expect(m.has('url')).toBe(false);
    expect(m.get('sound')).toBe('siren');
    expect(m.get('device')).toBe('phone');

    for (const s of [a, b, c]) up(h, s.url);
    await h.sweep();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]!.get('title')).toBe('3 services back up');
    expect(h.sent[1]!.get('priority')).toBe('-1');
    expect(h.sent[1]!.get('message')).toContain('• Beta (beta.lan) back up after 1 min');
  });

  it('stays silent for deleted and un-flagged services', async () => {
    const h = await harness();
    await h.configure();
    const a = h.addService('Gone', 'https://gone.lan/');
    const b = h.addService('Unflagged', 'https://unflagged.lan/');
    await baseline(h);
    down(h, a.url);
    down(h, b.url);
    await h.sweep();
    await h.sweep();
    expect(h.sent).toHaveLength(1);

    h.ctx.records.writeAsServer('bookmarks', [{ id: a.id, fields: { deleted: true } }]);
    h.ctx.records.writeAsServer('bookmarks', [
      { id: b.id, fields: { isService: false, serviceCheck: null } },
    ]);
    await h.sweep();
    await h.sweep();
    expect(h.sent).toHaveLength(1);
    expect(h.db.all('SELECT * FROM service_alert_state')).toHaveLength(0);

    // Re-flagged while down: a fresh first sighting, still silent.
    h.ctx.records.writeAsServer('bookmarks', [
      {
        id: b.id,
        fields: {
          isService: true,
          serviceCheck: {
            type: 'http',
            url: null,
            method: 'GET',
            expectedStatus: null,
            allowInsecureTls: true,
            timeoutMs: 1000,
          },
        },
      },
    ]);
    await h.sweep();
    await h.sweep();
    expect(h.sent).toHaveLength(1);
  });

  it('sends nothing while disabled, and does not report outages that began while disabled', async () => {
    const h = await harness();
    await h.configure({ enabled: false });
    const s = h.addService('Svc', 'https://svc.lan/');
    await baseline(h);
    down(h, s.url);
    await h.sweep();
    await h.sweep();
    await h.sweep();
    expect(h.sent).toHaveLength(0);
    await h.configure({ enabled: true });
    await h.sweep();
    up(h, s.url);
    await h.sweep();
    expect(h.sent).toHaveLength(0);
    // The next outage is reported normally.
    down(h, s.url);
    await h.sweep();
    await h.sweep();
    expect(h.sent.map((m) => m.get('title'))).toEqual(['Down: Svc']);
  });

  it('honours notify-on-down and notify-on-recovery', async () => {
    const h = await harness();
    await h.configure({}, { notifyRecovery: false });
    const s = h.addService('Svc', 'https://svc.lan/');
    await baseline(h);
    down(h, s.url);
    await h.sweep();
    await h.sweep();
    up(h, s.url);
    await h.sweep();
    expect(h.sent.map((m) => m.get('title'))).toEqual(['Down: Svc']);

    await h.configure({}, { notifyDown: false, notifyRecovery: true });
    down(h, s.url);
    await h.sweep();
    await h.sweep();
    up(h, s.url);
    await h.sweep();
    expect(h.sent.map((m) => m.get('title'))).toEqual(['Down: Svc', 'Up: Svc']);
  });

  it('does not block the sweep while delivering', async () => {
    const h = await harness();
    await h.configure();
    const s = h.addService('Svc', 'https://svc.lan/');
    await baseline(h);
    down(h, s.url);
    let release!: () => void;
    h.setGate(new Promise<void>((r) => (release = r)));
    h.clock.t += MIN;
    await h.app.request(`${API.services}/check-now`, { method: 'POST' });
    h.clock.t += MIN;
    const res = await h.app.request(`${API.services}/check-now`, { method: 'POST' });
    expect(res.status).toBe(200); // returned while the Pushover request is still open
    expect(h.sent).toHaveLength(1);
    release();
    await h.notifier().idle();
    expect((await h.request('GET', API.notifications)).body.delivery.lastSuccessAt).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------------------------
 * Delivery
 * ----------------------------------------------------------------------------------------- */

describe('delivery', () => {
  async function outage(h: Awaited<ReturnType<typeof harness>>) {
    const s = h.addService(`Svc ${h.sent.length}`, `https://svc${newId().slice(-6)}.lan/`);
    await baseline(h);
    down(h, s.url);
    await h.sweep();
    await h.sweep();
    return s;
  }

  it('retries 5xx and network failures with backoff, then succeeds', async () => {
    const h = await harness();
    await h.configure();
    h.responses.push({ status: 500, body: 'oops' }, new Error('boom'), ok200);
    await outage(h);
    expect(h.sent).toHaveLength(3);
    expect(h.sleeps).toEqual([15_000, 60_000]);
    const v = (await h.request('GET', API.notifications)).body;
    expect(v.delivery.lastSuccessAt).not.toBeNull();
    expect(v.delivery.paused).toBe(false);
  });

  it('gives up after a few temporary failures', async () => {
    const h = await harness();
    await h.configure();
    for (let i = 0; i < 6; i++) h.responses.push({ status: 503, body: '' });
    await outage(h);
    expect(h.sent).toHaveLength(4);
    expect(h.sleeps).toEqual([15_000, 60_000, 300_000]);
    const v = (await h.request('GET', API.notifications)).body;
    expect(v.delivery.lastError).toBe('Pushover: HTTP 503');
    expect(v.delivery.paused).toBe(false);
  });

  it('stops on 4xx, records Pushover’s message, and pauses alerts until saved again', async () => {
    const h = await harness();
    await h.configure();
    h.responses.push({
      status: 400,
      body: JSON.stringify({
        user: 'invalid',
        errors: ['user identifier is not a valid user, group, or subscribed user key'],
        status: 0,
        request: 'r-2',
      }),
    });
    const s = await outage(h);
    expect(h.sent).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
    let v = (await h.request('GET', API.notifications)).body;
    expect(v.delivery.lastError).toBe(
      'Pushover: user identifier is not a valid user, group, or subscribed user key',
    );
    expect(v.delivery.paused).toBe(true);

    up(h, s.url);
    await h.sweep(); // paused: recovery is not attempted
    expect(h.sent).toHaveLength(1);

    v = (await h.configure({ token: undefined, userKey: USER })).body;
    expect(v.delivery.paused).toBe(false);
    await outage(h);
    expect(h.sent).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------------------------
 * Endpoints, validation and secrets
 * ----------------------------------------------------------------------------------------- */

describe('notification settings endpoints', () => {
  it('saves, masks, keeps secrets when omitted, and clears them', async () => {
    const h = await harness();
    let r = await h.request('GET', API.notifications);
    expect(r.body).toMatchObject({
      enabled: false,
      configured: false,
      token: { configured: false, hint: null, source: null },
      options: {
        notifyDown: true,
        notifyRecovery: true,
        minDownMinutes: 0,
        repeatMinutes: 0,
        downPriority: 'normal',
        recoveryPriority: 'normal',
        device: null,
        sound: null,
      },
    });

    r = await h.configure();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      enabled: true,
      configured: true,
      token: { configured: true, hint: '…ijKL', source: 'saved' },
      userKey: { configured: true, hint: '…qPQR', source: 'saved' },
    });

    // Options only: the saved secrets stay.
    r = await h.request('PUT', API.notifications, {
      enabled: true,
      options: { minDownMinutes: 10, repeatMinutes: 60 },
    });
    expect(r.status).toBe(200);
    expect(r.body.configured).toBe(true);
    expect(r.body.options).toMatchObject({ minDownMinutes: 10, repeatMinutes: 60 });
    expect(h.db.get('SELECT app_token, user_key FROM notification_config')).toEqual({
      app_token: TOKEN,
      user_key: USER,
    });

    // Replace one secret.
    r = await h.request('PUT', API.notifications, {
      enabled: true,
      token: TOKEN2,
      options: {},
    });
    expect(r.body.token.hint).toBe('…jkWX');

    r = await h.request('DELETE', API.notificationsCredentials);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ configured: false, token: { configured: false } });
    expect(h.db.get('SELECT app_token, user_key FROM notification_config')).toEqual({
      app_token: null,
      user_key: null,
    });
    r = await h.request('POST', API.notificationsTest);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('not_configured');
  });

  it('validates shapes and options, and never echoes rejected values', async () => {
    const h = await harness();
    const bad = [
      { enabled: true, token: TOKEN.slice(1), options: {} },
      { enabled: true, token: `${TOKEN.slice(1)}!`, options: {} },
      { enabled: true, userKey: `${USER}x`, options: {} },
      { enabled: true, options: { downPriority: 'emergency' } },
      { enabled: true, options: { minDownMinutes: 3 } },
      { enabled: true, options: { repeatMinutes: 45 } },
      { enabled: true, options: { device: 'my phone' } },
      { enabled: true, options: { sound: 'airhorn' } },
      { enabled: true, options: { priority: 2 } },
      { enabled: true, options: {}, extra: 1 },
      { options: {} },
    ];
    for (const body of bad) {
      const r = await h.request('PUT', API.notifications, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error.code).toBe('validation_error');
    }
    const joined = h.bodies.join('\n');
    expect(joined).not.toContain(TOKEN.slice(1));
    expect(joined).not.toContain(USER);
    expect((await h.request('PUT', API.notifications, '{not json')).status).toBe(400);
    const big = await h.request('PUT', API.notifications, {
      enabled: true,
      options: {},
      pad: 'x'.repeat(8 * 1024),
    });
    expect(big.status).toBe(413);
    expect(h.db.get('SELECT enabled, app_token FROM notification_config')).toEqual({
      enabled: 0,
      app_token: null,
    });
  });

  it('uses env credentials over saved ones and ignores invalid env values', async () => {
    const logs: string[] = [];
    const h = await harness({
      env: { PUSHOVER_APP_TOKEN: TOKEN2, PUSHOVER_USER_KEY: 'not-a-valid-key' },
      logs,
    });
    let r = await h.request('GET', API.notifications);
    expect(r.body.token).toEqual({ configured: true, hint: '…jkWX', source: 'env' });
    expect(r.body.userKey.configured).toBe(false);
    expect(logs.join('\n')).toContain('PUSHOVER_USER_KEY');
    expect(logs.join('\n')).not.toContain('not-a-valid-key');

    r = await h.configure();
    expect(r.body.token.source).toBe('env');
    expect(r.body.userKey).toMatchObject({ configured: true, source: 'saved' });
    await h.request('POST', API.notificationsTest);
    expect(h.sent[0]!.get('token')).toBe(TOKEN2);
    expect(h.sent[0]!.get('user')).toBe(USER);
  });

  it('sends a test notification and reports Pushover’s error text', async () => {
    const h = await harness();
    await h.configure({ enabled: false }, { sound: 'bike', device: 'phone' });
    let r = await h.request('POST', API.notificationsTest);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, sentAt: '2026-03-01T12:00:00.000Z' });
    const m = h.sent[0]!;
    expect([...m.keys()].every((k) => ALLOWED_FIELDS.has(k))).toBe(true);
    expect(m.get('title')).toBe('Webfront test');
    expect(m.get('sound')).toBe('bike');
    expect(m.get('device')).toBe('phone');

    // Cooldown between tests.
    r = await h.request('POST', API.notificationsTest);
    expect(r.status).toBe(429);

    h.clock.t += 10_000;
    h.responses.push({
      status: 400,
      body: JSON.stringify({ errors: ['application token is invalid'], status: 0 }),
    });
    r = await h.request('POST', API.notificationsTest);
    expect(r.status).toBe(502);
    expect(r.body.error).toMatchObject({
      code: 'pushover_rejected',
      message: 'Pushover: application token is invalid',
    });

    h.clock.t += 10_000;
    h.responses.push(Object.assign(new Error('x'), { code: 'ENOTFOUND' }));
    r = await h.request('POST', API.notificationsTest);
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('pushover_unavailable');
    expect(h.sent).toHaveLength(3); // no retries for tests
  });

  it('never exposes the secrets in responses, logs or synced records', async () => {
    const logs: string[] = [];
    const h = await harness({ logs });
    await h.configure();
    const s = h.addService('Svc', 'https://svc.lan/');
    await baseline(h);
    // A hostile or buggy answer that echoes the credentials back.
    const echo = {
      status: 400,
      body: JSON.stringify({ errors: [`token ${TOKEN} / user ${USER} rejected`], status: 0 }),
    };
    h.responses.push(echo);
    await h.request('POST', API.notificationsTest);
    await h.configure({ token: undefined, userKey: undefined });
    h.responses.push({ status: 500, body: JSON.stringify({ errors: [`bad ${TOKEN}`] }) }, echo);
    down(h, s.url);
    await h.sweep();
    await h.sweep();
    await h.request('GET', API.notifications);
    await h.request('PUT', API.notifications, { enabled: true, options: {} });
    await h.request('DELETE', API.notificationsCredentials);

    const view = (await h.request('GET', API.notifications)).body;
    expect(view.delivery.lastError).toContain('[redacted]');
    const synced = JSON.stringify(h.ctx.records.pull(0, 10_000));
    for (const haystack of [h.bodies.join('\n'), logs.join('\n'), synced]) {
      expect(haystack).not.toContain(TOKEN);
      expect(haystack).not.toContain(USER);
    }
    expect(logs.length).toBeGreaterThan(0);
  });

  it('keeps bookmark-derived text from adding form fields or leaking URL secrets', async () => {
    const h = await harness();
    await h.configure();
    const s = h.addService(
      'Evil&token=xxx&user=yyy&priority=2\nretry=30',
      'https://bob:hunter2@evil.lan/path?api_key=k#frag',
    );
    const j = h.addService('JS', 'javascript:alert(1)', {
      serviceCheck: { type: 'tcp', host: 'db.lan', port: 5432, timeoutMs: 1000 },
    });
    void j;
    await baseline(h);
    down(h, s.url);
    await h.sweep();
    await h.sweep();
    const m = h.sent[0]!;
    expect([...m.keys()].every((k) => ALLOWED_FIELDS.has(k))).toBe(true);
    expect(m.getAll('token')).toEqual([TOKEN]);
    expect(m.getAll('user')).toEqual([USER]);
    expect(m.getAll('priority')).toEqual(['0']);
    expect(m.get('title')).toBe('Down: Evil&token=xxx&user=yyy&priority=2 retry=30');
    expect(m.get('url')).toBe('https://evil.lan/path');
    expect(m.toString()).not.toContain('hunter2');
    expect(m.toString()).not.toContain('api_key');

    expect(linkUrl('javascript:alert(1)')).toBeNull();
    expect(linkUrl('ftp://x/')).toBeNull();
    expect(
      targetHost({
        id: 'x',
        title: '',
        url: 'https://u:p@h.lan/',
        serviceCheck: { type: 'tcp', host: 'fe80::1', port: 22, timeoutMs: 1000 },
      }),
    ).toBe('[fe80::1]:22');
  });
});

describe('pushover helpers', () => {
  it('encodes only the expected fields and classifies responses', async () => {
    const body = encodeMessage(
      { token: TOKEN, user: USER },
      { title: 'a\u0000b', message: 'x'.repeat(2000), priority: 1, url: 'https://h/' },
    );
    const p = new URLSearchParams(body);
    expect(p.get('title')).toBe('a b');
    expect(Array.from(p.get('message')!)).toHaveLength(1024);
    expect(
      await deliver(
        async () => ok200,
        { token: TOKEN, user: USER },
        { title: 't', message: 'm', priority: 0 },
      ),
    ).toEqual({ kind: 'ok' });
    expect(
      await deliver(
        async () => ({ status: 429, body: '' }),
        { token: TOKEN, user: USER },
        { title: 't', message: 'm', priority: 0 },
      ),
    ).toMatchObject({ kind: 'rejected', status: 429, error: 'Pushover: Message limit reached' });
    expect(formatDuration(30_000)).toBe('under a minute');
    expect(formatDuration(65 * MIN)).toBe('1 h 5 min');
    expect(formatDuration(50 * 60 * MIN)).toBe('2 d 2 h');
  });
});

/* -------------------------------------------------------------------------------------------
 * Auth, CSRF and cross-site refusal (real auth feature)
 * ----------------------------------------------------------------------------------------- */

describe('auth and CSRF on every notification endpoint', () => {
  const ORIGIN = 'https://webfront.example.ts.net';

  async function authed() {
    const sent: string[] = [];
    const db = openDatabase(':memory:');
    runMigrations(db);
    const ctx: AppContext = createContext({
      config: createTestConfig({ publicOrigin: ORIGIN, rpId: 'webfront.example.ts.net' }),
      db,
      logger: createLogger({ level: 'error', write: () => {} }),
    });
    const app = await createApp(ctx, {
      serveWeb: false,
      features: [
        {
          name: 'auth',
          register: createAuthFeature({
            hashParams: { memoryCost: 1024, timeCost: 1, parallelism: 1 },
          }).register,
        },
        { name: 'sync', register: syncRegister },
        {
          name: 'services',
          register: createServicesFeature({
            autoStart: false,
            env: {},
            pushoverSend: async (b) => {
              sent.push(b);
              return ok200;
            },
          }),
        },
      ],
    });
    const setup = await app.request(API.auth.setup, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ username: 'jeff', password: 'correct horse battery' }),
    });
    const cookie = setup.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`))!
      .split(';')[0]!;
    const { csrfToken } = (await setup.json()) as { csrfToken: string };
    return { app, cookie, csrfToken, sent };
  }

  const endpoints: Array<[string, string, unknown?]> = [
    ['GET', API.notifications],
    ['PUT', API.notifications, { enabled: true, token: TOKEN, userKey: USER, options: {} }],
    ['DELETE', API.notificationsCredentials],
    ['POST', API.notificationsTest],
  ];

  it('rejects signed-out, CSRF-less and cross-site requests; accepts proper ones', async () => {
    const { app, cookie, csrfToken, sent } = await authed();
    const call = (method: string, path: string, body: unknown, headers: Record<string, string>) =>
      app.request(path, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });

    for (const [method, path, body] of endpoints) {
      const mutating = method !== 'GET';
      // Signed out.
      let r = await call(method, path, body, mutating ? { origin: ORIGIN } : {});
      expect(r.status, `${method} ${path} signed out`).toBe(401);
      // Cross-site (any method).
      r = await call(method, path, body, {
        cookie,
        [CSRF_HEADER]: csrfToken,
        'sec-fetch-site': 'cross-site',
      });
      expect(r.status, `${method} ${path} cross-site`).toBe(403);
      r = await call(method, path, body, {
        cookie,
        [CSRF_HEADER]: csrfToken,
        'sec-fetch-site': 'same-site',
      });
      expect(r.status, `${method} ${path} same-site`).toBe(403);
      if (mutating) {
        // Missing CSRF token, wrong token, foreign Origin.
        r = await call(method, path, body, { cookie, origin: ORIGIN });
        expect(r.status, `${method} ${path} no csrf`).toBe(403);
        r = await call(method, path, body, { cookie, origin: ORIGIN, [CSRF_HEADER]: 'nope' });
        expect(r.status).toBe(403);
        r = await call(method, path, body, {
          cookie,
          origin: 'https://evil.example.ts.net',
          [CSRF_HEADER]: csrfToken,
        });
        expect(r.status).toBe(403);
      }
    }
    expect(sent).toHaveLength(0);

    // Proper requests work.
    for (const [method, path, body] of endpoints) {
      if (path === API.notificationsCredentials) continue;
      const r = await call(method, path, body, {
        cookie,
        origin: ORIGIN,
        'sec-fetch-site': 'same-origin',
        ...(method !== 'GET' ? { [CSRF_HEADER]: csrfToken } : {}),
      });
      expect(r.status, `${method} ${path}`).toBe(200);
    }
    expect(sent).toHaveLength(1);
    const r = await call('DELETE', API.notificationsCredentials, undefined, {
      cookie,
      origin: ORIGIN,
      [CSRF_HEADER]: csrfToken,
    });
    expect(r.status).toBe(200);
  });
});
