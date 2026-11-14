import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '../logger.js';
import type { Db } from './database.js';

/**
 * Numbered-file SQL migrations in `apps/server/migrations/`, named `NNN_short_name.sql`.
 *
 * - Every file whose number is not yet recorded in `schema_migrations` is applied, in
 *   ascending order, each in its own transaction. Gaps are fine and expected (ranges below).
 *   A file numbered lower than one already applied is still applied, so parallel tasks can
 *   land in any order.
 * - Applied migrations are never edited; add a new file instead.
 * - Do not put BEGIN/COMMIT in migration files.
 *
 * Number ranges are reserved per module so parallel work never collides.
 */
export const MIGRATION_RANGES = {
  core: [1, 9], // Task 1: records, meta
  auth: [10, 19], // Task 2
  sync: [20, 29], // Task 3
  calendar: [30, 39], // Task 9
  services: [40, 49], // Task 5 (service health checker)
  attachments: [50, 59], // Task 8 (wiki attachments)
  favicons: [60, 69], // Task 5 (favicon cache)
  integration: [70, 99], // integrator / later fixes
} as const satisfies Record<string, readonly [number, number]>;

/** Default migrations directory (works from both src/ and dist/). */
export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'migrations',
);

const FILE_PATTERN = /^(\d{3})_([a-z0-9_]+)\.sql$/;

export interface Migration {
  version: number;
  name: string;
  file: string;
  sql: string;
}

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const migrations: Migration[] = [];
  const seen = new Map<number, string>();
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.sql')) continue;
    const m = FILE_PATTERN.exec(file);
    if (!m) throw new Error(`Bad migration file name "${file}" (expected NNN_name.sql)`);
    const version = Number(m[1]);
    if (version === 0) throw new Error(`Migration numbers start at 001 ("${file}")`);
    const dup = seen.get(version);
    if (dup) throw new Error(`Duplicate migration number ${version}: "${dup}" and "${file}"`);
    seen.set(version, file);
    migrations.push({
      version,
      name: m[2]!,
      file,
      sql: readFileSync(path.join(dir, file), 'utf8'),
    });
  }
  return migrations.sort((a, b) => a.version - b.version);
}

export interface MigrationResult {
  applied: number[];
}

export function runMigrations(
  db: Db,
  logger?: Logger,
  dir: string = MIGRATIONS_DIR,
): MigrationResult {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT`);
  const done = new Set(
    db.all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => r.version),
  );
  const applied: number[] = [];
  for (const migration of loadMigrations(dir)) {
    if (done.has(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.run(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    });
    applied.push(migration.version);
    logger?.info('migration applied', { version: migration.version, file: migration.file });
  }
  return { applied };
}
