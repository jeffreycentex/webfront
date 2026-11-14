import {
  SYNC_EVENT,
  pullQuerySchema,
  pushRequestSchema,
  type PullResponse,
  type PushResponse,
  type SyncChangedEvent,
  type SyncHelloEvent,
} from '@webfront/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import type { App, AppContext, AppEnv } from '../../context.js';
import { AppError } from '../../http/errors.js';
import { parseJson, parseQuery } from '../../http/validate.js';
import { createRecordStore } from './store.js';

/**
 * Feature: sync — owner: Task 3 (sync engine).
 *
 * Installs the RecordStore (store.ts) and mounts under /api/sync (protocol in
 * packages/shared/src/api/sync.ts):
 * - POST /push  field-level changes, merged per-field LWW; per-change applied/unchanged/rejected
 * - GET  /pull  full records with seq > since, in seq order
 * - GET  /events SSE: `hello`, then `changed` pokes; `: ping` heartbeats
 */

export const SSE_HEARTBEAT_MS = 25_000;
/**
 * Largest accepted push body. Clients batch to ~4 MB, but a single change is always sent on
 * its own, and one wiki body (2M chars) plus its conflict copy can approach 24 MB as JSON.
 */
export const MAX_PUSH_BODY_BYTES = 32 * 1024 * 1024;

export interface SyncFeatureOptions {
  /** Heartbeat interval (tests). */
  heartbeatMs?: number;
  /** Clock source for the record store (tests). */
  now?: () => number;
}

export function createSyncFeature(options: SyncFeatureOptions = {}) {
  return (app: App, ctx: AppContext): void => {
    const log = ctx.logger.child({ feature: 'sync' });
    ctx.installRecordStore(
      createRecordStore({
        db: ctx.db,
        events: ctx.events,
        logger: log,
        ...(options.now ? { now: options.now } : {}),
      }),
    );

    const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_MS;
    const openStreams = new Set<() => void>();
    ctx.onClose(() => {
      for (const close of [...openStreams]) close();
    });

    const r = new Hono<AppEnv>();
    r.use('*', async (c, next) => {
      await next();
      c.header('Cache-Control', 'no-store');
    });

    r.post(
      '/push',
      ctx.requireAuth,
      bodyLimit({
        maxSize: MAX_PUSH_BODY_BYTES,
        onError: () => {
          throw new AppError(413, 'payload_too_large', 'Push body too large');
        },
      }),
      async (c) => {
        const body = await parseJson(c, pushRequestSchema);
        const results = ctx.records.applyChanges(body.changes, body.clientId);
        const res: PushResponse = {
          serverId: ctx.records.serverId(),
          results,
          maxSeq: ctx.records.maxSeq(),
        };
        return c.json(res);
      },
    );

    r.get('/pull', ctx.requireAuth, (c) => {
      const { since, limit } = parseQuery(c, pullQuerySchema);
      const page = ctx.records.pull(since, limit);
      const res: PullResponse = { serverId: ctx.records.serverId(), ...page };
      return c.json(res);
    });

    r.get('/events', ctx.requireAuth, (c) => {
      const sessionId = c.get('session')?.sessionId ?? null;
      c.header('X-Accel-Buffering', 'no');
      return streamSSE(c, async (stream) => {
        let closed = false;
        let finish!: () => void;
        const done = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const cleanups: Array<() => void> = [];
        const close = () => {
          if (closed) return;
          closed = true;
          for (const fn of cleanups.splice(0)) fn();
          openStreams.delete(close);
          finish();
        };
        openStreams.add(close);
        stream.onAbort(close);

        // Subscribe before writing hello (no await in between), so no change can slip
        // between the hello's maxSeq and the first poke.
        cleanups.push(
          ctx.events.on('records.changed', (p) => {
            if (closed) return;
            const data: SyncChangedEvent = { maxSeq: p.maxSeq, originClientId: p.originClientId };
            void stream.writeSSE({ event: SYNC_EVENT.changed, data: JSON.stringify(data) });
          }),
        );
        cleanups.push(
          ctx.events.on('session.revoked', (p) => {
            if (p.sessionId === sessionId) close();
          }),
        );
        const timer = setInterval(() => {
          if (!closed) void stream.write(': ping\n\n');
        }, heartbeatMs);
        cleanups.push(() => clearInterval(timer));

        const hello: SyncHelloEvent = {
          serverId: ctx.records.serverId(),
          maxSeq: ctx.records.maxSeq(),
        };
        void stream.writeSSE({ event: SYNC_EVENT.hello, data: JSON.stringify(hello) });

        await done; // returning closes the stream
      });
    });

    app.route('/api/sync', r);
  };
}

export const register = createSyncFeature();
