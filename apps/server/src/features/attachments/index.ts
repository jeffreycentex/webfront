import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { App, AppContext, AppEnv } from '../../context.js';
import { AppError, notFound } from '../../http/errors.js';
import { parseParams } from '../../http/validate.js';
import { ALLOWED_TYPES, isAllowedType, sniffImageType } from './sniff.js';

/**
 * Feature: attachments — owner: Task 8 (wiki attachments).
 *
 *   POST /api/attachments          raw image bytes as the body (auth + CSRF). Max 10 MB.
 *                                  Type detected from magic bytes (PNG, JPEG, GIF, WebP, AVIF);
 *                                  anything else, SVG included, is rejected with 415.
 *                                  → 201 { id, url, contentType, size } (200 if it existed)
 *   GET  /api/attachments/:id      the bytes, with the stored (allow-listed) type, `nosniff`,
 *                                  `Content-Security-Policy: sandbox` and immutable caching.
 *   POST /api/attachments/cleanup  deletes attachments that no wiki page or revision references
 *                                  (older than a day, so in-flight uploads are safe).
 *
 * Files are content-addressed: id = SHA-256 of the bytes, stored at
 * `<attachmentsDir>/<id[0:2]>/<id>`; metadata is in the `attachments` table (migration 050).
 */

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const CLEANUP_MIN_AGE_MS = 24 * 3_600_000;

export const attachmentIdSchema = z.string().regex(/^[0-9a-f]{64}$/);
const idParams = z.object({ id: attachmentIdSchema });

interface AttachmentRow {
  id: string;
  content_type: string;
  size: number;
  created_at: string;
}

export interface AttachmentInfo {
  id: string;
  url: string;
  contentType: string;
  size: number;
}

function filePath(dir: string, id: string): string {
  return path.join(dir, id.slice(0, 2), id);
}

const ID_IN_TEXT = /\/api\/attachments\/([0-9a-f]{64})/g;

export function register(app: App, ctx: AppContext): void {
  const log = ctx.logger.child({ feature: 'attachments' });
  const dir = ctx.config.attachmentsDir;
  const r = new Hono<AppEnv>();

  r.post(
    '/',
    ctx.requireAuth,
    bodyLimit({
      maxSize: MAX_ATTACHMENT_BYTES,
      onError: () => {
        throw new AppError(413, 'payload_too_large', 'Attachments are limited to 10 MB');
      },
    }),
    async (c) => {
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (bytes.byteLength === 0) throw new AppError(400, 'validation_error', 'Empty upload');
      if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        throw new AppError(413, 'payload_too_large', 'Attachments are limited to 10 MB');
      }
      const type = sniffImageType(bytes);
      if (!type) {
        throw new AppError(
          415,
          'unsupported_media_type',
          `Only ${Object.keys(ALLOWED_TYPES).join(', ')} images are accepted`,
        );
      }
      const id = createHash('sha256').update(bytes).digest('hex');
      const existing = ctx.db.get<AttachmentRow>('SELECT * FROM attachments WHERE id = ?', id);
      const target = filePath(dir, id);
      let fileOk = false;
      if (existing) {
        fileOk = await stat(target).then(
          (s) => s.size === bytes.byteLength,
          () => false,
        );
      }
      if (!fileOk) {
        await mkdir(path.dirname(target), { recursive: true });
        const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(tmp, bytes, { mode: 0o640 });
        await rename(tmp, target);
      }
      if (!existing) {
        ctx.db.run(
          'INSERT OR IGNORE INTO attachments (id, content_type, size, created_at) VALUES (?, ?, ?, ?)',
          id,
          type,
          bytes.byteLength,
          new Date().toISOString(),
        );
        log.info('attachment stored', { id, size: bytes.byteLength, type });
      }
      const body: AttachmentInfo = {
        id,
        url: `/api/attachments/${id}`,
        contentType: type,
        size: bytes.byteLength,
      };
      return c.json(body, existing ? 200 : 201);
    },
  );

  r.get('/:id', ctx.requireAuth, async (c) => {
    const { id } = parseParams(c, idParams);
    const row = ctx.db.get<AttachmentRow>('SELECT * FROM attachments WHERE id = ?', id);
    if (!row || !isAllowedType(row.content_type)) throw notFound('Attachment not found');
    const etag = `"${id}"`;
    const headers: Record<string, string> = {
      'Content-Type': row.content_type,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
      'Cache-Control': 'private, max-age=31536000, immutable',
      'Content-Disposition': `inline; filename="${id.slice(0, 12)}.${ALLOWED_TYPES[row.content_type]}"`,
      'Cross-Origin-Resource-Policy': 'same-origin',
      ETag: etag,
    };
    if (c.req.header('if-none-match') === etag) return c.body(null, 304, headers);
    let data: Buffer;
    try {
      data = await readFile(filePath(dir, id));
    } catch {
      log.warn('attachment file missing', { id });
      throw notFound('Attachment not found');
    }
    return c.body(new Uint8Array(data), 200, {
      ...headers,
      'Content-Length': String(data.byteLength),
    });
  });

  r.post('/cleanup', ctx.requireAuth, async (c) => {
    const referenced = new Set<string>();
    const scan = (text: unknown) => {
      if (typeof text !== 'string' || !text.includes('/api/attachments/')) return;
      for (const m of text.matchAll(ID_IN_TEXT)) referenced.add(m[1]!);
    };
    for (const p of ctx.records.list('wikiPages', { includeDeleted: true })) {
      scan(p.body);
      scan(p.conflict?.body);
    }
    for (const rev of ctx.records.list('wikiRevisions', { includeDeleted: true })) scan(rev.body);
    const cutoff = new Date(Date.now() - CLEANUP_MIN_AGE_MS).toISOString();
    const candidates = ctx.db.all<AttachmentRow>(
      'SELECT * FROM attachments WHERE created_at < ?',
      cutoff,
    );
    let removed = 0;
    for (const row of candidates) {
      if (referenced.has(row.id)) continue;
      ctx.db.run('DELETE FROM attachments WHERE id = ?', row.id);
      await rm(filePath(dir, row.id), { force: true });
      removed++;
    }
    if (removed > 0) log.info('attachments cleaned up', { removed });
    return c.json({ ok: true as const, removed, kept: candidates.length - removed });
  });

  app.route('/api/attachments', r);
}
