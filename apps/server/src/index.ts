import { mkdirSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createContext } from './context.js';
import { openDatabase } from './db/database.js';
import { runMigrations } from './db/migrate.js';
import { createLogger } from './logger.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger({ level: config.logLevel });
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(config.attachmentsDir, { recursive: true });

  const db = openDatabase(config.dbPath);
  runMigrations(db, logger);

  const ctx = createContext({ config, db, logger });
  const app = await createApp(ctx);

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    logger.info('listening', {
      host: info.address,
      port: info.port,
      env: config.env,
      version: config.version,
    });
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    // Feature hooks first so open SSE streams end and the server can close.
    await ctx.close();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  process.stderr.write(
    `Fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
