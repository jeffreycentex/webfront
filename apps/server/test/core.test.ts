import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp } from '../src/app.js';
import { ConfigError, loadConfig } from '../src/config.js';
import type { AppEnv } from '../src/context.js';
import { openDatabase } from '../src/db/database.js';
import { loadMigrations, MIGRATION_RANGES, runMigrations } from '../src/db/migrate.js';
import { recordToRow, rowToRecord, type RecordRow } from '../src/db/recordRows.js';
import { AppError } from '../src/http/errors.js';
import { parseJson } from '../src/http/validate.js';
import { createTestApp, createTestContext } from './helpers.js';

describe('config', () => {
  it('applies dev defaults', () => {
    const c = loadConfig({});
    expect(c.port).toBe(8787);
    expect(c.rpId).toBe('localhost');
    expect(path.isAbsolute(c.dataDir)).toBe(true);
  });

  it('requires DATA_DIR and an https PUBLIC_ORIGIN in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(ConfigError);
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DATA_DIR: '/tmp/x',
        PUBLIC_ORIGIN: 'http://webfront.example.ts.net',
      }),
    ).toThrow(/https/);
    const c = loadConfig({
      NODE_ENV: 'production',
      DATA_DIR: '/var/lib/webfront',
      PUBLIC_ORIGIN: 'https://webfront.example.ts.net/',
      TRUST_PROXY: 'false',
    });
    expect(c.publicOrigin).toBe('https://webfront.example.ts.net');
    expect(c.rpId).toBe('webfront.example.ts.net');
    expect(c.trustProxy).toBe(false);
  });

  it('rejects invalid values', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(ConfigError);
  });
});

