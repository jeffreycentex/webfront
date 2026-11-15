import 'fake-indexeddb/auto';
import { copyFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { ApiRequestError, NetworkError } from '@/lib/api';
import { createContext, type AppContext, type AppEnv } from '../../../../server/src/context';
import { openDatabase } from '../../../../server/src/db/database';
import { runMigrations } from '../../../../server/src/db/migrate';
import { createSyncFeature } from '../../../../server/src/features/sync/index';
import { createErrorHandler, unauthorized } from '../../../../server/src/http/errors';
import { silentLogger } from '../../../../server/src/logger';
import { createDatabase } from '../db';
import {
  SyncEngine,
  type SyncEngineOptions,
  type SyncEventHandlers,
  type SyncTransport,
} from '../engine';
import { LocalStore } from '../local';
import { createHttpTransport } from '../transport';

/**
 * Test harness: the REAL server sync feature (Hono routes + SQLite RecordStore, in memory)
 * and clients made of a fake-indexeddb Dexie database, a LocalStore and a SyncEngine whose
 * transport is the real HTTP transport (`apiFetch`) with `fetch` routed into the Hono app.
 */

export interface TestServer {
  app: Hono<AppEnv>;
  ctx: AppContext;
  /** When false every sync route answers 401. */
  authed: boolean;
  now: number;
  close(): Promise<void>;
}

/**
 * What `deploy/restore.sh` runs on the restored database before starting the service (keep the
 * two identical): a fresh restore marker, written whether or not the backup already had one.
 */
export const RESTORE_EPOCH_SQL = `INSERT INTO meta (key, value) VALUES ('sync_epoch', lower(hex(randomblob(16)))) ON CONFLICT(key) DO UPDATE SET value = excluded.value;`;

/** "Backup": an online SQLite backup of the server database into a temp file. */
export async function backupServer(server: TestServer): Promise<string> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-backup-'));
  const file = path.join(dir, 'webfront.db');
  await server.ctx.db.backup(file);
  return file;
}

/**
 * "webfront-restore": copy the backup into place, rewrite the epoch exactly as restore.sh does
 * (unless `newEpoch: false`, i.e. a manual file copy) and start a server on it.
 */
export async function restoreServer(
  backupFile: string,
  opts: { now?: number; newEpoch?: boolean } = {},
): Promise<TestServer> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-restore-'));
  const file = path.join(dir, 'webfront.db');
  copyFileSync(backupFile, file);
  if (opts.newEpoch !== false) {
    const db = openDatabase(file);
    db.exec(RESTORE_EPOCH_SQL);
    db.close();
  }
  return createTestServer({ ...opts, file });
}

/** The server's current epoch, read straight from its database. */
export function serverEpoch(server: TestServer): string {
  return server.ctx.db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'sync_epoch'`)!
    .value;
}

export async function createTestServer(
  opts: { now?: number; file?: string } = {},
): Promise<TestServer> {
  const db = openDatabase(opts.file ?? ':memory:');
  runMigrations(db);
  const ctx = createContext({ config: {} as never, db, logger: silentLogger });
  ctx.onClose(() => db.close());
  const server: TestServer = {
    app: new Hono<AppEnv>(),
    ctx,
    authed: true,
    now: opts.now ?? Date.now(),
    close: () => ctx.close(),
  };
  ctx.installAuthGuard(async (c, next) => {
    if (!server.authed) throw unauthorized();
    c.set('session', { sessionId: 'test', username: 'test' });
    await next();
  });
  server.app.onError(createErrorHandler(silentLogger));
  server.app.use('*', async (c, next) => {
    c.set('requestId', 'test');
    c.set('session', null);
    await next();
  });
  createSyncFeature({ now: () => server.now })(server.app, ctx);
  return server;
}

let counter = 0;

export interface TestClient {
  name: string;
  local: LocalStore;
  engine: SyncEngine;
  /** Network switch for this client. */
  online: boolean;
  /** Point the client at another server (e.g. after a restore). */
  server: TestServer;
  /** Fail the next N transport calls of a kind with a network error (after the server ran them, if `afterServer`). */
  failNext: { push: number; pull: number; afterServer: boolean };
  calls: { push: number; pull: number };
  /** Every push request body this client sent (most recent last). */
  pushes: Array<{ epoch?: string | undefined; changes: number }>;
  /** Handlers of the (fake) SSE stream while the engine has it open. */
  sse: SyncEventHandlers | null;
  now: number;
  close(): Promise<void>;
}

export function createTestClient(
  server: TestServer,
  options: SyncEngineOptions & { name?: string; now?: number } = {},
): TestClient {
  const name = options.name ?? `client${++counter}`;
  const db = createDatabase(`test-${name}-${counter}-${Math.random().toString(16).slice(2)}`);
  const client = {
    name,
    online: true,
    server,
    failNext: { push: 0, pull: 0, afterServer: false },
    calls: { push: 0, pull: 0 },
    pushes: [] as TestClient['pushes'],
    sse: null,
    now: options.now ?? server.now,
  } as TestClient;
  const local = new LocalStore(db, { now: () => client.now });
  const http = createHttpTransport();

  const viaServer = async <T>(kind: 'push' | 'pull', run: () => Promise<T>): Promise<T> => {
    client.calls[kind]++;
    if (!client.online) throw new NetworkError(new Error('offline'));
    const fail = client.failNext[kind] > 0;
    if (fail) client.failNext[kind]--;
    if (fail && !client.failNext.afterServer) throw new NetworkError(new Error('injected'));
    const prev = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      client.server.app.request(input as string, init)) as typeof fetch;
    try {
      const result = await run();
      if (fail) throw new NetworkError(new Error('injected: response lost'));
      return result;
    } finally {
      globalThis.fetch = prev;
    }
  };

  const transport: SyncTransport = {
    push: (req) => {
      client.pushes.push({ epoch: req.epoch, changes: req.changes.length });
      return viaServer('push', () => http.push(req));
    },
    pull: (since, limit) => viaServer('pull', () => http.pull(since, limit)),
    connectEvents: (_clientId, handlers) => {
      client.sse = handlers;
      return () => {
        client.sse = null;
      };
    },
  };
  const engine = new SyncEngine(local, transport, {
    attachDomListeners: false,
    debounceMs: 0,
    backstopMs: 3_600_000,
    backoffBaseMs: 3_600_000,
    now: () => client.now,
    ...options,
  });
  client.local = local;
  client.engine = engine;
  client.close = async () => {
    await engine.stop();
    db.close();
  };
  return client;
}

/** Start (if needed) and run one full sync cycle. */
export async function sync(client: TestClient): Promise<void> {
  if (!client.engine.isRunning) await client.engine.start();
  await client.engine.syncNow();
}

export { ApiRequestError, NetworkError };
