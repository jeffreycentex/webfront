import { pageTitleResponseSchema } from '@webfront/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import type { App, AppContext, AppEnv } from '../../context.js';
import { badRequest, notFound } from '../../http/errors.js';
import { parseQuery } from '../../http/validate.js';
import { httpGet, parseHttpUrl, type HttpGet } from './httpClient.js';
import { findIcon, findTitle, type FoundIcon } from './icons.js';

/**
 * Feature: favicons — owner: Task 5.
 *
 * GET /api/favicons?url=<page url>        the site's icon (cached in SQLite per origin), or 404
 * GET /api/favicons/title?url=<page url>  { title } for quick-add
 *
 * Icons are sniffed (never trusted by Content-Type) and served with `nosniff` and
 * `Content-Security-Policy: sandbox` so even an SVG cannot run script.
 */

export const ICON_TTL_MS = 7 * 24 * 3600_000;
export const MISS_TTL_MS = 24 * 3600_000;
const MAX_CONCURRENT_FETCHES = 6;

export interface FaviconsFeatureOptions {
  httpGet?: HttpGet;
  now?: () => number;
}

const urlQuery = z.object({ url: z.string().min(1).max(2048) });

interface CacheRow {
  content_type: string | null;
  data: Uint8Array | null;
  expires_at: number;
}

export function createFaviconsFeature(options: FaviconsFeatureOptions = {}) {
  return (app: App, ctx: AppContext): void => {
    const get = options.httpGet ?? httpGet;
    const now = options.now ?? Date.now;
    const log = ctx.logger.child({ feature: 'favicons' });

    // Concurrency limit for outbound fetches, plus de-duplication of identical in-flight work.
    let active = 0;
    const waiting: Array<() => void> = [];
    const limited = async <T>(fn: () => Promise<T>): Promise<T> => {
      if (active >= MAX_CONCURRENT_FETCHES) await new Promise<void>((r) => waiting.push(r));
      active++;
      try {
        return await fn();
      } finally {
        active--;
        waiting.shift()?.();
      }
    };
    const inflight = new Map<string, Promise<FoundIcon | null>>();

    const prune = () => {
      try {
        ctx.db.run('DELETE FROM favicon_cache WHERE expires_at < ?', now() - 30 * 24 * 3600_000);
      } catch (err) {
        log.warn('favicon cache prune failed', { err });
      }
    };
    prune();
    const timer = setInterval(prune, 24 * 3600_000);
    timer.unref?.();
    ctx.onClose(() => clearInterval(timer));

    async function lookup(origin: string, pageUrl: string): Promise<FoundIcon | null> {
      const row = ctx.db.get<CacheRow>(
        'SELECT content_type, data, expires_at FROM favicon_cache WHERE origin = ?',
        origin,
      );
      if (row && row.expires_at > now()) {
        if (!row.data || !row.content_type) return null;
        return {
          contentType: row.content_type as FoundIcon['contentType'],
          data: Buffer.from(row.data),
        };
      }
      let p = inflight.get(origin);
      if (!p) {
        p = limited(() => findIcon(pageUrl, { httpGet: get }))
          .catch((err: unknown) => {
            log.debug('favicon fetch failed', { origin, err });
            return null;
          })
          .then((found) => {
            const t = now();
            ctx.db.run(
              `INSERT INTO favicon_cache (origin, content_type, data, fetched_at, expires_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(origin) DO UPDATE SET content_type = excluded.content_type,
                 data = excluded.data, fetched_at = excluded.fetched_at,
                 expires_at = excluded.expires_at`,
              origin,
              found?.contentType ?? null,
              found ? new Uint8Array(found.data) : null,
              t,
              t + (found ? ICON_TTL_MS : MISS_TTL_MS),
            );
            return found;
          })
          .finally(() => inflight.delete(origin));
        inflight.set(origin, p);
      }
      return p;
    }

    const r = new Hono<AppEnv>();

    r.get('/title', ctx.requireAuth, async (c) => {
      const { url } = parseQuery(c, urlQuery);
      let page: URL;
      try {
        page = parseHttpUrl(url);
      } catch (err) {
        throw badRequest(err instanceof Error ? err.message : 'Invalid URL');
      }
      let title: string | null = null;
      try {
        title = await limited(() => findTitle(page.href, { httpGet: get }));
      } catch {
        title = null;
      }
      c.header('Cache-Control', 'no-store');
      return c.json(pageTitleResponseSchema.parse({ title }));
    });

    r.get('/', ctx.requireAuth, async (c) => {
      const { url } = parseQuery(c, urlQuery);
      let page: URL;
      try {
        page = parseHttpUrl(url);
      } catch (err) {
        throw badRequest(err instanceof Error ? err.message : 'Invalid URL');
      }
      const found = await lookup(page.origin, page.href);
      if (!found) {
        c.header('Cache-Control', 'private, max-age=3600');
        throw notFound('No icon');
      }
      return new Response(new Uint8Array(found.data), {
        status: 200,
        headers: {
          'content-type': found.contentType,
          'content-length': String(found.data.length),
          'cache-control': 'private, max-age=604800, immutable',
          'x-content-type-options': 'nosniff',
          'content-security-policy': 'sandbox',
          'cross-origin-resource-policy': 'same-origin',
        },
      });
    });

    app.route('/api/favicons', r);
  };
}

export const register = createFaviconsFeature();
