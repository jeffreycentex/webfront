import {
  checkLinksRequestSchema,
  checkLinksResponseSchema,
  checkNowResponseSchema,
  SERVICE_CHECK_INTERVAL_SECONDS,
  type FieldsOf,
  type RecordOf,
} from '@webfront/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { App, AppContext, AppEnv } from '../../context.js';
import { AppError } from '../../http/errors.js';
import { parseJson } from '../../http/validate.js';
import { httpGet, type HttpGet } from '../favicons/httpClient.js';
import {
  checkLink,
  coarseIso,
  decideWrite,
  latencyBucket,
  mapLimit,
  probeService,
  tcpConnect,
  type TcpConnect,
} from './checker.js';
import type { Observation } from './notifications/alerts.js';
import { Notifier, type NotifierEnv } from './notifications/notifier.js';
import { sendToPushover, type PushoverSend } from './notifications/pushover.js';
import { notificationRoutes } from './notifications/routes.js';

/**
 * Feature: services — owner: Task 5.
 *
 * Every SERVICE_CHECK_INTERVAL_SECONDS (plus jitter) the checker probes bookmarks flagged
 * `isService` (HTTP GET with self-signed certificates allowed, or a TCP connect) and writes the
 * server-owned `serviceStatuses` collection through `ctx.records.writeAsServer`, only when
 * something changed. Routes (auth required):
 *   POST /api/services/check-now    run a sweep immediately
 *   POST /api/services/check-links  dead-link check of bookmarks (body { ids? })
 *   GET|PUT /api/services/notifications            Pushover alert settings (secrets masked)
 *   DELETE  /api/services/notifications/credentials remove the saved token and user key
 *   POST    /api/services/notifications/test        send a test notification
 *
 * After each sweep the confirmed states are handed to the Pushover notifier
 * (notifications/alerts.ts has the alert rules); delivery runs in the background so the
 * sweep never waits on Pushover.
 */

export interface ServicesFeatureOptions {
  httpGet?: HttpGet;
  tcpConnect?: TcpConnect;
  now?: () => number;
  /** Start the background timer (default: true unless NODE_ENV is "test"). */
  autoStart?: boolean;
  intervalMs?: number;
  /** Maximum random delay added to each interval and before each probe. */
  jitterMs?: number;
  concurrency?: number;
  /** Pushover transport (tests inject a fake; default: HTTPS to api.pushover.net). */
  pushoverSend?: PushoverSend;
  /** Delay between delivery retries (tests inject an instant one). */
  sleep?: (ms: number) => Promise<void>;
  /** Credential overrides (default: process.env PUSHOVER_APP_TOKEN / PUSHOVER_USER_KEY). */
  env?: NotifierEnv;
  /** Receives the notifier (tests use it to await deliveries). */
  onNotifier?: (notifier: Notifier) => void;
}

type Bookmark = RecordOf<'bookmarks'>;

