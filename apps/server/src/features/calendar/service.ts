import { createHash } from 'node:crypto';
import { CALENDAR_REFRESH_MINUTES, calendarEventFields, type RecordOf } from '@webfront/shared';
import type { AppContext } from '../../context.js';
import type { Logger } from '../../logger.js';
import { expandIcs } from './expand.js';
import { fetchFeed, FeedFetchError, type FeedFetchOptions, type FetchFn } from './fetchFeed.js';

/**
 * Calendar sync service. Keeps the server-owned `calendarEvents` collection in step with the
 * client-writable `calendarFeeds`:
 * - `reconcile()` reacts to feed changes (new, URL changed, disabled, deleted);
 * - `refreshAll()` runs on a jittered 15 minute timer;
 * - `refreshFeed(id)` backs the manual refresh endpoints.
 * Feed URLs are never logged and never appear in errors; log lines only carry feed ids.
 */

export interface RefreshResult {
  feedId: string;
  ok: boolean;
  /** Present when ok is false; safe to show to the user. */
  error: string | null;
  /** Live occurrences stored for the feed after the refresh. */
  events: number;
  /** Occurrence records written or tombstoned. */
  written: number;
  /** The feed was skipped (disabled or deleted). */
  skipped?: boolean;
}

export interface CalendarServiceOptions {
  ctx: AppContext;
  fetch?: FetchFn;
  now?: () => Date;
  logger?: Logger;
  fetchOptions?: Pick<FeedFetchOptions, 'timeoutMs' | 'maxBytes' | 'maxRedirects'>;
}

interface StateRow {
  feed_id: string;
  url_hash: string;
  etag: string | null;
  last_modified: string | null;
  body: string | null;
  updated_at: string;
}

