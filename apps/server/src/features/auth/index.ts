import {
  API,
  CSRF_HEADER,
  ERROR_CODES,
  SESSION_COOKIE,
  loginRequestSchema,
  passkeyLoginVerifyRequestSchema,
  passkeyRegisterOptionsRequestSchema,
  passkeyRegisterVerifyRequestSchema,
  passkeyRenameRequestSchema,
  passwordChangeRequestSchema,
  setupRequestSchema,
  type AuthMethod,
  type AuthStatusResponse,
  type OkResponse,
  type PasskeyInfo,
  type PasskeyListResponse,
  type PasskeyLoginOptionsResponse,
  type PasskeyRegisterOptionsResponse,
  type RevokeOtherSessionsResponse,
  type SessionInfo,
  type SessionListResponse,
} from '@webfront/shared';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { App, AppContext, AppEnv } from '../../context.js';
import { AppError, badRequest, notFound, unauthorized } from '../../http/errors.js';
import { parseJson, parseParams } from '../../http/validate.js';
import { PasskeyService, toPasskeyInfo, PASSKEY_CHALLENGE_TTL_MS } from './passkeys.js';
import { createPasswordHasher, DEFAULT_HASH_PARAMS, type PasswordHashParams } from './passwords.js';
import { DEFAULT_LOGIN_LIMITS, LoginLimiter, type LoginLimiterOptions } from './rateLimit.js';
import { clientIp, deviceLabel, fetchSiteAllowed, originAllowed } from './request.js';
import {
  AuthStore,
  DEFAULT_SESSION_POLICY,
  csrfTokenFor,
  safeEqual,
  type LoadedSession,
  type SessionPolicy,
} from './store.js';

/**
 * Feature: auth (Task 2). One account; password (Argon2id) and passkey sign-in; per-device
 * sessions in an HttpOnly cookie with a 90-day sliding expiry; CSRF and Origin checks on every
 * mutating /api request; login rate limiting.
 *
 * Global /api middleware (installed here, before every other feature's routes):
 *  0. Requests the browser marks `Sec-Fetch-Site: cross-site` or `same-site` are refused (403
 *     `csrf_failed`), GETs included (see `fetchSiteAllowed`).
 *  1. Mutating requests (anything but GET/HEAD/OPTIONS) must come from PUBLIC_ORIGIN (403
 *     `csrf_failed`).
 *  2. The session cookie is resolved to `c.var.session`; expired or unknown cookies are cleared.
 *  3. Mutating requests made with a session must carry `x-csrf-token` (403 `csrf_failed`),
 *     except the public sign-in endpoints, which act on credentials rather than on the session.
 *  4. API responses default to `Cache-Control: no-store`.
 *
 * `ctx.requireAuth` then simply rejects requests without a session (401).
 */

