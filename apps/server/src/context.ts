import type {
  CollectionName,
  FieldsOf,
  PulledRecord,
  PushResult,
  RecordChange,
  RecordOf,
} from '@webfront/shared';
import type { Hono, MiddlewareHandler } from 'hono';
import type { Config } from './config.js';
import type { Db } from './db/database.js';
import { createEventBus, type EventBus } from './events.js';
import { AppError, unauthorized } from './http/errors.js';
import type { Logger } from './logger.js';

/* -----------------------------------------------------------------------------------------
 * Hono environment
 * --------------------------------------------------------------------------------------- */

/** The signed-in session, set on `c.var.session` by the auth feature's middleware. */
export interface AuthSession {
  sessionId: string;
  username: string;
}

export interface AppEnv {
  Variables: {
    /** Per-request id (also echoed as the `x-request-id` response header). */
    requestId: string;
    /** null until the auth feature's middleware identifies a valid session. */
    session: AuthSession | null;
  };
}

export type App = Hono<AppEnv>;

/* -----------------------------------------------------------------------------------------
 * Record store: server-side access to synced records. Interface fixed here (Task 1);
 * implemented and installed by the sync feature (Task 3). Calendar and services use it to
 * write their server-owned collections.
 * --------------------------------------------------------------------------------------- */

export interface ServerWrite<N extends CollectionName> {
  id: string;
  /** Fields to set. For a new record every field without a default must be present. */
  fields: Partial<FieldsOf<N>> & { deleted?: boolean };
}

export interface RecordStore {
  /** Server database instance id (meta.server_id). */
  serverId(): string;
  /** Highest seq assigned so far. */
  maxSeq(): number;
  /** Validate and merge a client push. Emits `records.changed` if anything was applied. */
  applyChanges(changes: RecordChange[], originClientId: string | null): PushResult[];
  /**
   * Write fields as the server (stamped with the server's HLC), in one transaction.
   * Allowed on any collection, e.g. calendarEvents, or calendarFeeds.lastError.
   * Only fields whose value actually changes get a new stamp; returns how many records changed.
   * Emits one `records.changed` for the batch if anything changed.
   */
  writeAsServer<N extends CollectionName>(collection: N, writes: ServerWrite<N>[]): number;
  get<N extends CollectionName>(collection: N, id: string): RecordOf<N> | undefined;
  /** All records of a collection (live only unless includeDeleted). */
  list<N extends CollectionName>(
    collection: N,
    options?: { includeDeleted?: boolean },
  ): RecordOf<N>[];
  /** Records with seq > since, in seq order. */
  pull(since: number, limit: number): { records: PulledRecord[]; cursor: number; hasMore: boolean };
}

/* -----------------------------------------------------------------------------------------
 * Context handed to every feature's register(app, ctx)
 * --------------------------------------------------------------------------------------- */

export interface AppContext {
  config: Config;
  db: Db;
  logger: Logger;
  events: EventBus;
  /**
   * Middleware for routes that need a signed-in user: `router.get('/x', ctx.requireAuth, h)`.
   * Delegates to the guard installed by the auth feature; until one is installed it rejects
   * every request with 401 (fail closed).
   */
  requireAuth: MiddlewareHandler<AppEnv>;
  /** Auth feature (Task 2) only: install the real guard. */
  installAuthGuard(guard: MiddlewareHandler<AppEnv>): void;
  /** Server-side record access. Throws 501 until the sync feature installs it. */
  records: RecordStore;
  /** Sync feature (Task 3) only: install the record store implementation. */
  installRecordStore(store: RecordStore): void;
  /** Register cleanup (timers, SSE streams) run on shutdown, in reverse order. */
  onClose(fn: () => void | Promise<void>): void;
  /** Run all onClose callbacks (called by the entry point and tests). */
  close(): Promise<void>;
}

export interface CreateContextOptions {
  config: Config;
  db: Db;
  logger: Logger;
}

const notInstalled = (): never => {
  throw new AppError(501, 'not_implemented', 'Record store not installed (sync feature missing)');
};

export function createContext({ config, db, logger }: CreateContextOptions): AppContext {
  let guard: MiddlewareHandler<AppEnv> = async () => {
    throw unauthorized('Authentication is not configured');
  };
  let store: RecordStore | null = null;
  const closers: Array<() => void | Promise<void>> = [];

  const records: RecordStore = {
    serverId: () => (store ?? notInstalled()).serverId(),
    maxSeq: () => (store ?? notInstalled()).maxSeq(),
    applyChanges: (changes, origin) => (store ?? notInstalled()).applyChanges(changes, origin),
    writeAsServer: (collection, writes) =>
      (store ?? notInstalled()).writeAsServer(collection, writes),
    get: (collection, id) => (store ?? notInstalled()).get(collection, id),
    list: (collection, options) => (store ?? notInstalled()).list(collection, options),
    pull: (since, limit) => (store ?? notInstalled()).pull(since, limit),
  };

  return {
    config,
    db,
    logger,
    events: createEventBus(logger),
    requireAuth: (c, next) => guard(c, next),
    installAuthGuard: (g) => {
      guard = g;
    },
    records,
    installRecordStore: (s) => {
      store = s;
    },
    onClose: (fn) => {
      closers.push(fn);
    },
    close: async () => {
      for (const fn of closers.splice(0).reverse()) {
        try {
          await fn();
        } catch (err) {
          logger.error('shutdown hook failed', { err });
        }
      }
    },
  };
}
