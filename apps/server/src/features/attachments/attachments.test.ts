import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../../../test/helpers.js';
import * as sync from '../sync/index.js';
import { MAX_ATTACHMENT_BYTES, register } from './index.js';
import { sniffImageType } from './sniff.js';

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 1,
  2, 3,
]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF = new TextEncoder().encode('GIF89a\x01\x00\x01\x00');
const WEBP = new Uint8Array([
  ...new TextEncoder().encode('RIFF'),
  1,
  0,
  0,
  0,
  ...new TextEncoder().encode('WEBPVP8 '),
]);
const AVIF = new Uint8Array([0, 0, 0, 0x1c, ...new TextEncoder().encode('ftypavif'), 0, 0, 0, 0]);
const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);
const HTML = new TextEncoder().encode('<!doctype html><script>alert(1)</script>');

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function setup(signedIn = true) {
  const t = await createTestApp({
    signedIn,
    features: [
      { name: 'sync', register: sync.register },
      { name: 'attachments', register },
    ],
  });
  cleanups.push(() => t.ctx.close());
  return t;
}

function upload(
  app: Awaited<ReturnType<typeof setup>>['app'],
  bytes: Uint8Array,
  type = 'image/png',
) {
  return app.request('/api/attachments', {
    method: 'POST',
    headers: { 'content-type': type, 'content-length': String(bytes.byteLength) },
    body: bytes,
  });
}

describe('sniffImageType', () => {
  it('detects allow-listed types by magic bytes only', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(GIF)).toBe('image/gif');
    expect(sniffImageType(WEBP)).toBe('image/webp');
    expect(sniffImageType(AVIF)).toBe('image/avif');
    expect(sniffImageType(SVG)).toBeNull();
    expect(sniffImageType(HTML)).toBeNull();
    expect(sniffImageType(new Uint8Array([0x89, 0x50]))).toBeNull();
  });
});

describe('attachments API', () => {
  it('stores an image content-addressed and serves it with safe headers', async () => {
    const { app, ctx } = await setup();
    const res = await upload(app, PNG, 'text/html'); // declared type is ignored
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      url: string;
      contentType: string;
      size: number;
    };
    const sha = createHash('sha256').update(PNG).digest('hex');
    expect(body).toEqual({
      id: sha,
      url: `/api/attachments/${sha}`,
      contentType: 'image/png',
      size: PNG.byteLength,
    });
    expect(existsSync(path.join(ctx.config.attachmentsDir, sha.slice(0, 2), sha))).toBe(true);

    const again = await upload(app, PNG);
    expect(again.status).toBe(200);
    expect(ctx.db.all('SELECT * FROM attachments')).toHaveLength(1);

    const get = await app.request(body.url);
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('image/png');
    expect(get.headers.get('x-content-type-options')).toBe('nosniff');
    expect(get.headers.get('content-security-policy')).toMatch(/^sandbox/);
    expect(get.headers.get('cache-control')).toContain('immutable');
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(PNG);

    const cached = await app.request(body.url, { headers: { 'if-none-match': `"${sha}"` } });
    expect(cached.status).toBe(304);
  });

  it('rejects SVG, HTML and other non-images with 415', async () => {
    const { app, ctx } = await setup();
    for (const [bytes, type] of [
      [SVG, 'image/svg+xml'],
      [HTML, 'image/png'],
      [new TextEncoder().encode('hello'), 'image/jpeg'],
    ] as const) {
      const res = await upload(app, bytes, type);
      expect(res.status).toBe(415);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'unsupported_media_type',
      );
    }
    expect(ctx.db.all('SELECT * FROM attachments')).toHaveLength(0);
  });

  it('rejects empty and oversized uploads', async () => {
    const { app } = await setup();
    expect((await upload(app, new Uint8Array())).status).toBe(400);
    const big = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
    big.set(PNG);
    const res = await upload(app, big);
    expect(res.status).toBe(413);
  });

  it('requires authentication for upload and download', async () => {
    const { app } = await setup(false);
    expect((await upload(app, PNG)).status).toBe(401);
    expect((await app.request(`/api/attachments/${'a'.repeat(64)}`)).status).toBe(401);
  });

  it('validates ids and 404s unknown attachments', async () => {
    const { app } = await setup();
    expect((await app.request('/api/attachments/../../etc/passwd')).status).toBe(404);
    expect((await app.request('/api/attachments/not-an-id')).status).toBe(400);
    expect((await app.request(`/api/attachments/${'b'.repeat(64)}`)).status).toBe(404);
  });

  it('cleanup removes only old unreferenced attachments', async () => {
    const { app, ctx } = await setup();
    const a = (await (await upload(app, PNG)).json()) as { id: string; url: string };
    const b = (await (await upload(app, JPEG)).json()) as { id: string };
    const c = (await (await upload(app, GIF)).json()) as { id: string };
    const old = new Date(Date.now() - 2 * 86_400_000).toISOString();
    ctx.db.run('UPDATE attachments SET created_at = ? WHERE id IN (?, ?)', old, a.id, b.id);
    ctx.records.writeAsServer('wikiPages', [
      {
        id: '019a0000-0000-7000-8000-000000000001',
        fields: { title: 'P', slug: 'p', sortKey: 'a0', body: `![x](${a.url})` },
      },
    ]);
    const res = await app.request('/api/attachments/cleanup', { method: 'POST' });
    expect(await res.json()).toEqual({ ok: true, removed: 1, kept: 1 });
    const ids = ctx.db
      .all<{ id: string }>('SELECT id FROM attachments')
      .map((r) => r.id)
      .sort();
    expect(ids).toEqual([a.id, c.id].sort());
    expect(existsSync(path.join(ctx.config.attachmentsDir, b.id.slice(0, 2), b.id))).toBe(false);
  });
});