export interface AuthFeatureOptions {
  /** Clock (ms since epoch); tests inject a fake one. */
  now?: () => number;
  hashParams?: PasswordHashParams;
  limits?: LoginLimiterOptions;
  sessions?: Partial<SessionPolicy>;
  challengeTtlMs?: number;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Mutations that do not require a CSRF token (they authenticate with credentials). */
const CSRF_EXEMPT = new Set<string>([
  API.auth.setup,
  API.auth.login,
  API.auth.passkeyLoginOptions,
  API.auth.passkeyLoginVerify,
]);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_USER_AGENT = 512;
const HOUSEKEEPING_INTERVAL_MS = 60 * 60_000;

const idParamsSchema = z.object({ id: z.string().min(1).max(64) });

const csrfFailed = (message: string) => new AppError(403, ERROR_CODES.csrf, message);

export function createAuthFeature(options: AuthFeatureOptions = {}) {
  return {
    register(app: App, ctx: AppContext): void {
      const { config } = ctx;
      const now = options.now ?? Date.now;
      const log = ctx.logger.child({ feature: 'auth' });
      const policy: SessionPolicy = { ...DEFAULT_SESSION_POLICY, ...options.sessions };
      const store = new AuthStore(ctx.db, ctx.events, now, policy);
      const passkeys = new PasskeyService(
        ctx.db,
        config,
        now,
        options.challengeTtlMs ?? PASSKEY_CHALLENGE_TTL_MS,
      );
      const hasher = createPasswordHasher(options.hashParams ?? DEFAULT_HASH_PARAMS);
      const limiter = new LoginLimiter(options.limits ?? DEFAULT_LOGIN_LIMITS, now);

      /** Sessions resolved by the middleware, per request (token needed for the CSRF value). */
      const loaded = new WeakMap<Context, LoadedSession>();

      const cookieSecure = !config.publicOrigin.startsWith('http:');
      const setSessionCookie = (c: Context, token: string) =>
        setCookie(c, SESSION_COOKIE, token, {
          httpOnly: true,
          secure: cookieSecure,
          sameSite: 'Lax',
          path: '/api',
          maxAge: Math.floor(policy.ttlMs / 1000),
        });
      const clearSessionCookie = (c: Context) =>
        deleteCookie(c, SESSION_COOKIE, {
          httpOnly: true,
          secure: cookieSecure,
          sameSite: 'Lax',
          path: '/api',
        });

      const ipOf = (c: Context) => clientIp(c, config);

      const rateLimited = (c: Context, waitMs: number) => {
        const seconds = Math.max(1, Math.ceil(waitMs / 1000));
        c.header('Retry-After', String(seconds));
        log.warn('sign-in rate limited', { ip: ipOf(c), retryAfterSeconds: seconds });
        return new AppError(429, ERROR_CODES.rateLimited, 'Too many attempts. Try again later.', {
          retryAfterSeconds: seconds,
        });
      };

      const current = (c: Context): LoadedSession => {
        const s = loaded.get(c);
        if (!s) throw unauthorized();
        return s;
      };

      const requireAccount = () => {
        const account = store.account();
        if (!account) {
          throw new AppError(409, ERROR_CODES.setupRequired, 'Create the account first');
        }
        return account;
      };

      /** Create a session (replacing any session this request already had) and set the cookie. */
      const startSession = (
        c: Context,
        method: AuthMethod,
        username: string,
        deviceName: string | undefined,
      ): SessionInfo => {
        const previous = loaded.get(c);
        if (previous) store.revoke(previous.row.id);
        const userAgent = c.req.header('user-agent')?.slice(0, MAX_USER_AGENT) ?? null;
        const ip = ipOf(c);
        const created = store.createSession({
          method,
          deviceName: deviceName ?? deviceLabel(userAgent),
          userAgent,
          ip,
        });
        setSessionCookie(c, created.token);
        log.info('signed in', { sessionId: created.row.id, method, ip });
        return store.sessionInfo({ ...created, username });
      };

      /* ---------------------------------------------------------------------------------
       * Global /api middleware
       * ------------------------------------------------------------------------------- */

      app.use('/api/*', async (c, next) => {
        const mutating = !SAFE_METHODS.has(c.req.method);
        if (!fetchSiteAllowed(c)) {
          log.warn('cross-site request rejected', { ip: ipOf(c), path: c.req.path });
          throw csrfFailed('Cross-site requests are not allowed');
        }
        if (mutating && !originAllowed(c, config)) {
          log.warn('origin rejected', { ip: ipOf(c), path: c.req.path });
          throw csrfFailed('Request origin not allowed');
        }

        const token = getCookie(c, SESSION_COOKIE);
        const session = token ? store.loadSession(token, ipOf(c)) : null;
        if (session) {
          loaded.set(c, session);
          c.set('session', { sessionId: session.row.id, username: session.username });
          if (session.touched) setSessionCookie(c, session.token);
        } else if (token !== undefined) {
          clearSessionCookie(c);
        }

        if (mutating && session && !CSRF_EXEMPT.has(c.req.path)) {
          const sent = c.req.header(CSRF_HEADER);
          if (!sent || !safeEqual(sent, csrfTokenFor(session.token))) {
            log.warn('csrf token rejected', { sessionId: session.row.id, path: c.req.path });
            throw csrfFailed('Missing or invalid CSRF token');
          }
        }

        await next();

        try {
          if (!c.res.headers.has('cache-control')) c.res.headers.set('cache-control', 'no-store');
        } catch {
          // Immutable headers (e.g. a proxied response): leave as is.
        }
      });

      const guard: MiddlewareHandler<AppEnv> = async (c, next) => {
        if (!c.get('session')) throw unauthorized();
        await next();
      };
      ctx.installAuthGuard(guard);

      /* ---------------------------------------------------------------------------------
       * Routes under /api/auth
       * ------------------------------------------------------------------------------- */

      const r = new Hono<AppEnv>();
      r.use(
        '*',
        bodyLimit({
          maxSize: MAX_BODY_BYTES,
          onError: () => {
            throw new AppError(413, 'payload_too_large', 'Request body too large');
          },
        }),
      );

      r.get('/status', (c) => {
        const account = store.account();
        const s = loaded.get(c);
        return c.json<AuthStatusResponse>({
          setupRequired: !account,
          session: s ? store.sessionInfo(s) : null,
          passkeysAvailable: !!account && passkeys.count() > 0,
        });
      });

      r.post('/setup', async (c) => {
        if (store.account()) throw new AppError(409, ERROR_CODES.conflict, 'Setup is already done');
        const body = await parseJson(c, setupRequestSchema);
        const hash = await hasher.hash(body.password);
        if (!store.createAccount(body.username, hash)) {
          throw new AppError(409, ERROR_CODES.conflict, 'Setup is already done');
        }
        log.info('account created');
        return c.json<SessionInfo>(startSession(c, 'setup', body.username, body.deviceName));
      });

      r.post('/login', async (c) => {
        const body = await parseJson(c, loginRequestSchema);
        const ip = ipOf(c);
        const wait = limiter.retryAfterMs(ip);
        if (wait > 0) throw rateLimited(c, wait);
        const account = requireAccount();

        limiter.begin(ip);
        // Always run the full Argon2 verification, whatever the username, so timing does not
        // reveal whether the username was right.
        const passwordOk = await hasher.verify(account.password_hash, body.password);
        const usernameOk = safeEqual(
          body.username.trim().toLowerCase(),
          account.username.toLowerCase(),
        );
        if (!passwordOk || !usernameOk) {
          log.warn('sign-in failed', { ip, method: 'password' });
          throw unauthorized('Wrong username or password');
        }
        limiter.succeed(ip);

        if (hasher.needsRehash(account.password_hash)) {
          store.setPasswordHash(await hasher.hash(body.password), false);
        }
        return c.json<SessionInfo>(startSession(c, 'password', account.username, body.deviceName));
      });

      r.post('/logout', (c) => {
        const s = loaded.get(c);
        if (s) {
          store.revoke(s.row.id);
          log.info('signed out', { sessionId: s.row.id });
        }
        clearSessionCookie(c);
        // Drop this origin's HTTP cache (private favicons and wiki images are cached with
        // `private, max-age`); the web app deletes its service-worker caches itself.
        c.header('Clear-Site-Data', '"cache"');
        return c.json<OkResponse>({ ok: true });
      });

      r.get('/session', guard, (c) => c.json<SessionInfo>(store.sessionInfo(current(c))));

      r.post('/password', guard, async (c) => {
        const s = current(c);
        const body = await parseJson(c, passwordChangeRequestSchema);
        const ip = ipOf(c);
        const wait = limiter.retryAfterMs(ip);
        if (wait > 0) throw rateLimited(c, wait);
        const account = requireAccount();

        limiter.begin(ip);
        if (!(await hasher.verify(account.password_hash, body.currentPassword))) {
          log.warn('password change rejected', { sessionId: s.row.id, ip });
          throw new AppError(400, 'wrong_password', 'The current password is wrong');
        }
        limiter.succeed(ip);

        store.setPasswordHash(await hasher.hash(body.newPassword), true);
        const revoked = body.revokeOtherSessions ? store.revokeAllExcept(s.row.id) : 0;
        log.info('password changed', { sessionId: s.row.id, revokedSessions: revoked });
        return c.json<OkResponse>({ ok: true });
      });

      /* ---- sessions ---- */

      r.get('/sessions', guard, (c) => {
        const s = current(c);
        return c.json<SessionListResponse>({
          sessions: store.listSessions().map((row) => AuthStore.summary(row, s.row.id)),
        });
      });

      r.delete('/sessions', guard, (c) => {
        const s = current(c);
        const revoked = store.revokeAllExcept(s.row.id);
        log.info('other sessions revoked', { sessionId: s.row.id, revoked });
        return c.json<RevokeOtherSessionsResponse>({ ok: true, revoked });
      });

      r.delete('/sessions/:id', guard, (c) => {
        const s = current(c);
        const { id } = parseParams(c, idParamsSchema);
        if (!store.revoke(id)) throw notFound('No such session');
        log.info('session revoked', { sessionId: id, by: s.row.id });
        if (id === s.row.id) clearSessionCookie(c);
        return c.json<OkResponse>({ ok: true });
      });

      /* ---- passkeys: management (signed in) ---- */

      r.get('/passkeys', guard, (c) =>
        c.json<PasskeyListResponse>({ passkeys: passkeys.list().map(toPasskeyInfo) }),
      );

      r.patch('/passkeys/:id', guard, async (c) => {
        const { id } = parseParams(c, idParamsSchema);
        const { name } = await parseJson(c, passkeyRenameRequestSchema);
        const row = passkeys.rename(id, name);
        if (!row) throw notFound('No such passkey');
        return c.json<PasskeyInfo>(toPasskeyInfo(row));
      });

      r.delete('/passkeys/:id', guard, (c) => {
        const { id } = parseParams(c, idParamsSchema);
        if (!passkeys.remove(id)) throw notFound('No such passkey');
        log.info('passkey deleted', { passkeyId: id, sessionId: current(c).row.id });
        return c.json<OkResponse>({ ok: true });
      });

      r.post('/passkeys/register/options', guard, async (c) => {
        const s = current(c);
        await parseOptionalJson(c, passkeyRegisterOptionsRequestSchema);
        const options = await passkeys.registrationOptions(requireAccount(), s.row.id);
        return c.json<PasskeyRegisterOptionsResponse>({ options: { ...options } });
      });

      r.post('/passkeys/register/verify', guard, async (c) => {
        const s = current(c);
        const body = await parseJson(c, passkeyRegisterVerifyRequestSchema);
        requireAccount();
        const row = await passkeys.verifyRegistration(body.response, body.name, s.row.id);
        log.info('passkey registered', { passkeyId: row.id, sessionId: s.row.id });
        return c.json<PasskeyInfo>(toPasskeyInfo(row));
      });

      /* ---- passkeys: sign-in (public) ---- */

      r.post('/passkeys/login/options', async (c) => {
        requireAccount();
        const options = await passkeys.authenticationOptions();
        return c.json<PasskeyLoginOptionsResponse>({ options: { ...options } });
      });

      r.post('/passkeys/login/verify', async (c) => {
        const body = await parseJson(c, passkeyLoginVerifyRequestSchema);
        const ip = ipOf(c);
        // Per-IP only: a passkey cannot be guessed, and the global limit must not lock the
        // owner's passkey out during a password-guessing attack.
        const wait = limiter.retryAfterMs(ip, true);
        if (wait > 0) throw rateLimited(c, wait);
        const account = requireAccount();

        limiter.begin(ip, true);
        const passkey = await passkeys.verifyAuthentication(body.response, account);
        if (!passkey) {
          log.warn('sign-in failed', { ip, method: 'passkey' });
          throw unauthorized('Passkey sign-in failed');
        }
        limiter.succeed(ip, true);
        return c.json<SessionInfo>(startSession(c, 'passkey', account.username, body.deviceName));
      });

      app.route('/api/auth', r);

      /* ---- housekeeping ---- */

      const housekeeping = () => {
        try {
          store.purgeExpired();
          limiter.prune();
        } catch (err) {
          log.error('auth housekeeping failed', { err });
        }
      };
      housekeeping();
      const timer = setInterval(housekeeping, HOUSEKEEPING_INTERVAL_MS);
      timer.unref?.();
      ctx.onClose(() => clearInterval(timer));
    },
  };
}

/** Parse an optional JSON body (empty body = `{}`). */
async function parseOptionalJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  const text = await c.req.text();
  if (!text.trim()) return schema.parse({});
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw badRequest('Request body must be valid JSON');
  }
  return schema.parse(raw);
}

/** The production auth feature (listed in features/index.ts). */
export function register(app: App, ctx: AppContext): void {
  createAuthFeature().register(app, ctx);
}
