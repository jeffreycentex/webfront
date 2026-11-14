import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Thin SQLite wrapper. Feature code uses only this interface (never the driver directly),
 * so the driver can be swapped (e.g. for `node:sqlite`) in one file.
 *
 * - Statements are prepared once and cached by SQL text.
 * - Parameters: positional (`?`) as rest args, or one object for named (`@name`/`:name`).
 *   Booleans are converted to 1/0 (SQLite has no boolean type). `undefined` is an error.
 * - `transaction(fn)` runs `fn` in BEGIN IMMEDIATE … COMMIT (rolls back on throw). Nesting is
 *   allowed (inner calls become savepoints). `fn` must be synchronous.
 */

export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlParam = SqlValue | boolean;
export type SqlParams = SqlParam[] | [Record<string, SqlParam>];

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Db {
  /** Absolute file path, or ':memory:'. */
  readonly path: string;
  /** Run one or more statements without parameters (DDL, migrations). */
  exec(sql: string): void;
  run(sql: string, ...params: SqlParams): RunResult;
  get<T = Record<string, unknown>>(sql: string, ...params: SqlParams): T | undefined;
  all<T = Record<string, unknown>>(sql: string, ...params: SqlParams): T[];
  /** Iterate rows lazily (large result sets). Do not write to the DB while iterating. */
  iterate<T = Record<string, unknown>>(sql: string, ...params: SqlParams): IterableIterator<T>;
  transaction<T>(fn: () => T): T;
  /** Online backup to another file (used by maintenance tooling). */
  backup(destinationPath: string): Promise<void>;
  close(): void;
}

function convert(params: SqlParams): unknown[] {
  return params.map((p) => {
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p !== null && typeof p === 'object' && !(p instanceof Uint8Array)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(p)) out[k] = typeof v === 'boolean' ? (v ? 1 : 0) : v;
      return out;
    }
    return p;
  });
}

export interface OpenDatabaseOptions {
  /** Open read-only (no pragmas that write). */
  readonly?: boolean;
}

/** Open (creating if needed) the database at `file`, or ':memory:' for tests. */
export function openDatabase(file: string, options: OpenDatabaseOptions = {}): Db {
  const isMemory = file === ':memory:';
  const resolved = isMemory ? file : path.resolve(file);
  if (!isMemory && !options.readonly) mkdirSync(path.dirname(resolved), { recursive: true });

  const sqlite = new Database(resolved, { readonly: options.readonly ?? false });
  if (!options.readonly) {
    if (!isMemory) sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('synchronous = NORMAL');
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('busy_timeout = 5000');
  }

  const cache = new Map<string, Database.Statement>();
  const stmt = (sql: string): Database.Statement => {
    let s = cache.get(sql);
    if (!s) {
      s = sqlite.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };

  return {
    path: resolved,
    exec: (sql) => {
      sqlite.exec(sql);
    },
    run: (sql, ...params) => {
      const r = stmt(sql).run(...convert(params));
      return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
    },
    get: <T>(sql: string, ...params: SqlParams) =>
      stmt(sql).get(...convert(params)) as T | undefined,
    all: <T>(sql: string, ...params: SqlParams) => stmt(sql).all(...convert(params)) as T[],
    iterate: <T>(sql: string, ...params: SqlParams) =>
      stmt(sql).iterate(...convert(params)) as IterableIterator<T>,
    transaction: <T>(fn: () => T): T => sqlite.transaction(fn).immediate(),
    backup: async (destinationPath) => {
      await sqlite.backup(destinationPath);
    },
    close: () => {
      cache.clear();
      sqlite.close();
    },
  };
}
