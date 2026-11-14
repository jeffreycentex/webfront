import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Server configuration from environment variables, validated once at startup.
 *
 * | Variable        | Default                     | Notes                                            |
 * |-----------------|-----------------------------|--------------------------------------------------|
 * | NODE_ENV        | development                 | development, production or test                  |
 * | HOST            | 127.0.0.1                   | tailscale serve proxies to localhost             |
 * | PORT            | 8787                        |                                                  |
 * | DATA_DIR        | <repo>/data (dev only)      | REQUIRED in production, e.g. /var/lib/webfront   |
 * | PUBLIC_ORIGIN   | http://localhost:5173 (dev) | REQUIRED in production, e.g. https://webfront.<tailnet>.ts.net; passkey RP ID is its hostname |
 * | WEB_DIST_DIR    | apps/web/dist               | Built SPA to serve                               |
 * | LOG_LEVEL       | info (debug in dev)         | debug, info, warn, error                         |
 * | TRUST_PROXY     | true                        | Use X-Forwarded-For for client IP (rate limits)  |
 */

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '..', '..');

const boolString = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  DATA_DIR: z.string().min(1).optional(),
  PUBLIC_ORIGIN: z.url().optional(),
  WEB_DIST_DIR: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  TRUST_PROXY: boolString.default(true),
});

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Config {
  env: 'development' | 'production' | 'test';
  isProduction: boolean;
  host: string;
  port: number;
  /** Absolute. Holds the SQLite file and attachments. */
  dataDir: string;
  /** Absolute path of the SQLite database file. */
  dbPath: string;
  /** Absolute. Wiki attachments (Task 8). */
  attachmentsDir: string;
  /** Origin the browser uses, without trailing slash. */
  publicOrigin: string;
  /** WebAuthn relying party id: the hostname of publicOrigin. */
  rpId: string;
  rpName: string;
  /** Absolute path of the built web app; may not exist in dev. */
  webDistDir: string;
  logLevel: LogLevel;
  trustProxy: boolean;
  /** Server package version. */
  version: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Invalid environment:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';

  if (isProduction && !e.DATA_DIR) throw new ConfigError('DATA_DIR is required in production');
  if (isProduction && !e.PUBLIC_ORIGIN)
    throw new ConfigError('PUBLIC_ORIGIN is required in production');

  const origin = new URL(e.PUBLIC_ORIGIN ?? 'http://localhost:5173');
  if (isProduction && origin.protocol !== 'https:' && origin.hostname !== 'localhost') {
    throw new ConfigError(
      'PUBLIC_ORIGIN must be https in production (service worker and passkeys need it)',
    );
  }

  const dataDir = path.resolve(e.DATA_DIR ?? path.join(repoRoot, 'data'));
  return {
    env: e.NODE_ENV,
    isProduction,
    host: e.HOST,
    port: e.PORT,
    dataDir,
    dbPath: path.join(dataDir, 'webfront.db'),
    attachmentsDir: path.join(dataDir, 'attachments'),
    publicOrigin: origin.origin,
    rpId: origin.hostname,
    rpName: 'Webfront',
    webDistDir: path.resolve(e.WEB_DIST_DIR ?? path.join(repoRoot, 'apps', 'web', 'dist')),
    logLevel: e.LOG_LEVEL ?? (e.NODE_ENV === 'development' ? 'debug' : 'info'),
    trustProxy: e.TRUST_PROXY,
    version: readVersion(),
  };
}
