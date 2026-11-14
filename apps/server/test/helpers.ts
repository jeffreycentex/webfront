import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MiddlewareHandler } from 'hono';
import { createApp, type CreateAppOptions } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createContext, type AppContext, type AppEnv } from '../src/context.js';
import { openDatabase } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrate.js';
import { silentLogger } from '../src/logger.js';

/**
 * Test helpers for every server feature. Uses an in-memory, fully migrated database and a
 * temp data dir. No ports are bound: call `app.request('/api/...')`.
 *
 *   const { app, ctx } = await createTestApp({ features: [{ name: 'sync', register }], signedIn: true });
 *   const res = await app.request('/api/sync/pull?since=0');
 */

export function createTestConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'webfront-test-'));
  const base = loadConfig({
    NODE_ENV: 'test',
    DATA_DIR: dataDir,
    WEB_DIST_DIR: path.join(dataDir, 'no-web'),
  });
  return { ...base, ...overrides };
}

export interface TestContextOptions {
  config?: Partial<Config>;
  /** Install an auth guard that accepts every request as this fake session. */
  signedIn?: boolean;
}

/** Guard used when `signedIn: true`. */
export const allowAllGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('session', { sessionId: 'test-session', username: 'test' });
  await next();
};

export function createTestContext(options: TestContextOptions = {}): AppContext {
  const config = createTestConfig(options.config);
  const db = openDatabase(':memory:');
  runMigrations(db);
  const ctx = createContext({ config, db, logger: silentLogger });
  ctx.onClose(() => db.close());
  if (options.signedIn) ctx.installAuthGuard(allowAllGuard);
  return ctx;
}

export async function createTestApp(options: TestContextOptions & CreateAppOptions = {}) {
  const ctx = createTestContext(options);
  const app = await createApp(ctx, {
    features: options.features ?? [],
    serveWeb: options.serveWeb ?? false,
  });
  return { app, ctx };
}
