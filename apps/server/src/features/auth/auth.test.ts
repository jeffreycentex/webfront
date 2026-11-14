import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { API, CSRF_HEADER, SESSION_COOKIE } from '@webfront/shared';
import { describe, expect, it } from 'vitest';
import { createTestApp, createTestContext } from '../../../test/helpers.js';
import { createApp } from '../../app.js';
import { loadConfig } from '../../config.js';
import { createAuthFeature, type AuthFeatureOptions } from './index.js';
import { Backoff } from './rateLimit.js';
import { clientIp, deviceLabel } from './request.js';
import { sha256 } from './store.js';

/* -------------------------------------------------------------------------------------------
 * Harness
 * ----------------------------------------------------------------------------------------- */

const ORIGIN = 'https://webfront.example.ts.net';
const FAST_HASH = { memoryCost: 1024, timeCost: 1, parallelism: 1 };
const PASSWORD = 'correct horse battery';
const UA_FIREFOX_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0';

class Clock {
  t = Date.parse('2026-11-14T12:00:00.000Z');
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

const DAY = 24 * 60 * 60_000;

async function makeApp(
  options: AuthFeatureOptions & { trustProxy?: boolean; isProduction?: boolean } = {},
) {
  const clock = new Clock();
  const feature = createAuthFeature({ now: clock.now, hashParams: FAST_HASH, ...options });
  const { app, ctx } = await createTestApp({
    config: {
      publicOrigin: ORIGIN,
      rpId: 'webfront.example.ts.net',
      trustProxy: options.trustProxy ?? true,
      isProduction: options.isProduction ?? false,
    },
    features: [
      { name: 'auth', register: feature.register },
      {
        name: 'dummy',
        register: (a, c) => {
          a.get('/api/dummy', c.requireAuth, (h) => h.json(h.get('session')));
          a.post('/api/dummy', c.requireAuth, (h) => h.json({ ok: true }));
        },
      },
    ],
  });
  const revoked: string[] = [];
  ctx.events.on('session.revoked', (e) => revoked.push(e.sessionId));
  return { app, ctx, clock, revoked };
}

type TestApp = Awaited<ReturnType<typeof makeApp>>['app'];

/** Minimal cookie-jar client: keeps the session cookie and CSRF token like the web app does. */
class Client {
  cookie: string | null = null;
  csrf: string | null = null;
  lastSetCookie: string | null = null;

