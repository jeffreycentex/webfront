import { existsSync } from 'node:fs';
import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { compress } from 'hono/compress';
import type { App, AppEnv } from '../context.js';
import type { Logger } from '../logger.js';

/**
 * Serve the built web app (apps/web/dist) with SPA fallback (Task 4).
 *
 * Caching (the service worker handles offline; these headers keep updates prompt and correct):
 * - `/assets/*` (Vite's content-hashed files) and `workbox-*.js`: `public, max-age=1y, immutable`.
 * - `index.html`, `sw.js`, `registerSW.js`, `manifest.webmanifest`, SPA fallback responses:
 *   `no-cache` (always revalidate), so a new deploy is noticed on the next load / update check.
 * - Icons and other unhashed static files: `public, max-age=1d`.
 *
 * Routing:
 * - An existing file is served as-is with its content type.
 * - A GET for a path that is not a file, not under /api and does not look like a static asset
 *   (see ASSET_EXTENSIONS) returns index.html, so client-side routes survive a reload.
 * - Missing assets (`/assets/x.js`, `/foo.png`) are a real 404, never index.html.
 * Must be registered after all /api routes. Text responses are compressed (not the API: SSE).
 */

const ASSET_EXTENSIONS =
  /\.(?:js|mjs|css|map|json|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|txt|xml|webmanifest)$/i;

const NO_CACHE_FILES = new Set([
  '/index.html',
  '/sw.js',
  '/registerSW.js',
  '/manifest.webmanifest',
  '/manifest.json',
]);

/** Cache-Control value for a static path. Exported for tests. */
export function cacheControlFor(pathname: string): string {
  if (NO_CACHE_FILES.has(pathname)) return 'no-cache';
  if (pathname.startsWith('/assets/') || /^\/workbox-[\w-]+\.js$/.test(pathname)) {
    return 'public, max-age=31536000, immutable';
  }
  if (/\.(?:png|svg|ico|woff2?|jpe?g|webp)$/i.test(pathname)) return 'public, max-age=86400';
  return 'no-cache';
}

/**
 * Content-Security-Policy for the app shell and every other static file.
 *
 * - Scripts: only the app's own files. The build has no inline script (the theme no-flash
 *   snippet is `/theme-init.js`), and with no `'unsafe-inline'` a stored `javascript:` URL can
 *   never run even if something navigates to it.
 * - Styles: `'unsafe-inline'` is required (React `style` props for palette colours, CodeMirror's
 *   injected styles, the small `<style>` in index.html). Style injection is low risk here
 *   because Markdown output is sanitised and `style` attributes are stripped from it.
 * - Images: own files, favicons/attachments from the API, `blob:` (offline wiki images),
 *   `data:` and remote images referenced from wiki pages.
 * - Nothing may frame the app; no plugins; forms and `<base>` stay on this origin.
 */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function registerStatic(app: App, webDistDir: string, logger: Logger): void {
  const indexFile = path.join(webDistDir, 'index.html');
  if (!existsSync(indexFile)) {
    logger.warn('web app not built; static serving disabled', { webDistDir });
    return;
  }

  app.use('*', async (c, next) => {
    if (c.req.path.startsWith('/api/')) return next();
    await next();
    try {
      c.res.headers.set('Content-Security-Policy', APP_CSP);
    } catch {
      // Immutable headers: leave as is.
    }
  });

  const compressor = compress();
  app.use('*', async (c, next) => {
    if (c.req.path.startsWith('/api/')) return next();
    return compressor(c, next);
  });

  // Headers must be set before serveStatic builds the response; onNotFound undoes them.
  const serveFile = serveStatic<AppEnv>({
    root: webDistDir,
    onNotFound: (_p, c) => {
      c.header('Cache-Control', undefined);
    },
  });
  app.use('*', async (c, next) => {
    if (c.req.path.startsWith('/api/')) return next();
    c.header('Cache-Control', cacheControlFor(c.req.path));
    return serveFile(c, next);
  });

  const serveIndex = serveStatic<AppEnv>({ root: webDistDir, path: 'index.html' });
  app.get('*', async (c, next) => {
    const p = c.req.path;
    if (p.startsWith('/api/') || p.startsWith('/assets/') || ASSET_EXTENSIONS.test(p))
      return next();
    c.header('Cache-Control', 'no-cache');
    return serveIndex(c, next);
  });
}
