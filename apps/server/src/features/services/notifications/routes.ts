import {
  notificationConfigRequestSchema,
  notificationConfigResponseSchema,
  notificationTestResponseSchema,
} from '@webfront/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppContext, AppEnv } from '../../../context.js';
import { AppError } from '../../../http/errors.js';
import { parseJson } from '../../../http/validate.js';
import type { Notifier } from './notifier.js';

/**
 * Notification routes, mounted under /api/services/notifications. All need a session; the
 * global auth middleware already enforces Origin, CSRF and fetch-metadata rules on them.
 * No response ever contains a credential: only `configured`, the last 4 characters and the
 * source.
 */

const MAX_BODY_BYTES = 4 * 1024;

const limit = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: () => {
    throw new AppError(413, 'payload_too_large', 'Request body too large');
  },
});

export function notificationRoutes(ctx: AppContext, notifier: Notifier): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', ctx.requireAuth, limit);

  const view = () => notificationConfigResponseSchema.parse(notifier.view());

  r.get('/', (c) => c.json(view()));

  r.put('/', async (c) => {
    const body = await parseJson(c, notificationConfigRequestSchema);
    notifier.save(body);
    return c.json(view());
  });

  r.delete('/credentials', (c) => {
    notifier.clearCredentials();
    return c.json(view());
  });

  r.post('/test', async (c) => {
    const result = await notifier.sendTest();
    switch (result.kind) {
      case 'ok':
        return c.json(
          notificationTestResponseSchema.parse({
            ok: true,
            sentAt: new Date(result.sentAt).toISOString().replace(/\.\d{3}Z$/, '.000Z'),
          }),
        );
      case 'not_configured':
        throw new AppError(409, 'not_configured', 'Save a Pushover API token and user key first');
      case 'too_soon':
        c.header('Retry-After', String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
        throw new AppError(429, 'rate_limited', 'Wait a few seconds before sending another test');
      case 'rejected':
        throw new AppError(502, 'pushover_rejected', result.error, { status: result.status });
      case 'temporary':
        throw new AppError(502, 'pushover_unavailable', result.error);
    }
  });

  return r;
}