describe('database and migrations', () => {
  it('applies the core migration once and seeds meta', () => {
    const db = openDatabase(':memory:');
    expect(runMigrations(db).applied).toContain(1);
    expect(runMigrations(db).applied).toEqual([]);
    const meta = Object.fromEntries(
      db
        .all<{ key: string; value: string }>('SELECT key, value FROM meta')
        .map((r) => [r.key, r.value]),
    );
    expect(meta.records_seq).toBe('0');
    expect(meta.server_id).toMatch(/^[0-9a-f]{32}$/);
    db.close();
  });

  it('applies out-of-order files and rejects bad names and duplicates', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-mig-'));
    writeFileSync(path.join(dir, '001_a.sql'), 'CREATE TABLE a (x INTEGER);');
    writeFileSync(path.join(dir, '030_c.sql'), 'CREATE TABLE c (x INTEGER);');
    const db = openDatabase(':memory:');
    expect(runMigrations(db, undefined, dir).applied).toEqual([1, 30]);
    writeFileSync(path.join(dir, '010_b.sql'), 'CREATE TABLE b (x INTEGER);');
    expect(runMigrations(db, undefined, dir).applied).toEqual([10]);

    writeFileSync(path.join(dir, '010_dup.sql'), 'SELECT 1;');
    expect(() => loadMigrations(dir)).toThrow(/Duplicate/);
    const dir2 = mkdtempSync(path.join(os.tmpdir(), 'wf-mig-'));
    writeFileSync(path.join(dir2, '1_bad.sql'), 'SELECT 1;');
    expect(() => loadMigrations(dir2)).toThrow(/Bad migration/);
    db.close();
  });

  it('rolls back a failing migration', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-mig-'));
    writeFileSync(
      path.join(dir, '001_bad.sql'),
      'CREATE TABLE t (x INTEGER); INSERT INTO nope VALUES (1);',
    );
    const db = openDatabase(':memory:');
    expect(() => runMigrations(db, undefined, dir)).toThrow();
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 't'")).toBeUndefined();
    db.close();
  });

  it('shipped migrations fit the reserved ranges', () => {
    const ranges = Object.values(MIGRATION_RANGES);
    for (const m of loadMigrations()) {
      expect(ranges.some(([lo, hi]) => m.version >= lo && m.version <= hi)).toBe(true);
    }
  });

  it('wrapper converts booleans, supports named params and transactions', () => {
    const db = openDatabase(':memory:');
    db.exec('CREATE TABLE t (a INTEGER, b TEXT) STRICT');
    db.run('INSERT INTO t VALUES (?, ?)', true, 'x');
    db.run('INSERT INTO t VALUES (@a, @b)', { a: false, b: 'y' });
    expect(db.all('SELECT a, b FROM t ORDER BY b')).toEqual([
      { a: 1, b: 'x' },
      { a: 0, b: 'y' },
    ]);
    expect(() =>
      db.transaction(() => {
        db.run('INSERT INTO t VALUES (2, ?)', 'z');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM t')?.n).toBe(2);
    db.close();
  });

  it('round-trips records through the records table', () => {
    const ctx = createTestContext();
    const record = {
      id: '0196f0a2-0000-7000-8000-000000000001',
      createdAt: '2026-11-14T12:00:00.000Z',
      updatedAt: '2026-11-14T12:00:01.000Z',
      deleted: false,
      clocks: { text: '2026-11-14T12:00:01.000Z-0000-aaaaaaaaaaaaaaaa' },
      text: 'hi',
      sortKey: 'a0',
    };
    const row = recordToRow('postits', record, 1);
    ctx.db.run(
      'INSERT INTO records (collection, id, data, clocks, deleted, created_at, updated_at, seq) VALUES (@collection, @id, @data, @clocks, @deleted, @created_at, @updated_at, @seq)',
      { ...row },
    );
    const back = ctx.db.get<RecordRow>(
      'SELECT * FROM records WHERE collection = ? AND id = ?',
      'postits',
      record.id,
    );
    expect(rowToRecord(back!)).toEqual(record);
    void ctx.close();
  });
});

describe('http app', () => {
  it('serves /api/health', async () => {
    const { app } = await createTestApp();
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok' });
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('returns structured JSON errors', async () => {
    const { app } = await createTestApp({
      features: [
        {
          name: 'test',
          register: (a, ctx) => {
            const r = new Hono<AppEnv>();
            r.get('/app-error', () => {
              throw new AppError(409, 'conflict', 'nope', { a: 1 });
            });
            r.get('/crash', () => {
              throw new Error('secret internals');
            });
            r.post('/validate', async (c) =>
              c.json(await parseJson(c, z.object({ n: z.number() }))),
            );
            r.get('/private', ctx.requireAuth, (c) => c.json({ ok: true }));
            a.route('/api/test', r);
          },
        },
      ],
    });

    let res = await app.request('/api/test/app-error');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: { code: 'conflict', message: 'nope', details: { a: 1 } },
    });

    res = await app.request('/api/test/crash');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).not.toContain('secret');

    res = await app.request('/api/test/validate', { method: 'POST', body: '{"n":"x"}' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'validation_error' } });

    res = await app.request('/api/test/validate', { method: 'POST', body: 'not json' });
    expect(res.status).toBe(400);

    // Fails closed until the auth feature installs a guard.
    res = await app.request('/api/test/private');
    expect(res.status).toBe(401);

    res = await app.request('/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('accepts requests once a guard is installed', async () => {
    const { app, ctx } = await createTestApp({
      signedIn: true,
      features: [
        {
          name: 'test',
          register: (a, c) => {
            a.get('/api/me', c.requireAuth, (h) => h.json(h.get('session')));
          },
        },
      ],
    });
    const res = await app.request('/api/me');
    expect(await res.json()).toEqual({ sessionId: 'test-session', username: 'test' });
    expect(() => ctx.records.maxSeq()).toThrow(/not installed/);
  });

  it('serves the SPA with fallback and 404s missing assets', async () => {
    const dist = mkdtempSync(path.join(os.tmpdir(), 'wf-dist-'));
    mkdirSync(path.join(dist, 'assets'));
    writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>wf</title>');
    writeFileSync(path.join(dist, 'assets', 'app-abc.js'), 'console.log(1)');
    const { app } = await createTestApp({ config: { webDistDir: dist }, serveWeb: true });

    let res = await app.request('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>wf</title>');

    res = await app.request('/wiki/some-page');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');

    res = await app.request('/assets/app-abc.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('immutable');

    res = await app.request('/assets/missing.js');
    expect(res.status).toBe(404);

    res = await app.request('/api/missing');
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});

describe('real feature list', () => {
  it('registers all stub features without error', async () => {
    const ctx = createTestContext();
    const app = await createApp(ctx, { serveWeb: false });
    expect((await app.request('/api/health')).status).toBe(200);
    await ctx.close();
  });
});
