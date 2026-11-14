import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { App } from '../context.js';
import type { Logger } from '../logger.js';
import { APP_CSP, cacheControlFor, registerStatic } from './static.js';

const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return logger;
  },
};

function build() {
  const dir = mkdtempSync(path.join(tmpdir(), 'wf-static-'));
  mkdirSync(path.join(dir, 'assets'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>app</title>');
  writeFileSync(path.join(dir, 'sw.js'), 'self.skipWaiting');
  writeFileSync(path.join(dir, 'manifest.webmanifest'), '{"name":"Webfront"}');
  writeFileSync(path.join(dir, 'icon-192.png'), 'png');
  writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
  const app = new Hono() as unknown as App;
  app.get('/api/health', (c) => c.json({ ok: true }));
  registerStatic(app, dir, logger);
  app.notFound((c) => c.text('Not found', 404));
  return app;
}

describe('registerStatic', () => {
  const app = build();

  it('serves hashed assets as immutable with the right content type', async () => {
    const res = await app.request('/assets/index-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('content-type')).toMatch(/javascript/);
  });

  it('never caches index.html, sw.js or the manifest', async () => {
    for (const p of ['/', '/index.html', '/sw.js', '/manifest.webmanifest', '/bookmarks']) {
      const res = await app.request(p);
      expect(res.status, p).toBe(200);
      expect(res.headers.get('cache-control'), p).toBe('no-cache');
    }
    const manifest = await app.request('/manifest.webmanifest');
    expect(manifest.headers.get('content-type')).toMatch(/manifest\+json|json/);
    expect((await app.request('/sw.js')).headers.get('content-type')).toMatch(/javascript/);
  });

  it('falls back to index.html for client routes, including dotted slugs', async () => {
    const res = await app.request('/wiki/some-page');
    expect(await res.text()).toContain('<title>app</title>');
    expect((await app.request('/wiki/v1.2-notes')).status).toBe(200);
  });

  it('404s missing assets instead of returning index.html', async () => {
    expect((await app.request('/assets/missing-123.js')).status).toBe(404);
    expect((await app.request('/nope.png')).status).toBe(404);
  });

  it('leaves /api alone', async () => {
    const res = await app.request('/api/health');
    expect(await res.json()).toEqual({ ok: true });
    expect((await app.request('/api/unknown')).status).toBe(404);
  });

  it('sends a CSP without inline script on the shell and static files, not on /api', async () => {
    for (const p of ['/', '/wiki/x', '/assets/index-abc123.js', '/nope.png']) {
      const csp = (await app.request(p)).headers.get('content-security-policy');
      expect(csp, p).toBe(APP_CSP);
    }
    expect(APP_CSP).toMatch(/script-src 'self'(;|$)/);
    expect(APP_CSP).not.toMatch(/script-src[^;]*unsafe/);
    expect(APP_CSP).toContain("frame-ancestors 'none'");
    expect(APP_CSP).toContain("object-src 'none'");
    expect((await app.request('/api/health')).headers.get('content-security-policy')).toBeNull();
  });

  it('does not serve files outside the dist directory', async () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'wf-static-parent-'));
    const dist = path.join(parent, 'dist');
    mkdirSync(path.join(dist, 'assets'), { recursive: true });
    writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>app</title>');
    writeFileSync(path.join(parent, 'secret.json'), '{"secret":true}');
    const a = new Hono() as unknown as App;
    registerStatic(a, dist, logger);
    for (const p of [
      '/../secret.json',
      '/..%2fsecret.json',
      '/assets/..%2f..%2fsecret.json',
      '/%2e%2e/secret.json',
      '/assets/%2e%2e%2f%2e%2e%2fsecret.json',
    ]) {
      const res = await a.request(p);
      expect(await res.text(), p).not.toContain('secret');
    }
  });

  it('gives icons a day of caching', () => {
    expect(cacheControlFor('/icon-192.png')).toBe('public, max-age=86400');
  });
});
