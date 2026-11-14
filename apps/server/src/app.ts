import { API, type HealthResponse } from '@webfront/shared';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import type { App, AppContext, AppEnv } from './context.js';
import { serverFeatures, type ServerFeature } from './features/index.js';
import { apiNotFound, createErrorHandler } from './http/errors.js';
import { registerStatic } from './http/static.js';

/** CSP for API responses (JSON, SSE) that do not set their own. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";

/**
 * Powerful features the app never uses are switched off. Clipboard and WebAuthn
 * (publickey-credentials-*) keep their default `self` allow-list.
 */
export const PERMISSIONS_POLICY = {
  camera: false,
  microphone: false,
  geolocation: false,
  payment: false,
  usb: false,
  serial: false,
  bluetooth: false,
  hid: false,
  midi: false,
  displayCapture: false,
  browsingTopics: false,
};

export interface CreateAppOptions {
  /** Defaults to the central feature list. Tests may pass a subset or fakes. */
  features?: readonly ServerFeature[];
  /** Serve the built SPA (default true). */
  serveWeb?: boolean;
}

/**
 * Build the Hono app: request id + access log, security headers, structured errors,
 * /api/health, every feature, JSON 404 for unknown /api routes, then the SPA.
 */
export async function createApp(ctx: AppContext, options: CreateAppOptions = {}): Promise<App> {
  const app = new Hono<AppEnv>();
  const log = ctx.logger.child({ component: 'http' });

  app.use('*', async (c, next) => {
    const requestId = crypto.randomUUID();
    c.set('requestId', requestId);
    c.set('session', null);
    c.header('x-request-id', requestId);
    const started = performance.now();
    await next();
    if (c.req.path.startsWith('/api/')) {
      log.debug('request', {
        requestId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(performance.now() - started),
      });
    }
  });
  app.use(
    '*',
    secureHeaders({
      crossOriginEmbedderPolicy: false,
      // Nothing in the app is meant to be framed (CSP frame-ancestors says the same).
      xFrameOptions: 'DENY',
      permissionsPolicy: PERMISSIONS_POLICY,
    }),
  );
  // API responses are data, never documents: lock them down unless a route set its own
  // policy (attachments and favicons send a sandboxing CSP).
  app.use('/api/*', async (c, next) => {
    await next();
    try {
      if (!c.res.headers.has('content-security-policy')) {
        c.res.headers.set('content-security-policy', API_CSP);
      }
    } catch {
      // Immutable headers: leave as is.
    }
  });
  app.onError(createErrorHandler(ctx.logger));

  // Public, registered before any feature middleware.
  app.get(API.health, (c) =>
    c.json<HealthResponse>({
      status: 'ok',
      version: ctx.config.version,
      time: new Date().toISOString(),
    }),
  );

  for (const feature of options.features ?? serverFeatures) {
    await feature.register(app, ctx);
  }

  app.all('/api/*', apiNotFound);
  if (options.serveWeb ?? true) registerStatic(app, ctx.config.webDistDir, ctx.logger);
  app.notFound((c) => c.text('Not found', 404));
  return app;
}