export function createServicesFeature(options: ServicesFeatureOptions = {}) {
  return (app: App, ctx: AppContext): void => {
    const log = ctx.logger.child({ feature: 'services' });
    const get = options.httpGet ?? httpGet;
    const connect = options.tcpConnect ?? tcpConnect;
    const now = options.now ?? Date.now;
    const intervalMs = options.intervalMs ?? SERVICE_CHECK_INTERVAL_SECONDS * 1000;
    const jitterMs = options.jitterMs ?? 3_000;
    const concurrency = options.concurrency ?? 6;
    const autoStart = options.autoStart ?? ctx.config.env !== 'test';
    const failures = new Map<string, number>();
    let running: Promise<number> | null = null;
    let closed = false;

    const notifier = new Notifier({
      db: ctx.db,
      logger: log.child({ component: 'notifications' }),
      now,
      send: options.pushoverSend ?? sendToPushover,
      sleep:
        options.sleep ??
        ((ms) =>
          new Promise<void>((r) => {
            const t = setTimeout(r, ms);
            t.unref?.();
          })),
      env: options.env ?? process.env,
    });
    ctx.onClose(() => notifier.close());
    options.onNotifier?.(notifier);

    const sleep = (ms: number) =>
      ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve();
    const jitter = () => Math.floor(Math.random() * jitterMs);

    async function sweepOnce(): Promise<number> {
      const bookmarks = ctx.records
        .list('bookmarks')
        .filter((b): b is Bookmark & { serviceCheck: NonNullable<Bookmark['serviceCheck']> } =>
          Boolean(b.isService && b.serviceCheck),
        );
      const wanted = new Set(bookmarks.map((b) => b.id));
      const statuses = new Map(ctx.records.list('serviceStatuses').map((s) => [s.id, s]));

      const results = await mapLimit(bookmarks, concurrency, async (b) => {
        await sleep(jitter());
        if (closed) return null;
        const result = await probeService(b, b.serviceCheck, {
          httpGet: get,
          tcpConnect: connect,
          now,
        });
        const n = result.state === 'down' ? (failures.get(b.id) ?? 0) + 1 : 0;
        failures.set(b.id, n);
        return { b, result, n };
      });

      const t = now();
      const observations: Observation[] = [];
      const writes: Array<{
        id: string;
        fields: Partial<FieldsOf<'serviceStatuses'>> & { deleted?: boolean };
      }> = [];
      for (const r of results) {
        if (!r) continue;
        const prev = statuses.get(r.b.id);
        const d = decideWrite(prev, r.result, r.n, t);
        if (d.state === 'up' || d.state === 'down') {
          observations.push({
            bookmark: r.b,
            state: d.state,
            reason: d.state === 'down' ? (r.result.message ?? prev?.message ?? null) : null,
          });
        }
        if (!d.write) continue;
        writes.push({
          id: r.b.id,
          fields: {
            bookmarkId: r.b.id,
            state: d.state,
            changedAt: d.changedAt,
            checkedAt: coarseIso(t),
            latencyMs: d.state === 'up' ? latencyBucket(r.result.latencyMs) : null,
            message: d.state === 'down' ? r.result.message : null,
            ...(prev ? {} : { deleted: false }),
          },
        });
      }
      // Clean up statuses whose bookmark was deleted, un-flagged or lost its check.
      for (const id of statuses.keys()) {
        if (!wanted.has(id)) {
          writes.push({ id, fields: { deleted: true } });
          failures.delete(id);
        }
      }
      if (writes.length > 0) ctx.records.writeAsServer('serviceStatuses', writes);
      if (!closed) {
        try {
          notifier.onSweep(observations, wanted);
        } catch (err) {
          log.warn('service alert evaluation failed', { err });
        }
      }
      return bookmarks.length;
    }

    /** Runs a sweep; concurrent callers share one in-flight sweep. */
    function sweep(): Promise<number> {
      running ??= sweepOnce().finally(() => {
        running = null;
      });
      return running;
    }

    if (autoStart) {
      let timer: NodeJS.Timeout | undefined;
      const schedule = (delay: number) => {
        if (closed) return;
        timer = setTimeout(() => {
          sweep()
            .catch((err: unknown) => log.warn('service sweep failed', { err }))
            .finally(() => schedule(intervalMs + jitter()));
        }, delay);
        timer.unref?.();
      };
      schedule(5_000);
      ctx.onClose(() => {
        closed = true;
        if (timer) clearTimeout(timer);
      });
    }

    const r = new Hono<AppEnv>();

    r.post('/check-now', ctx.requireAuth, async (c) => {
      const checked = await sweep();
      c.header('Cache-Control', 'no-store');
      return c.json(checkNowResponseSchema.parse({ checked }));
    });

    r.post(
      '/check-links',
      ctx.requireAuth,
      bodyLimit({
        maxSize: 256 * 1024,
        onError: () => {
          throw new AppError(413, 'payload_too_large', 'Request body too large');
        },
      }),
      async (c) => {
        const body = await parseJson(c, checkLinksRequestSchema);
        const only = body.ids ? new Set(body.ids) : null;
        const bookmarks = ctx.records.list('bookmarks').filter((b) => !only || only.has(b.id));
        const results = await mapLimit(bookmarks, 8, (b) => checkLink(b, { httpGet: get }));
        c.header('Cache-Control', 'no-store');
        return c.json(
          checkLinksResponseSchema.parse({
            results,
            checkedAt: new Date(now()).toISOString().replace(/\.\d{3}Z$/, '.000Z'),
          }),
        );
      },
    );

    r.route('/notifications', notificationRoutes(ctx, notifier));

    app.route('/api/services', r);
  };
}

export const register = createServicesFeature();
