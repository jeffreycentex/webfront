import { describe, expect, it, vi } from 'vitest';
import { createTestApp } from '../../../test/helpers.js';
import { register as syncRegister } from '../sync/index.js';
import { createFaviconsFeature } from './index.js';
import { HttpClientError, parseHttpUrl, type HttpGet, type HttpResult } from './httpClient.js';
import { extractIconLinks, extractTitle, sniffImage } from './icons.js';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(40, 1),
]);

function res(partial: Partial<HttpResult> & { url: string }): HttpResult {
  return {
    status: 200,
    headers: {},
    body: Buffer.alloc(0),
    truncated: false,
    redirects: 0,
    ...partial,
  };
}

async function setup(httpGet: HttpGet, now = () => 1_000_000) {
  return createTestApp({
    signedIn: true,
    features: [
      { name: 'sync', register: syncRegister },
      { name: 'favicons', register: createFaviconsFeature({ httpGet, now }) },
    ],
  });
}

describe('icon parsing', () => {
  it('finds and ranks icon links, resolving relative URLs', () => {
    const html = `<html><head>
      <link rel="apple-touch-icon" href="/apple.png" sizes="180x180">
      <link rel="shortcut icon" href="fav.ico">
      <link rel="icon" type="image/svg+xml" href="https://cdn.example.com/i.svg">
      <link rel="stylesheet" href="/x.css">
      <link rel="icon" href="data:image/png;base64,AAAA">
    </head></html>`;
    const urls = extractIconLinks(html, 'https://example.com/a/b').map((c) => c.url);
    expect(urls).toEqual([
      'https://cdn.example.com/i.svg',
      'https://example.com/a/fav.ico',
      'https://example.com/apple.png',
    ]);
  });

  it('sniffs real image types and rejects everything else', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(Buffer.from('<html><body>not an image</body></html>'))).toBeNull();
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe(
      'image/svg+xml',
    );
    expect(
      sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>')),
    ).toBeNull();
    expect(sniffImage(Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0, 0]))).toBe(
      'image/x-icon',
    );
  });

  it('extracts and decodes titles', () => {
    expect(extractTitle('<title>\n Tom &amp; Jerry &#39;s  </title>')).toBe("Tom & Jerry 's");
    expect(extractTitle('<p>none</p>')).toBeNull();
  });

  it('rejects non-http URLs', () => {
    expect(() => parseHttpUrl('file:///etc/passwd')).toThrow(HttpClientError);
    expect(() => parseHttpUrl('ftp://x.test/')).toThrow(HttpClientError);
    expect(parseHttpUrl('https://u:p@x.test/a#f').href).toBe('https://x.test/a');
  });
});

describe('GET /api/favicons', () => {
  it('fetches via the page link, serves hardened headers and caches', async () => {
    const calls: string[] = [];
    const httpGet: HttpGet = async (o) => {
      calls.push(o.url);
      if (o.url === 'https://site.test/') {
        return res({
          url: o.url,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: Buffer.from('<link rel="icon" href="/img/i.png">'),
        });
      }
      if (o.url === 'https://site.test/img/i.png') {
        return res({ url: o.url, headers: { 'content-type': 'text/plain' }, body: PNG });
      }
      return res({ url: o.url, status: 404 });
    };
    const { app } = await setup(httpGet);
    const r1 = await app.request('/api/favicons?url=' + encodeURIComponent('https://site.test/'));
    expect(r1.status).toBe(200);
    expect(r1.headers.get('content-type')).toBe('image/png');
    expect(r1.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r1.headers.get('content-security-policy')).toBe('sandbox');
    expect(r1.headers.get('cache-control')).toContain('max-age=');
    expect(Buffer.from(await r1.arrayBuffer()).equals(PNG)).toBe(true);
    const before = calls.length;
    const r2 = await app.request(
      '/api/favicons?url=' + encodeURIComponent('https://site.test/other'),
    );
    expect(r2.status).toBe(200);
    expect(calls.length).toBe(before); // same origin: served from the cache
  });

  it('falls back to /favicon.ico, ignores HTML posing as an icon, and caches misses', async () => {
    const calls: string[] = [];
    const httpGet: HttpGet = async (o) => {
      calls.push(o.url);
      return res({
        url: o.url,
        headers: { 'content-type': 'image/png' },
        body: Buffer.from('<html>login page</html>'.padEnd(40, ' ')),
      });
    };
    let t = 1_000_000;
    const { app } = await setup(httpGet, () => t);
    const url = '/api/favicons?url=' + encodeURIComponent('https://nope.test/');
    expect((await app.request(url)).status).toBe(404);
    const n = calls.length;
    expect(n).toBeGreaterThan(0);
    expect((await app.request(url)).status).toBe(404);
    expect(calls.length).toBe(n); // negative cache
    t += 25 * 3600_000; // miss TTL elapsed
    expect((await app.request(url)).status).toBe(404);
    expect(calls.length).toBeGreaterThan(n);
  });

  it('never serves truncated or non-200 icon responses', async () => {
    const httpGet: HttpGet = async (o) =>
      o.url.endsWith('favicon.ico')
        ? res({ url: o.url, body: PNG, truncated: true })
        : res({ url: o.url, status: 500 });
    const { app } = await setup(httpGet);
    const r = await app.request('/api/favicons?url=' + encodeURIComponent('https://big.test/'));
    expect(r.status).toBe(404);
  });

  it('rejects bad URLs and requires auth', async () => {
    const httpGet = vi.fn<HttpGet>();
    const { app } = await setup(httpGet);
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'not a url']) {
      const r = await app.request('/api/favicons?url=' + encodeURIComponent(bad));
      expect(r.status).toBe(400);
    }
    expect((await app.request('/api/favicons')).status).toBe(400);
    expect(httpGet).not.toHaveBeenCalled();

    const anon = await createTestApp({
      features: [
        { name: 'sync', register: syncRegister },
        { name: 'favicons', register: createFaviconsFeature({ httpGet }) },
      ],
    });
    expect((await anon.app.request('/api/favicons?url=https%3A%2F%2Fx.test')).status).toBe(401);
  });
});

describe('GET /api/favicons/title', () => {
  it('returns the page title, or null when the page is not HTML', async () => {
    const httpGet: HttpGet = async (o) =>
      o.url.includes('pdf')
        ? res({
            url: o.url,
            headers: { 'content-type': 'application/pdf' },
            body: Buffer.from('x'),
          })
        : res({
            url: o.url,
            headers: { 'content-type': 'text/html' },
            body: Buffer.from('<title>Hello &amp; welcome</title>'),
          });
    const { app } = await setup(httpGet);
    const ok = await app.request(
      '/api/favicons/title?url=' + encodeURIComponent('https://a.test/'),
    );
    expect(await ok.json()).toEqual({ title: 'Hello & welcome' });
    const pdf = await app.request(
      '/api/favicons/title?url=' + encodeURIComponent('https://a.test/pdf'),
    );
    expect(await pdf.json()).toEqual({ title: null });
  });

  it('returns null title when the fetch fails', async () => {
    const httpGet: HttpGet = async () => {
      throw new HttpClientError('timeout', 'Timed out');
    };
    const { app } = await setup(httpGet);
    const r = await app.request('/api/favicons/title?url=' + encodeURIComponent('https://a.test/'));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ title: null });
  });
});
