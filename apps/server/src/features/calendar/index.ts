import { z } from 'zod';
import { Hono } from 'hono';
import type { App, AppContext, AppEnv } from '../../context.js';
import { notFound } from '../../http/errors.js';
import { parseParams } from '../../http/validate.js';
import type { FetchFn } from './fetchFeed.js';
import { createCalendarService, type CalendarService, type RefreshResult } from './service.js';

/**
 * Feature: calendar — owner: Task 9.
 *
 * Watches the client-writable `calendarFeeds` collection and keeps the server-owned
 * `calendarEvents` collection current (see service.ts). Routes under /api/calendar:
 * - POST /refresh              refetch every enabled feed now
 * - POST /feeds/:id/refresh    refetch one feed now
 * Both answer `{ ok, results: [{ feedId, ok, error, events, written }] }`, where `error` is a
 * short message that never contains the feed URL. Per-feed status (lastFetchedAt, lastError,
 * eventCount) is also stored on the synced feed record so offline clients can show it.
 */

export interface CalendarFeatureOptions {
  /** Injected for tests; defaults to global fetch. */
  fetch?: FetchFn;
  now?: () => Date;
  /** Start the boot pass and the 15 minute timer. Default: everywhere except NODE_ENV=test. */
  autoStart?: boolean;
  /** Receives the service (tests). */
  onService?: (service: CalendarService) => void;
}

const idParams = z.object({ id: z.uuid() });

function summarise(results: RefreshResult[]) {
  return { ok: results.every((r) => r.ok), results };
}

export function createCalendarFeature(options: CalendarFeatureOptions = {}) {
  return (app: App, ctx: AppContext): void => {
    const service = createCalendarService({
      ctx,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    options.onService?.(service);

    const r = new Hono<AppEnv>();
    r.use('*', async (c, next) => {
      await next();
      c.header('Cache-Control', 'no-store');
    });

    r.post('/refresh', ctx.requireAuth, async (c) => c.json(summarise(await service.refreshAll())));

    r.post('/feeds/:id/refresh', ctx.requireAuth, async (c) => {
      const { id } = parseParams(c, idParams);
      const feed = ctx.records.get('calendarFeeds', id);
      if (!feed || feed.deleted) throw notFound('Feed not found');
      return c.json(summarise([await service.refreshFeed(id)]));
    });

    app.route('/api/calendar', r);

    if (options.autoStart ?? ctx.config.env !== 'test') {
      const stop = service.start();
      ctx.onClose(stop);
    }
  };
}

export const register = createCalendarFeature();