const BATCH = 400;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function createCalendarService(options: CalendarServiceOptions) {
  const { ctx } = options;
  const log = (options.logger ?? ctx.logger).child({ component: 'calendar' });
  const now = options.now ?? (() => new Date());
  const inflight = new Map<string, Promise<RefreshResult>>();
  const background = new Set<Promise<unknown>>();

  const getState = (feedId: string) =>
    ctx.db.get<StateRow>('SELECT * FROM calendar_feed_state WHERE feed_id = ?', feedId);
  const putState = (row: Omit<StateRow, 'updated_at'>) =>
    ctx.db.run(
      `INSERT INTO calendar_feed_state (feed_id, url_hash, etag, last_modified, body, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(feed_id) DO UPDATE SET url_hash = excluded.url_hash, etag = excluded.etag,
         last_modified = excluded.last_modified, body = excluded.body, updated_at = excluded.updated_at`,
      row.feed_id,
      row.url_hash,
      row.etag,
      row.last_modified,
      row.body,
      now().toISOString(),
    );
  const dropState = (feedId: string) =>
    ctx.db.run('DELETE FROM calendar_feed_state WHERE feed_id = ?', feedId);

  const liveEvents = (feedId: string): RecordOf<'calendarEvents'>[] =>
    ctx.records.list('calendarEvents').filter((e) => e.feedId === feedId);

  /** Tombstone every live occurrence of a feed. Returns how many were removed. */
  function removeEvents(feedId: string): number {
    const ids = liveEvents(feedId).map((e) => e.id);
    for (let i = 0; i < ids.length; i += BATCH) {
      ctx.records.writeAsServer(
        'calendarEvents',
        ids.slice(i, i + BATCH).map((id) => ({ id, fields: { deleted: true } })),
      );
    }
    return ids.length;
  }

  function setFeedStatus(
    feedId: string,
    fields: { lastFetchedAt?: string; lastError: string | null; eventCount?: number },
  ) {
    try {
      ctx.records.writeAsServer('calendarFeeds', [{ id: feedId, fields }]);
    } catch (err) {
      log.warn('could not write feed status', { feedId, err });
    }
  }

  /** Diff the expanded occurrences against what is stored; write only differences. */
  function applyOccurrences(
    feedId: string,
    expanded: ReturnType<typeof expandIcs>['events'],
  ): { written: number; count: number } {
    const existing = new Map(liveEvents(feedId).map((e) => [e.id, e]));
    const writes: Array<{ id: string; fields: Record<string, unknown> }> = [];
    const keep = new Set<string>();
    let count = 0;
    for (const ev of expanded) {
      const parsed = calendarEventFields.safeParse(ev.fields);
      if (!parsed.success) continue;
      keep.add(ev.id);
      count++;
      const prev = existing.get(ev.id) as Record<string, unknown> | undefined;
      const next = parsed.data as Record<string, unknown>;
      if (prev && Object.keys(next).every((k) => prev[k] === next[k])) continue;
      writes.push({ id: ev.id, fields: { ...next, deleted: false } });
    }
    for (const id of existing.keys()) {
      if (!keep.has(id)) writes.push({ id, fields: { deleted: true } });
    }
    for (let i = 0; i < writes.length; i += BATCH) {
      ctx.records.writeAsServer('calendarEvents', writes.slice(i, i + BATCH) as never);
    }
    return { written: writes.length, count };
  }

  async function doRefresh(feedId: string): Promise<RefreshResult> {
    const feed = ctx.records.get('calendarFeeds', feedId);
    if (!feed || feed.deleted) {
      const removed = removeEvents(feedId);
      dropState(feedId);
      return { feedId, ok: true, error: null, events: 0, written: removed, skipped: true };
    }
    if (!feed.enabled) {
      const removed = removeEvents(feedId);
      dropState(feedId);
      setFeedStatus(feedId, { lastError: null, eventCount: 0 });
      return { feedId, ok: true, error: null, events: 0, written: removed, skipped: true };
    }

    const urlHash = sha(feed.url);
    const state = getState(feedId);
    const sameUrl = state?.url_hash === urlHash;
    const conditional = sameUrl && state?.body ? state : null;

    try {
      const res = await fetchFeed(feed.url, {
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...options.fetchOptions,
        etag: conditional?.etag ?? null,
        lastModified: conditional?.last_modified ?? null,
      });
      let body: string;
      let etag: string | null;
      let lastModified: string | null;
      if (res.status === 'not_modified') {
        if (!conditional?.body) throw new FeedFetchError('Unexpected empty response');
        ({ body, etag, last_modified: lastModified } = conditional);
      } else {
        ({ body, etag, lastModified } = res);
      }

      let expanded;
      try {
        expanded = expandIcs(body, { feedId, now: now() });
      } catch {
        throw new FeedFetchError('The calendar file could not be parsed');
      }
      const { written, count } = applyOccurrences(feedId, expanded.events);
      putState({
        feed_id: feedId,
        url_hash: urlHash,
        etag,
        last_modified: lastModified,
        body,
      });
      setFeedStatus(feedId, {
        lastFetchedAt: now().toISOString(),
        lastError: null,
        eventCount: count,
      });
      log.info('feed refreshed', {
        feedId,
        events: count,
        written,
        skipped: expanded.skipped,
        truncated: expanded.truncated,
        notModified: res.status === 'not_modified',
      });
      return { feedId, ok: true, error: null, events: count, written };
    } catch (err) {
      const message =
        err instanceof FeedFetchError ? err.message : 'The calendar could not be refreshed';
      if (!(err instanceof FeedFetchError)) log.error('feed refresh failed', { feedId });
      else log.warn('feed fetch failed', { feedId, reason: message });
      // Remember the URL so reconcile() does not retry in a loop; the timer retries.
      if (!sameUrl) {
        putState({
          feed_id: feedId,
          url_hash: urlHash,
          etag: null,
          last_modified: null,
          body: null,
        });
      }
      setFeedStatus(feedId, { lastError: message.slice(0, 1000) });
      return { feedId, ok: false, error: message, events: liveEvents(feedId).length, written: 0 };
    }
  }

  function refreshFeed(feedId: string): Promise<RefreshResult> {
    const running = inflight.get(feedId);
    if (running) return running;
    const p = doRefresh(feedId).finally(() => inflight.delete(feedId));
    inflight.set(feedId, p);
    return p;
  }

  async function refreshAll(): Promise<RefreshResult[]> {
    const feeds = ctx.records.list('calendarFeeds').filter((f) => f.enabled);
    const results: RefreshResult[] = [];
    for (const f of feeds) results.push(await refreshFeed(f.id));
    return results;
  }

  /**
   * Bring stored state in line with the feed list: fetch new or re-pointed feeds, drop events of
   * disabled or deleted feeds, and drop events whose feed no longer exists. Idempotent.
   */
  async function reconcile(): Promise<void> {
    const feeds = ctx.records.list('calendarFeeds', { includeDeleted: true });
    const active = new Set<string>();
    const todo: string[] = [];
    for (const f of feeds) {
      if (f.deleted || !f.enabled) continue;
      active.add(f.id);
      const state = getState(f.id);
      if (!state || state.url_hash !== sha(f.url)) todo.push(f.id);
    }
    const stale = new Set<string>();
    for (const e of ctx.records.list('calendarEvents')) {
      if (!active.has(e.feedId)) stale.add(e.feedId);
    }
    for (const row of ctx.db.all<{ feed_id: string }>('SELECT feed_id FROM calendar_feed_state')) {
      if (!active.has(row.feed_id)) stale.add(row.feed_id);
    }
    for (const id of stale) {
      removeEvents(id);
      dropState(id);
      // A disabled (not deleted) feed shows no stale count.
      const f = feeds.find((x) => x.id === id);
      if (f && !f.deleted && f.eventCount !== 0)
        setFeedStatus(id, { lastError: f.lastError, eventCount: 0 });
    }
    for (const id of todo) await refreshFeed(id);
  }

  /** Fire-and-forget helper that tracks the promise so tests can await `settled()`. */
  function track(p: Promise<unknown>) {
    const q = p
      .catch((err: unknown) => log.error('calendar task failed', { err }))
      .finally(() => background.delete(q));
    background.add(q);
  }

  async function settled(): Promise<void> {
    while (background.size > 0 || inflight.size > 0) {
      await Promise.allSettled([...background, ...inflight.values()]);
    }
  }

  /** Wire timers and the `records.changed` listener. Returns a stop function. */
  function start(opts: { startDelayMs?: number; reconcileDelayMs?: number } = {}): () => void {
    const reconcileDelay = opts.reconcileDelayMs ?? 250;
    let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
    let tickTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const scheduleReconcile = () => {
      if (stopped || reconcileTimer) return;
      reconcileTimer = setTimeout(() => {
        reconcileTimer = null;
        track(reconcile());
      }, reconcileDelay);
    };

    const off = ctx.events.on('records.changed', (p) => {
      if (p.collections.includes('calendarFeeds')) scheduleReconcile();
    });

    const periodMs = CALENDAR_REFRESH_MINUTES * 60_000;
    const scheduleTick = (delay: number) => {
      if (stopped) return;
      tickTimer = setTimeout(() => {
        track(
          (async () => {
            const feeds = ctx.records.list('calendarFeeds').filter((f) => f.enabled);
            for (const f of feeds) {
              // Stagger feeds by up to 20 seconds so they never fire in one burst.
              await new Promise((r) => setTimeout(r, Math.random() * 20_000));
              if (stopped) return;
              await refreshFeed(f.id);
            }
          })(),
        );
        scheduleTick(periodMs * (0.9 + Math.random() * 0.2));
      }, delay);
      tickTimer.unref?.();
    };

    // First pass shortly after boot: fetch anything new or stale, then settle into the cycle.
    const boot = setTimeout(() => {
      track(
        reconcile().then(async () => {
          const feeds = ctx.records.list('calendarFeeds').filter((f) => f.enabled);
          const cutoff = now().getTime() - periodMs;
          for (const f of feeds) {
            const last = f.lastFetchedAt ? Date.parse(f.lastFetchedAt) : 0;
            if (last < cutoff) await refreshFeed(f.id);
          }
        }),
      );
    }, opts.startDelayMs ?? 3000);
    boot.unref?.();
    scheduleTick(periodMs * (0.9 + Math.random() * 0.2));

    return () => {
      stopped = true;
      off();
      clearTimeout(boot);
      if (reconcileTimer) clearTimeout(reconcileTimer);
      if (tickTimer) clearTimeout(tickTimer);
    };
  }

  return { refreshFeed, refreshAll, reconcile, start, settled };
}

export type CalendarService = ReturnType<typeof createCalendarService>;