  constructor(
    private readonly app: TestApp,
    private readonly ip = '100.64.0.1',
    private readonly headers: Record<string, string> = {},
  ) {}

  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = {
      'x-forwarded-for': this.ip,
      'user-agent': UA_FIREFOX_WIN,
      ...this.headers,
    };
    if (method !== 'GET' && this.csrf) h[CSRF_HEADER] = this.csrf;
    if (this.cookie) h.cookie = `${SESSION_COOKIE}=${this.cookie}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    Object.assign(h, headers);
    const init: RequestInit = { method, headers: h };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await this.app.request(path, init);
    this.lastSetCookie = null;
    for (const c of res.headers.getSetCookie()) {
      if (!c.startsWith(`${SESSION_COOKIE}=`)) continue;
      this.lastSetCookie = c;
      const value = c.slice(SESSION_COOKIE.length + 1).split(';')[0] ?? '';
      this.cookie = value && !/Max-Age=0/i.test(c) ? value : null;
      if (!this.cookie) this.csrf = null;
    }
    return res;
  }

  async json<T = any>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) {
    const res = await this.req(method, path, body, headers);
    return { res, status: res.status, body: (await res.json()) as T };
  }

  async signIn(path: string, body: unknown) {
    const r = await this.json('POST', path, body);
    if (r.status === 200) this.csrf = r.body.csrfToken;
    return r;
  }

  setup(username = 'jeff', password = PASSWORD) {
    return this.signIn(API.auth.setup, { username, password });
  }

  login(username = 'jeff', password = PASSWORD) {
    return this.signIn(API.auth.login, { username, password });
  }
}

/* -------------------------------------------------------------------------------------------
 * Setup
 * ----------------------------------------------------------------------------------------- */

describe('first-run setup', () => {
  it('reports setup required, creates the account once, then closes', async () => {
    const { app } = await makeApp();
    const a = new Client(app);

    let s = await a.json('GET', API.auth.status);
    expect(s.body).toEqual({ setupRequired: true, session: null, passkeysAvailable: false });

    const created = await a.setup();
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      username: 'jeff',
      deviceName: 'Firefox on Windows',
      createdAt: '2026-11-14T12:00:00.000Z',
      expiresAt: '2027-02-12T12:00:00.000Z',
    });
    expect(created.body.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const cookie = a.lastSetCookie!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\/api/);
    expect(cookie).toMatch(/Max-Age=7776000/);

    s = await a.json('GET', API.auth.status);
    expect(s.body.setupRequired).toBe(false);
    expect(s.body.session).toMatchObject({ username: 'jeff', csrfToken: a.csrf });

    // Second setup, with or without a session, is refused.
    const again = await new Client(app, '100.64.0.2').json('POST', API.auth.setup, {
      username: 'mallory',
      password: 'another password',
    });
    expect(again.status).toBe(409);
    expect(
      (await a.json('POST', API.auth.setup, { username: 'x', password: PASSWORD })).status,
    ).toBe(409);
  });

  it('validates the request', async () => {
    const { app } = await makeApp();
    const a = new Client(app);
    expect(
      (await a.json('POST', API.auth.setup, { username: 'jeff', password: 'short' })).status,
    ).toBe(400);
    expect(
      (await a.json('POST', API.auth.setup, { username: 'bad name', password: PASSWORD })).status,
    ).toBe(400);
    expect((await a.json('GET', API.auth.status)).body.setupRequired).toBe(true);
  });

  it('allows only one account under concurrent setup', async () => {
    const { app, ctx } = await makeApp();
    const results = await Promise.all(
      ['a', 'b', 'c'].map((u, i) => new Client(app, `100.64.0.${i + 1}`).setup(u)),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM auth_account')?.n).toBe(1);
  });

  it('stores an Argon2id hash and only a hash of the session token', async () => {
    const { app, ctx } = await makeApp();
    const a = new Client(app);
    await a.setup();
    const acct = ctx.db.get<{ password_hash: string }>('SELECT password_hash FROM auth_account');
    expect(acct?.password_hash).toMatch(/^\$argon2id\$/);
    expect(acct?.password_hash).not.toContain(PASSWORD);
    const rows = ctx.db.all<{ token_hash: string }>('SELECT token_hash FROM auth_sessions');
    expect(rows).toEqual([{ token_hash: sha256(a.cookie!) }]);
  });
});

/* -------------------------------------------------------------------------------------------
 * Login
 * ----------------------------------------------------------------------------------------- */

describe('password login', () => {
  it('needs setup first', async () => {
    const { app } = await makeApp();
    const r = await new Client(app).login();
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('setup_required');
  });

  it('signs in with the right credentials (username case-insensitive)', async () => {
    const { app } = await makeApp();
    await new Client(app).setup('Jeff');
    const b = new Client(app, '100.64.0.2');
    const r = await b.signIn(API.auth.login, {
      username: ' jeff ',
      password: PASSWORD,
      deviceName: 'Work laptop',
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ username: 'Jeff', deviceName: 'Work laptop' });
    expect((await b.json('GET', API.auth.session)).body.sessionId).toBe(r.body.sessionId);
  });

  it('rejects a wrong password or username with the same error', async () => {
    const { app } = await makeApp();
    await new Client(app).setup();
    const b = new Client(app, '100.64.0.2');
    const wrongPw = await b.login('jeff', 'wrong password!');
    const wrongUser = await b.login('nobody', PASSWORD);
    expect(wrongPw.status).toBe(401);
    expect(wrongUser.status).toBe(401);
    expect(wrongPw.body.error.message).toBe(wrongUser.body.error.message);
    expect(b.cookie).toBeNull();
  });

  it('replaces the existing session on a new sign-in (no fixation)', async () => {
    const { app, revoked } = await makeApp();
    const a = new Client(app);
    const first = await a.setup();
    const oldCookie = a.cookie;
    const second = await a.login();
    expect(second.body.sessionId).not.toBe(first.body.sessionId);
    expect(a.cookie).not.toBe(oldCookie);
    expect(revoked).toContain(first.body.sessionId);
  });

  it('normalises passwords to NFC', async () => {
    const { app } = await makeApp();
    await new Client(app).setup('jeff', 'café au lait!!');
    const r = await new Client(app, '100.64.0.2').login('jeff', 'café au lait!!');
    expect(r.status).toBe(200);
  });

  it('re-hashes a password made with old parameters on login', async () => {
    const { app, ctx } = await makeApp();
    await new Client(app).setup();
    const before = ctx.db.get<{ password_hash: string }>('SELECT password_hash FROM auth_account')!;
    // A second app instance with stronger parameters over the same database.
    const feature = createAuthFeature({
      hashParams: { memoryCost: 2048, timeCost: 1, parallelism: 1 },
    });
    const ctx2 = createTestContext({ config: { publicOrigin: ORIGIN } });
    ctx2.db.run(
      'INSERT INTO auth_account (id, username, password_hash, webauthn_user_id, created_at, password_changed_at) VALUES (1, ?, ?, ?, ?, ?)',
      'jeff',
      before.password_hash,
      'aGFuZGxl',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );
    const app2 = await createApp(ctx2, {
      features: [{ name: 'auth', register: feature.register }],
      serveWeb: false,
    });
    expect((await new Client(app2).login()).status).toBe(200);
    const after = ctx2.db.get<{ password_hash: string }>('SELECT password_hash FROM auth_account')!;
    expect(after.password_hash).toMatch(/m=2048/);
    expect((await new Client(app2, '100.64.0.9').login()).status).toBe(200);
    await ctx2.close();
  });
});

/* -------------------------------------------------------------------------------------------
 * Rate limiting
 * ----------------------------------------------------------------------------------------- */

describe('login rate limiting', () => {
  it('backs off per IP after repeated failures, then recovers', async () => {
    const { app, clock } = await makeApp();
    await new Client(app).setup();
    const b = new Client(app, '100.64.0.2');
    for (let i = 0; i < 5; i++) expect((await b.login('jeff', 'wrong password')).status).toBe(401);

    let r = await b.login(); // even the right password is refused while blocked
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('rate_limited');
    expect(r.res.headers.get('retry-after')).toBe('1');
    expect(r.body.error.details.retryAfterSeconds).toBe(1);

    // Another device is not affected.
    expect((await new Client(app, '100.64.0.3').login()).status).toBe(200);

    clock.advance(1_000);
    expect((await b.login('jeff', 'wrong password')).status).toBe(401); // 6th failure: 2 s
    r = await b.login();
    expect(r.status).toBe(429);
    expect(r.res.headers.get('retry-after')).toBe('2');

    clock.advance(2_000);
    expect((await b.login()).status).toBe(200);
    // Success resets the counter: five more free attempts.
    const c = new Client(app, '100.64.0.2');
    for (let i = 0; i < 5; i++) expect((await c.login('jeff', 'nope nope nope')).status).toBe(401);
  });

  it('counts parallel attempts before they finish', async () => {
    const { app } = await makeApp();
    await new Client(app).setup();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => new Client(app, '100.64.0.2').login('jeff', 'wrong pass')),
    );
    expect(results.filter((r) => r.status === 401).length).toBeLessThanOrEqual(6);
    expect(results.some((r) => r.status === 429)).toBe(true);
  });

  it('has a global limit across IPs', async () => {
    const { app, clock } = await makeApp({
      limits: {
        perIp: { threshold: 5, baseMs: 1000, maxMs: 60_000, decayMs: 3_600_000 },
        global: { threshold: 3, baseMs: 10_000, maxMs: 60_000, decayMs: 3_600_000 },
      },
    });
    await new Client(app).setup();
    for (let i = 0; i < 3; i++) {
      expect((await new Client(app, `100.64.1.${i}`).login('jeff', 'wrong pass')).status).toBe(401);
    }
    expect((await new Client(app, '100.64.2.1').login()).status).toBe(429);
    clock.advance(10_000);
    expect((await new Client(app, '100.64.2.1').login()).status).toBe(200);
  });

  it('uses the right-most X-Forwarded-For entry only when trustProxy is on', async () => {
    const { app } = await makeApp();
    await new Client(app).setup();
    // A client cannot dodge the limit by prepending its own X-Forwarded-For values.
    for (let i = 0; i < 5; i++) {
      await new Client(app, `1.2.3.${i}, 100.64.0.2`).login('jeff', 'wrong pass');
    }
    expect((await new Client(app, '9.9.9.9, 100.64.0.2').login()).status).toBe(429);

    const untrusted = await makeApp({ trustProxy: false });
    await new Client(untrusted.app).setup();
    for (let i = 0; i < 5; i++) {
      await new Client(untrusted.app, `100.64.0.${i}`).login('jeff', 'wrong pass');
    }
    // Every request has the same (socket) address, so forged headers do not help.
    expect((await new Client(untrusted.app, '100.64.0.99').login()).status).toBe(429);
  });

  it('Backoff decays after a quiet period', () => {
    let t = 0;
    const b = new Backoff({ threshold: 2, baseMs: 1000, maxMs: 4000, decayMs: 10_000 }, () => t);
    b.begin('k');
    b.begin('k');
    expect(b.retryAfterMs('k')).toBe(1000);
    b.begin('k');
    b.begin('k');
    b.begin('k');
    expect(b.retryAfterMs('k')).toBe(4000); // capped
    t += 10_001;
    expect(b.retryAfterMs('k')).toBe(0);
    expect(b.size).toBe(0);
  });
});

/* -------------------------------------------------------------------------------------------
 * Sessions
 * ----------------------------------------------------------------------------------------- */

describe('sessions', () => {
  it('expires after 90 days without use', async () => {
    const { app, clock, revoked } = await makeApp();
    const a = new Client(app);
    const s = await a.setup();
    clock.advance(90 * DAY);
    const r = await a.json('GET', '/api/dummy');
    expect(r.status).toBe(401);
    expect(a.cookie).toBeNull(); // cookie cleared
    expect(revoked).toEqual([s.body.sessionId]);
  });

  it('slides the expiry on use (throttled) and re-sends the cookie', async () => {
    const { app, clock } = await makeApp();
    const a = new Client(app);
    await a.setup();
    clock.advance(30_000);
    await a.req('GET', '/api/dummy');
    expect(a.lastSetCookie).toBeNull(); // within the touch interval: no write

    clock.advance(60 * DAY);
    await a.req('GET', '/api/dummy');
    expect(a.lastSetCookie).toMatch(/Max-Age=7776000/);
    clock.advance(60 * DAY);
    const r = await a.json('GET', API.auth.session);
    expect(r.status).toBe(200);
    expect(r.body.expiresAt).toBe(new Date(clock.t + 90 * DAY).toISOString());
    const list = await a.json('GET', API.auth.sessions);
    expect(list.body.sessions[0].lastSeenAt).toBe(new Date(clock.t).toISOString());
  });

  it('ignores malformed or unknown cookies', async () => {
    const { app } = await makeApp();
    await new Client(app).setup();
    const x = new Client(app);
    x.cookie = 'not-a-token';
    expect((await x.req('GET', '/api/dummy')).status).toBe(401);
    expect(x.cookie).toBeNull();
    x.cookie = 'A'.repeat(43);
    expect((await x.req('GET', '/api/dummy')).status).toBe(401);
  });

  it('lists sessions and revokes one, all others, or the current one', async () => {
    const { app, revoked } = await makeApp();
    const a = new Client(app, '100.64.0.1');
    const sa = await a.setup();
    const b = new Client(app, '100.64.0.2', {
      'user-agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    });
    const sb = await b.login();
    const c = new Client(app, '100.64.0.3');
    const sc = await c.login();

    const list = await a.json('GET', API.auth.sessions);
    expect(list.status).toBe(200);
    expect(list.body.sessions).toHaveLength(3);
    const mine = list.body.sessions.find((s: any) => s.current);
    expect(mine).toMatchObject({ id: sa.body.sessionId, ip: '100.64.0.1', authMethod: 'setup' });
    const phone = list.body.sessions.find((s: any) => s.id === sb.body.sessionId);
    expect(phone).toMatchObject({
      deviceName: 'Safari on iPhone',
      authMethod: 'password',
      current: false,
    });

    // Revoke one.
    expect((await a.json('DELETE', `${API.auth.sessions}/${sb.body.sessionId}`)).status).toBe(200);
    expect((await b.req('GET', '/api/dummy')).status).toBe(401);
    expect(revoked).toContain(sb.body.sessionId);
    expect((await a.json('DELETE', `${API.auth.sessions}/${sb.body.sessionId}`)).status).toBe(404);

    // Revoke all others.
    const others = await a.json('DELETE', API.auth.sessions);
    expect(others.body).toEqual({ ok: true, revoked: 1 });
    expect((await c.req('GET', '/api/dummy')).status).toBe(401);
    expect(revoked).toContain(sc.body.sessionId);
    expect((await a.req('GET', '/api/dummy')).status).toBe(200);

    // Revoke the current one: signs this device out.
    expect((await a.json('DELETE', `${API.auth.sessions}/${sa.body.sessionId}`)).status).toBe(200);
    expect(a.cookie).toBeNull();
    expect((await a.req('GET', '/api/dummy')).status).toBe(401);
  });

  it('logs out', async () => {
    const { app, revoked } = await makeApp();
    const a = new Client(app);
    const s = await a.setup();
    const token = a.cookie;
    const r = await a.json('POST', API.auth.logout);
    expect(r.body).toEqual({ ok: true });
    expect(a.cookie).toBeNull();
    // Private favicons/attachments in the HTTP cache do not outlive the session.
    expect(r.res.headers.get('clear-site-data')).toBe('"cache"');
    expect(revoked).toEqual([s.body.sessionId]);
    // The old token is dead even if replayed.
    const replay = new Client(app);
    replay.cookie = token;
    expect((await replay.req('GET', '/api/dummy')).status).toBe(401);
    // Logging out without a session is harmless.
    expect((await new Client(app).json('POST', API.auth.logout)).status).toBe(200);
  });

  it('purges expired sessions in housekeeping on startup', async () => {
    const { app, ctx } = await makeApp();
    await new Client(app).setup();
    ctx.db.run("UPDATE auth_sessions SET expires_at = '2000-01-01T00:00:00.000Z'");
    // A new feature instance runs housekeeping at register time.
    await createApp(ctx, {
      features: [{ name: 'auth', register: createAuthFeature({ hashParams: FAST_HASH }).register }],
      serveWeb: false,
    });
    expect(ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM auth_sessions')?.n).toBe(0);
  });
});

/* -------------------------------------------------------------------------------------------
 * requireAuth, CSRF, Origin, headers
 * ----------------------------------------------------------------------------------------- */

describe('requireAuth guard', () => {
  it('protects other features and exposes the session', async () => {
    const { app } = await makeApp();
    const anon = new Client(app);
    const r = await anon.json('GET', '/api/dummy');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('unauthorized');
    expect((await anon.json('POST', '/api/dummy')).status).toBe(401);

    const a = new Client(app);
    const s = await a.setup();
    expect((await a.json('GET', '/api/dummy')).body).toEqual({
      sessionId: s.body.sessionId,
      username: 'jeff',
    });
    expect((await a.json('GET', API.auth.session)).status).toBe(200);
    expect((await anon.json('GET', API.auth.session)).status).toBe(401);
    expect((await anon.json('GET', API.auth.sessions)).status).toBe(401);
    expect((await anon.json('GET', API.auth.passkeys)).status).toBe(401);
  });

  it('keeps health and the sign-in endpoints public', async () => {
    const { app } = await makeApp();
    const anon = new Client(app);
    expect((await anon.req('GET', API.health)).status).toBe(200);
    expect((await anon.req('GET', API.auth.status)).status).toBe(200);
  });
});

describe('CSRF', () => {
  it('requires the session CSRF token on mutations', async () => {
    const { app } = await makeApp();
    const a = new Client(app);
    await a.setup();
    const token = a.csrf!;

    a.csrf = null;
    let r = await a.json('POST', '/api/dummy');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('csrf_failed');

    a.csrf = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    expect((await a.json('POST', '/api/dummy')).status).toBe(403);
    expect((await a.json('DELETE', API.auth.sessions)).status).toBe(403);
    expect((await a.json('POST', API.auth.logout)).status).toBe(403);

    a.csrf = token;
    expect((await a.json('POST', '/api/dummy')).status).toBe(200);
    // Safe methods need no token.
    a.csrf = null;
    expect((await a.json('GET', '/api/dummy')).status).toBe(200);
  });

  it('gives each session its own token, stable across requests', async () => {
    const { app } = await makeApp();
    const a = new Client(app);
    const sa = await a.setup();
    const b = new Client(app, '100.64.0.2');
    const sb = await b.login();
    expect(sa.body.csrfToken).not.toBe(sb.body.csrfToken);
    expect((await a.json('GET', API.auth.session)).body.csrfToken).toBe(sa.body.csrfToken);
    b.csrf = sa.body.csrfToken;
    expect((await b.json('POST', '/api/dummy')).status).toBe(403);
  });
});

describe('Origin check', () => {
  it('rejects mutations from other origins, before anything else', async () => {
    const { app } = await makeApp();
    const evil = new Client(app, '100.64.0.1', { origin: 'https://evil.example' });
    const r = await evil.json('POST', API.auth.setup, { username: 'jeff', password: PASSWORD });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('csrf_failed');
    expect((await evil.json('GET', API.auth.status)).body.setupRequired).toBe(true);

    const good = new Client(app, '100.64.0.1', { origin: ORIGIN });
    expect((await good.setup()).status).toBe(200);
    expect((await good.json('POST', '/api/dummy')).status).toBe(200);
    // Signed-in request with a valid CSRF token but a foreign origin.
    expect(
      (await good.json('POST', '/api/dummy', undefined, { origin: 'https://evil.example' })).status,
    ).toBe(403);
    // "null" origin (sandboxed iframes, some redirects).
    expect((await good.json('POST', '/api/dummy', undefined, { origin: 'null' })).status).toBe(403);
  });

  it('rejects cross-site requests without an Origin header via Sec-Fetch-Site', async () => {
    const { app } = await makeApp();
    const a = new Client(app);
    const r = await a.json(
      'POST',
      API.auth.setup,
      { username: 'jeff', password: PASSWORD },
      { 'sec-fetch-site': 'cross-site' },
    );
    expect(r.status).toBe(403);
    const ok = await a.json(
      'POST',
      API.auth.setup,
      { username: 'jeff', password: PASSWORD },
      { 'sec-fetch-site': 'same-origin' },
    );
    expect(ok.status).toBe(200);
  });

  it('rejects cross-site and same-site GETs too (Lax cookies ride top-level navigations)', async () => {
    const { app } = await makeApp();
    const a = new Client(app);
    await a.setup();
    for (const site of ['cross-site', 'same-site']) {
      const r = await a.json('GET', '/api/dummy', undefined, { 'sec-fetch-site': site });
      expect(r.status, site).toBe(403);
      expect(r.body.error.code).toBe('csrf_failed');
    }
    for (const site of ['same-origin', 'none']) {
      const r = await a.json('GET', '/api/dummy', undefined, { 'sec-fetch-site': site });
      expect(r.status, site).toBe(200);
    }
    expect((await a.json('GET', '/api/dummy')).status).toBe(200);
  });

  it('accepts loopback origins outside production only', async () => {
    const dev = await makeApp();
    const local = new Client(dev.app, '100.64.0.1', { origin: 'http://localhost:8787' });
    expect((await local.setup()).status).toBe(200);

    const prod = await makeApp({ isProduction: true });
    const r = await new Client(prod.app, '100.64.0.1', { origin: 'http://localhost:8787' }).setup();
    expect(r.status).toBe(403);
  });
});

describe('response headers', () => {
  it('marks API responses no-store', async () => {
    const { app } = await makeApp();
    const res = await app.request(API.auth.status);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('permissions-policy')).toMatch(/camera=\(\)/);
  });

  it('rejects oversized bodies', async () => {
    const { app } = await makeApp();
    const r = await new Client(app).json('POST', API.auth.login, {
      username: 'jeff',
      password: 'x'.repeat(70_000),
    });
    expect(r.status).toBe(413);
  });
});

/* -------------------------------------------------------------------------------------------
 * Password change
 * ----------------------------------------------------------------------------------------- */

describe('password change', () => {
  it('requires the current password and revokes other sessions', async () => {
    const { app, revoked } = await makeApp();
    const a = new Client(app);
    await a.setup();
    const b = new Client(app, '100.64.0.2');
    const sb = await b.login();

    const wrong = await a.json('POST', API.auth.password, {
      currentPassword: 'not it at all',
      newPassword: 'a brand new password',
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('wrong_password');

    const tooShort = await a.json('POST', API.auth.password, {
      currentPassword: PASSWORD,
      newPassword: 'short',
    });
    expect(tooShort.status).toBe(400);

    const ok = await a.json('POST', API.auth.password, {
      currentPassword: PASSWORD,
      newPassword: 'a brand new password',
    });
    expect(ok.status).toBe(200);
    expect(revoked).toContain(sb.body.sessionId);
    expect((await b.req('GET', '/api/dummy')).status).toBe(401);
    expect((await a.req('GET', '/api/dummy')).status).toBe(200);

    expect((await new Client(app, '100.64.0.3').login()).status).toBe(401);
    expect((await new Client(app, '100.64.0.4').login('jeff', 'a brand new password')).status).toBe(
      200,
    );
  });

  it('can keep other sessions', async () => {
    const { app } = await makeApp();
    const a = new Client(app);
    await a.setup();
    const b = new Client(app, '100.64.0.2');
    await b.login();
    const ok = await a.json('POST', API.auth.password, {
      currentPassword: PASSWORD,
      newPassword: 'a brand new password',
      revokeOtherSessions: false,
    });
    expect(ok.status).toBe(200);
    expect((await b.req('GET', '/api/dummy')).status).toBe(200);
  });

  it('rate-limits guessing the current password', async () => {
    const { app } = await makeApp();
    const a = new Client(app);
    await a.setup();
    for (let i = 0; i < 5; i++) {
      await a.json('POST', API.auth.password, {
        currentPassword: 'guess',
        newPassword: 'whatever123',
      });
    }
    const r = await a.json('POST', API.auth.password, {
      currentPassword: PASSWORD,
      newPassword: 'whatever123',
    });
    expect(r.status).toBe(429);
  });
});

/* -------------------------------------------------------------------------------------------
 * Helpers
 * ----------------------------------------------------------------------------------------- */

describe('helpers', () => {
  it('derives device labels', () => {
    expect(deviceLabel(UA_FIREFOX_WIN)).toBe('Firefox on Windows');
    expect(
      deviceLabel(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
      ),
    ).toBe('Edge on macOS');
    expect(
      deviceLabel(
        'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
      ),
    ).toBe('Chrome on Android');
    expect(deviceLabel('curl/8.0')).toBeNull();
    expect(deviceLabel(null)).toBeNull();
  });

  it('reads the client IP', async () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    const { app } = await createTestApp({
      features: [
        {
          name: 'ip',
          register: (a) => {
            a.get('/api/ip', (c) =>
              c.json({
                trusted: clientIp(c, { trustProxy: true }),
                untrusted: clientIp(c, { trustProxy: false }),
              }),
            );
          },
        },
      ],
      config,
    });
    const res = await app.request('/api/ip', {
      headers: { 'x-forwarded-for': 'garbage, ::ffff:100.64.0.7' },
    });
    expect(await res.json()).toEqual({ trusted: '100.64.0.7', untrusted: 'unknown' });
  });
});

/* -------------------------------------------------------------------------------------------
 * Passkeys, with a software authenticator (ES256, "none" attestation)
 * ----------------------------------------------------------------------------------------- */

const RP_ID = 'webfront.example.ts.net';
const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const hashOf = (b: Uint8Array | string) => createHash('sha256').update(b).digest();
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

class SoftAuthenticator {
  private readonly keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  readonly credentialId = randomBytes(16);
  counter = 0;
  userHandle: string | null = null;

  private cosePublicKey(): Uint8Array {
    const jwk = this.keys.publicKey.export({ format: 'jwk' });
    return isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, new Uint8Array(Buffer.from(jwk.x!, 'base64url'))],
        [-3, new Uint8Array(Buffer.from(jwk.y!, 'base64url'))],
      ]),
    );
  }

  register(
    options: { challenge: string; user: { id: string } },
    o: { origin?: string; rpId?: string; uv?: boolean } = {},
  ) {
    this.userHandle = options.user.id;
    const clientData = Buffer.from(
      JSON.stringify({
        type: 'webauthn.create',
        challenge: options.challenge,
        origin: o.origin ?? ORIGIN,
        crossOrigin: false,
      }),
    );
    const flags = 0x01 | (o.uv === false ? 0 : 0x04) | 0x40; // UP, UV, AT
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      hashOf(o.rpId ?? RP_ID),
      Buffer.from([flags]),
      u32(0),
      Buffer.alloc(16), // aaguid
      idLen,
      this.credentialId,
      this.cosePublicKey(),
    ]);
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', new Uint8Array(authData)],
      ]) as never,
    );
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: 'public-key' as const,
      response: {
        clientDataJSON: b64u(clientData),
        attestationObject: b64u(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  authenticate(
    options: { challenge: string },
    o: { origin?: string; counter?: number; userHandle?: string; uv?: boolean } = {},
  ) {
    this.counter = o.counter ?? this.counter + 1;
    const clientData = Buffer.from(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: options.challenge,
        origin: o.origin ?? ORIGIN,
        crossOrigin: false,
      }),
    );
    const authData = Buffer.concat([
      hashOf(RP_ID),
      Buffer.from([0x01 | (o.uv === false ? 0 : 0x04)]),
      u32(this.counter),
    ]);
    const signature = sign(
      'sha256',
      Buffer.concat([authData, hashOf(clientData)]),
      this.keys.privateKey,
    );
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: 'public-key' as const,
      response: {
        clientDataJSON: b64u(clientData),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        userHandle: o.userHandle ?? this.userHandle ?? undefined,
      },
      clientExtensionResults: {},
    };
  }
}

async function registerPasskey(a: Client, auth: SoftAuthenticator, name = 'MacBook') {
  const opts = await a.json('POST', API.auth.passkeyRegisterOptions, { name });
  expect(opts.status).toBe(200);
  return a.json('POST', API.auth.passkeyRegisterVerify, {
    name,
    response: auth.register(opts.body.options),
  });
}

describe('passkeys', () => {
  it('generates registration options for signed-in users only', async () => {
    const { app, ctx } = await makeApp();
    const anon = new Client(app);
    expect((await anon.json('POST', API.auth.passkeyRegisterOptions)).status).toBe(401);

    const a = new Client(app);
    await a.setup();
    const r = await a.json('POST', API.auth.passkeyRegisterOptions); // body is optional
    expect(r.status).toBe(200);
    const o = r.body.options;
    expect(o.rp).toEqual({ name: 'Webfront', id: RP_ID });
    expect(o.user.name).toBe('jeff');
    expect(o.user.id).not.toContain('jeff');
    expect(o.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      userVerification: 'required',
    });
    expect(o.attestation).toBe('none');
    // Only a hash of the challenge is stored, bound to this session.
    const rows = ctx.db.all<{ challenge_hash: string; kind: string; session_id: string }>(
      'SELECT challenge_hash, kind, session_id FROM auth_challenges',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'register', challenge_hash: sha256(o.challenge) });
    expect(rows[0]!.challenge_hash).not.toBe(o.challenge);
  });

  it('generates usernameless login options publicly (after setup)', async () => {
    const { app } = await makeApp();
    const anon = new Client(app);
    expect((await anon.json('POST', API.auth.passkeyLoginOptions)).status).toBe(409);
    await new Client(app).setup();
    const r = await anon.json('POST', API.auth.passkeyLoginOptions);
    expect(r.status).toBe(200);
    expect(r.body.options).toMatchObject({ rpId: RP_ID, userVerification: 'required' });
    expect(r.body.options.allowCredentials ?? []).toEqual([]);
    expect(r.body.options.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('registers, lists, signs in with, renames and deletes a passkey', async () => {
    const { app, ctx } = await makeApp();
    const a = new Client(app);
    await a.setup();
    const auth = new SoftAuthenticator();

    const reg = await registerPasskey(a, auth);
    expect(reg.status).toBe(200);
    expect(reg.body).toMatchObject({ name: 'MacBook', lastUsedAt: null, backedUp: false });
    expect(ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM auth_challenges')?.n).toBe(0);

    // Same authenticator again is refused (excludeCredentials is also sent).
    const opts2 = await a.json('POST', API.auth.passkeyRegisterOptions);
    expect(opts2.body.options.excludeCredentials).toEqual([
      { id: b64u(auth.credentialId), type: 'public-key', transports: ['internal'] },
    ]);
    const dup = await a.json('POST', API.auth.passkeyRegisterVerify, {
      name: 'again',
      response: auth.register(opts2.body.options),
    });
    expect(dup.status).toBe(409);

    let list = await a.json('GET', API.auth.passkeys);
    expect(list.body.passkeys).toHaveLength(1);
    const id = list.body.passkeys[0].id;
    expect((await new Client(app).json('GET', API.auth.status)).body.passkeysAvailable).toBe(true);

    // Sign in on another device.
    const phone = new Client(app, '100.64.0.2');
    const opts = await phone.json('POST', API.auth.passkeyLoginOptions);
    const login = await phone.signIn(API.auth.passkeyLoginVerify, {
      response: auth.authenticate(opts.body.options),
      deviceName: 'Phone',
    });
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({ username: 'jeff', deviceName: 'Phone' });
    expect((await phone.json('GET', '/api/dummy')).status).toBe(200);
    const sessions = await a.json('GET', API.auth.sessions);
    expect(sessions.body.sessions.find((s: any) => s.id === login.body.sessionId).authMethod).toBe(
      'passkey',
    );

    list = await a.json('GET', API.auth.passkeys);
    expect(list.body.passkeys[0].lastUsedAt).toBe('2026-11-14T12:00:00.000Z');
    expect(ctx.db.get<{ counter: number }>('SELECT counter FROM auth_passkeys')?.counter).toBe(1);

    // Rename and delete.
    const renamed = await a.json('PATCH', `${API.auth.passkeys}/${id}`, { name: 'Laptop' });
    expect(renamed.body).toMatchObject({ id, name: 'Laptop' });
    expect((await a.json('PATCH', `${API.auth.passkeys}/nope`, { name: 'x' })).status).toBe(404);
    expect((await a.json('PATCH', `${API.auth.passkeys}/${id}`, { name: '' })).status).toBe(400);
    expect((await a.json('DELETE', `${API.auth.passkeys}/${id}`)).status).toBe(200);
    expect((await a.json('DELETE', `${API.auth.passkeys}/${id}`)).status).toBe(404);
    expect((await a.json('GET', API.auth.passkeys)).body.passkeys).toEqual([]);

    // A deleted passkey can no longer sign in.
    const opts3 = await phone.json('POST', API.auth.passkeyLoginOptions);
    const gone = await new Client(app, '100.64.0.3').json('POST', API.auth.passkeyLoginVerify, {
      response: auth.authenticate(opts3.body.options),
    });
    expect(gone.status).toBe(401);
  });

  it('rejects expired, reused and foreign registration challenges', async () => {
    const { app, clock } = await makeApp();
    const a = new Client(app);
    await a.setup();
    const auth = new SoftAuthenticator();

    // Expired.
    let opts = await a.json('POST', API.auth.passkeyRegisterOptions);
    clock.advance(5 * 60_000 + 1);
    let r = await a.json('POST', API.auth.passkeyRegisterVerify, {
      name: 'x',
      response: auth.register(opts.body.options),
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('passkey_failed');

    // Wrong origin: fails, and the challenge is burnt.
    opts = await a.json('POST', API.auth.passkeyRegisterOptions);
    r = await a.json('POST', API.auth.passkeyRegisterVerify, {
      name: 'x',
      response: auth.register(opts.body.options, { origin: 'https://evil.example' }),
    });
    expect(r.status).toBe(400);
    r = await a.json('POST', API.auth.passkeyRegisterVerify, {
      name: 'x',
      response: auth.register(opts.body.options),
    });
    expect(r.status).toBe(400);

    // Wrong RP ID.
    opts = await a.json('POST', API.auth.passkeyRegisterOptions);
    r = await a.json('POST', API.auth.passkeyRegisterVerify, {
      name: 'x',
      response: auth.register(opts.body.options, { rpId: 'evil.example' }),
    });
    expect(r.status).toBe(400);

    // No user verification.
    opts = await a.json('POST', API.auth.passkeyRegisterOptions);
    r = await a.json('POST', API.auth.passkeyRegisterVerify, {
      name: 'x',
      response: auth.register(opts.body.options, { uv: false }),
    });
    expect(r.status).toBe(400);

    // A challenge issued to another session.
    const b = new Client(app, '100.64.0.2');
    await b.login();
    opts = await b.json('POST', API.auth.passkeyRegisterOptions);
    r = await a.json('POST', API.auth.passkeyRegisterVerify, {
      name: 'x',
      response: auth.register(opts.body.options),
    });
    expect(r.status).toBe(400);

    // A login challenge cannot be used for registration.
    const loginOpts = await a.json('POST', API.auth.passkeyLoginOptions);
    r = await a.json('POST', API.auth.passkeyRegisterVerify, {
      name: 'x',
      response: auth.register({ ...loginOpts.body.options, user: { id: 'aGVsbG8' } }),
    });
    expect(r.status).toBe(400);

    // Malformed credential.
    r = await a.json('POST', API.auth.passkeyRegisterVerify, {
      name: 'x',
      response: { id: 'x', rawId: 'x', type: 'public-key' },
    });
    expect(r.status).toBe(400);
    expect((await a.json('GET', API.auth.passkeys)).body.passkeys).toEqual([]);
  });

  it('rejects bad passkey sign-ins and rate-limits them per IP', async () => {
    const { app, clock } = await makeApp();
    const a = new Client(app);
    await a.setup();
    const auth = new SoftAuthenticator();
    expect((await registerPasskey(a, auth)).status).toBe(200);
    const x = new Client(app, '100.64.0.2');
    const opts = async () => (await x.json('POST', API.auth.passkeyLoginOptions)).body.options;
    const verify = (response: unknown) => x.json('POST', API.auth.passkeyLoginVerify, { response });

    // Unknown credential.
    const stranger = new SoftAuthenticator();
    stranger.userHandle = auth.userHandle;
    expect((await verify(stranger.authenticate(await opts()))).status).toBe(401);
    // Wrong user handle.
    expect((await verify(auth.authenticate(await opts(), { userHandle: 'b3RoZXI' }))).status).toBe(
      401,
    );
    // Wrong origin.
    expect(
      (await verify(auth.authenticate(await opts(), { origin: 'https://evil.example' }))).status,
    ).toBe(401);
    // Unknown challenge.
    expect((await verify(auth.authenticate({ challenge: 'bm90LWlzc3VlZA' }))).status).toBe(401);
    // Malformed assertion (schema-valid, signature garbage).
    const bad = auth.authenticate(await opts());
    bad.response.signature = 'AAAA';
    expect((await verify(bad)).status).toBe(401);
    // 5 failures so far: blocked, even for a valid assertion.
    const blocked = await verify(auth.authenticate(await opts()));
    expect(blocked.status).toBe(429);

    clock.advance(60_000);
    const y = new Client(app, '100.64.0.3');
    // Expired challenge.
    let o = (await y.json('POST', API.auth.passkeyLoginOptions)).body.options;
    clock.advance(5 * 60_000 + 1);
    expect(
      (await y.json('POST', API.auth.passkeyLoginVerify, { response: auth.authenticate(o) }))
        .status,
    ).toBe(401);

    // Valid, then replaying the same assertion fails (challenge consumed).
    o = (await y.json('POST', API.auth.passkeyLoginOptions)).body.options;
    const assertion = auth.authenticate(o, { counter: 50 });
    expect((await y.signIn(API.auth.passkeyLoginVerify, { response: assertion })).status).toBe(200);
    const z = new Client(app, '100.64.0.4');
    expect(
      (await z.json('POST', API.auth.passkeyLoginVerify, { response: assertion })).status,
    ).toBe(401);

    // Counter going backwards (cloned authenticator) fails.
    o = (await z.json('POST', API.auth.passkeyLoginOptions)).body.options;
    expect(
      (
        await z.json('POST', API.auth.passkeyLoginVerify, {
          response: auth.authenticate(o, { counter: 10 }),
        })
      ).status,
    ).toBe(401);
    // No user verification fails.
    o = (await z.json('POST', API.auth.passkeyLoginOptions)).body.options;
    expect(
      (
        await z.json('POST', API.auth.passkeyLoginVerify, {
          response: auth.authenticate(o, { uv: false }),
        })
      ).status,
    ).toBe(401);
  });

  it('caps outstanding login challenges', async () => {
    const { app, ctx } = await makeApp();
    await new Client(app).setup();
    const anon = new Client(app);
    for (let i = 0; i < 120; i++) await anon.req('POST', API.auth.passkeyLoginOptions);
    expect(
      ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM auth_challenges WHERE kind = 'login'")
        ?.n,
    ).toBe(100);
  });

  it('drops registration challenges when their session ends', async () => {
    const { app, ctx } = await makeApp();
    const a = new Client(app);
    await a.setup();
    await a.json('POST', API.auth.passkeyRegisterOptions);
    await a.json('POST', API.auth.logout);
    expect(ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM auth_challenges')?.n).toBe(0);
  });
});
