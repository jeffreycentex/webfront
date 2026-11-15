import {
  DEFAULT_PULL_LIMIT,
  ERROR_CODES,
  MAX_PUSH_CHANGES,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  type SyncChangedEvent,
  type SyncHelloEvent,
} from '@webfront/shared';
import { ApiRequestError, NetworkError } from '@/lib/api';
import { outboxEntryToChange, type LocalStore, type PersistedStatus } from './local';

/**
 * The sync loop for one replica. Runs in at most one tab at a time (see `runtime.ts`).
 *
 * One cycle = push the outbox in batches, then pull pages after the cursor until `hasMore`
 * is false. Each pushed batch is acked field-by-field; each pulled page is merged and the
 * cursor advanced in the same IndexedDB transaction, so a crash or failure mid-cycle resumes
 * from the last durable point and re-sends at most one batch (pushes are idempotent).
 *
 * Triggers: start, local writes (debounced), SSE pokes, `online`, tab visible, a slow
 * backstop timer. Failures back off exponentially with jitter. A 401 halts the loop with
 * state `unauthenticated` (local data and outbox are untouched) until `start()` is called again.
 *
 * Server identity (see `identify`): every response carries the server's `serverId` and
 * `epoch` (restore marker). A mismatch with what this replica knows stops the cycle before
 * anything is pushed or merged, and an identity probe (an empty push) decides:
 * - first contact (nothing known, or an existing replica that knows no epoch yet): adopt it,
 *   keeping local data, unless the server's seq went backwards (then it is a restore);
 * - same database, new epoch (or seq went backwards): the database was restored from a
 *   backup. The restored data is the truth: set the outbox aside, clear local synced data,
 *   pull from 0 (`LocalStore.resetForRestore`). Nothing local is ever pushed onto it;
 * - a different, EMPTY database (fresh install): re-push everything to repopulate it;
 * - a different, non-empty database: treated as a restore as well.
 * Pushes carry the known epoch; the server refuses a stale one with 409 `stale_epoch`, which
 * triggers the same probe.
 */

export interface SyncEventHandlers {
  onHello(event: SyncHelloEvent): void;
  onChanged(event: SyncChangedEvent): void;
  /** The stream failed (it may be retrying on its own). */
  onError(): void;
}

export interface SyncTransport {
  push(request: PushRequest): Promise<PushResponse>;
  pull(since: number, limit: number): Promise<PullResponse>;
  /** Open the server-sent events stream; returns a function that closes it. */
  connectEvents?(clientId: string, handlers: SyncEventHandlers): () => void;
}

export interface SyncEngineOptions {
  pullLimit?: number;
  pushMaxChanges?: number;
  /** Approximate cap on one push body. */
  pushMaxBytes?: number;
  /** Delay after a local write before pushing (coalesces bursts of edits). */
  debounceMs?: number;
  /** Backstop interval between syncs while idle. */
  backstopMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  random?: () => number;
  now?: () => number;
  /** Attach window/document listeners (online, visibilitychange). Default: when available. */
  attachDomListeners?: boolean;
}

/** Back-to-back cycles one run may do when new work keeps arriving. */
const MAX_ROUNDS_PER_RUN = 10;

/** Thrown internally when a response shows another server identity: probe, then retry. */
class ServerChangedError extends Error {}

/** What `identify` concluded about the server. */
export type ServerVerdict = 'same' | 'adopted' | 'restored' | 'fresh';

export type TriggerReason = 'start' | 'write' | 'poke' | 'online' | 'visible' | 'backstop' | 'manual';

export class SyncEngine {
  private readonly o: Required<Omit<SyncEngineOptions, 'attachDomListeners'>> & {
    attachDomListeners: boolean;
  };
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerDue = 0;
  private inFlight: Promise<void> | null = null;
  private again = false;
  private failures = 0;
  private status: PersistedStatus = { state: 'offline', lastSyncedAt: null, error: null };
  private closeEvents: (() => void) | null = null;
  private detachDom: (() => void) | null = null;
  private clientIdCache: string | null = null;
  /** Check the server's identity at the next cycle (set on start and on SSE hello). */
  private verifyServer = true;
  /** A response showed the server's seq behind our cursor: the database went back in time. */
  private suspectRestore = false;

  constructor(
    private readonly local: LocalStore,
    private readonly transport: SyncTransport,
    options: SyncEngineOptions = {},
  ) {
    this.o = {
      pullLimit: options.pullLimit ?? DEFAULT_PULL_LIMIT,
      pushMaxChanges: Math.min(options.pushMaxChanges ?? MAX_PUSH_CHANGES, MAX_PUSH_CHANGES),
      pushMaxBytes: options.pushMaxBytes ?? 4 * 1024 * 1024,
      debounceMs: options.debounceMs ?? 500,
      backstopMs: options.backstopMs ?? 5 * 60_000,
      backoffBaseMs: options.backoffBaseMs ?? 1000,
      backoffMaxMs: options.backoffMaxMs ?? 5 * 60_000,
      random: options.random ?? Math.random,
      now: options.now ?? Date.now,
      attachDomListeners:
        options.attachDomListeners ??
        (typeof window !== 'undefined' && typeof document !== 'undefined'),
    };
  }

  get isRunning(): boolean {
    return this.running;
  }

  get currentStatus(): PersistedStatus {
    return this.status;
  }

  /** Begin syncing (idempotent). Also resumes after `unauthenticated`. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.failures = 0;
    const prev = await this.local.readStatus();
    this.status = { state: 'idle', lastSyncedAt: prev.lastSyncedAt, error: null };
    await this.local.writeStatus(this.status);
    this.clientIdCache = await this.local.clientId();
    this.verifyServer = true;
    this.openEvents();
    this.attachDom();
    this.trigger('start');
  }

  /** Stop syncing: cancel timers, close the event stream and wait for a running cycle. */
  async stop(): Promise<void> {
    this.halt();
    await this.inFlight?.catch(() => undefined);
  }

  /** Run a sync cycle now and wait for it. No-op when not running. */
  async syncNow(): Promise<void> {
    if (!this.running) return;
    await this.run();
  }

  /** Request a sync. Writes are debounced; other reasons run as soon as possible. */
  trigger(reason: TriggerReason): void {
    if (!this.running) return;
    if (this.inFlight) {
      this.again = true;
      return;
    }
    if (reason === 'write') {
      // While backing off after a failure, let the backoff timer pick the write up.
      if (this.failures > 0 && this.timer) return;
      this.schedule(this.o.debounceMs);
    } else {
      this.schedule(0);
    }
  }

  private halt(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.closeEvents?.();
    this.closeEvents = null;
    this.detachDom?.();
    this.detachDom = null;
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    const due = this.o.now() + delayMs;
    if (this.timer && this.timerDue <= due) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerDue = due;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delayMs);
  }

  private backoffDelay(): number {
    const exp = Math.min(this.o.backoffMaxMs, this.o.backoffBaseMs * 2 ** Math.max(0, this.failures - 1));
    // "Equal jitter": half fixed, half random, so retries from many tabs/devices spread out.
    return Math.round(exp / 2 + this.o.random() * (exp / 2));
  }

  private run(): Promise<void> {
    if (this.inFlight) {
      this.again = true;
      return this.inFlight;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const p = (async () => {
      let ok = true;
      let rounds = 0;
      do {
        this.again = false;
        ok = await this.cycleSafely();
      } while (ok && this.again && this.running && ++rounds < MAX_ROUNDS_PER_RUN);
      // Anything still pending after MAX_ROUNDS is picked up by the next scheduled run.
      if (ok && this.again) this.schedule(this.o.debounceMs);
      this.inFlight = null;
      if (!this.running) return;
      this.schedule(ok ? this.o.backstopMs : this.backoffDelay());
    })();
    this.inFlight = p;
    return p;
  }

  private async setStatus(patch: Partial<PersistedStatus>): Promise<void> {
    this.status = { ...this.status, ...patch };
    await this.local.writeStatus(this.status);
  }

  /** One cycle with error classification. Returns false on failure. */
  private async cycleSafely(): Promise<boolean> {
    try {
      await this.setStatus({ state: 'syncing' });
      await this.cycle();
      this.failures = 0;
      await this.setStatus({
        state: 'idle',
        error: null,
        lastSyncedAt: new Date(this.o.now()).toISOString(),
      });
      return true;
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) {
        this.halt();
        await this.setStatus({ state: 'unauthenticated', error: 'Sign in to sync' });
        return false;
      }
      this.failures++;
      if (err instanceof NetworkError) {
        await this.setStatus({ state: 'offline', error: null });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        console.warn('@/data: sync failed', err);
        await this.setStatus({ state: 'error', error: message });
      }
      return false;
    }
  }

  /**
   * Decide what the server's identity means for this replica (see the class comment) and
   * act on it. `cursorBefore` is our cursor read BEFORE the probe was sent: every seq we had
   * pulled then existed on the server, so a server answering `maxSeq < cursorBefore` went back
   * in time (restored without a new epoch, e.g. a manual file copy).
   */
  private async identify(
    server: { serverId: string; epoch?: string | undefined; maxSeq: number },
    cursorBefore: number,
  ): Promise<ServerVerdict> {
    const knownId = await this.local.knownServerId();
    const knownEpoch = await this.local.knownEpoch();
    const regressed = this.suspectRestore || server.maxSeq < cursorBefore;
    this.suspectRestore = false;

    if (knownId === null) {
      // A replica that never synced (new device, or after sign-out): nothing to compare.
      await this.local.rememberServer(server.serverId, server.epoch);
      return 'adopted';
    }
    if (knownId === server.serverId) {
      const epochChanged =
        server.epoch !== undefined && knownEpoch !== null && server.epoch !== knownEpoch;
      if (!epochChanged && !regressed) {
        if (server.epoch !== undefined && knownEpoch === null) {
          // First contact after this client learned about epochs: adopt WITHOUT discarding,
          // so deploying the epoch never costs a device its unsynced edits.
          await this.local.rememberEpoch(server.epoch);
          return 'adopted';
        }
        return 'same';
      }
    } else if (server.maxSeq === 0) {
      console.warn('@/data: new, empty server database; re-pushing this device\'s data');
      await this.local.resetForNewServer(server.serverId, server.epoch);
      return 'fresh';
    }
    console.warn('@/data: the server database was restored; replacing local data with it');
    await this.local.resetForRestore({ serverId: server.serverId, epoch: server.epoch });
    return 'restored';
  }

  /** True when a response's identity differs from what this replica knows. */
  private async identityChanged(serverId: string, epoch: string | undefined): Promise<boolean> {
    const knownId = await this.local.knownServerId();
    if (knownId !== null && knownId !== serverId) return true;
    if (epoch === undefined) return false; // a server that predates epochs
    return (await this.local.knownEpoch()) !== epoch;
  }

  /** Empty push: the server's identity and maxSeq, then `identify`. */
  private async probe(clientId: string): Promise<void> {
    const cursorBefore = await this.local.cursor();
    const res = await this.transport.push({ clientId, changes: [] });
    await this.identify(res, cursorBefore);
  }

  private async cycle(): Promise<void> {
    const clientId = this.clientIdCache ?? (await this.local.clientId());
    for (let attempt = 0; ; attempt++) {
      try {
        if (this.verifyServer) {
          // After start, an SSE (re)connect or an identity mismatch: ask the server who it is
          // before pushing anything, so a restored database is noticed even with nothing to push.
          await this.probe(clientId);
          this.verifyServer = false;
        }
        await this.pushAll(clientId);
        await this.pullAll();
        if ((await this.local.pendingCount()) > 0) this.again = true;
        return;
      } catch (err) {
        if (err instanceof ServerChangedError && attempt < 3) {
          this.verifyServer = true;
          continue;
        }
        throw err;
      }
    }
  }

  private async pushAll(clientId: string): Promise<void> {
    for (;;) {
      if (!this.running) return;
      const batch = await this.local.outboxBatch(this.o.pushMaxChanges, this.o.pushMaxBytes);
      if (batch.length === 0) return;
      const cursorBefore = await this.local.cursor();
      const epoch = await this.local.knownEpoch();
      let res: PushResponse;
      try {
        res = await this.transport.push({
          clientId,
          ...(epoch !== null ? { epoch } : {}),
          changes: batch.map(outboxEntryToChange),
        });
      } catch (err) {
        // The database was restored since we last synced: nothing was applied. Probe.
        if (err instanceof ApiRequestError && err.code === ERROR_CODES.staleEpoch) {
          throw new ServerChangedError();
        }
        throw err;
      }
      // The batch was processed by whichever server answered (it accepted our epoch, or it
      // predates epochs), so ack it before anything else.
      const matched = await this.local.ackPush(batch, res.results);
      if (matched === 0) throw new Error('push response did not match the request');
      if (res.maxSeq < cursorBefore) this.suspectRestore = true;
      if (this.suspectRestore || (await this.identityChanged(res.serverId, res.epoch))) {
        throw new ServerChangedError();
      }
    }
  }

  private async pullAll(): Promise<void> {
    for (;;) {
      if (!this.running) return;
      const since = await this.local.cursor();
      const page = await this.transport.pull(since, this.o.pullLimit);
      // Never merge a page from a server we have not identified (e.g. restored meanwhile).
      if (await this.identityChanged(page.serverId, page.epoch)) throw new ServerChangedError();
      if (page.cursor < since) throw new Error('pull returned a cursor behind the request');
      await this.local.applyPull(page);
      if (!page.hasMore) return;
      if (page.cursor === since) throw new Error('pull made no progress');
    }
  }

  private openEvents(): void {
    if (!this.transport.connectEvents || this.closeEvents) return;
    const clientId = this.clientIdCache;
    if (!clientId) return;
    this.closeEvents = this.transport.connectEvents(clientId, {
      onHello: () => {
        // Verified at the start of the next cycle, never concurrently with one. (The hello's
        // own serverId/epoch are not trusted on their own: the probe asks the server directly.)
        this.verifyServer = true;
        this.trigger('poke');
      },
      onChanged: (e) => {
        if (e.originClientId !== clientId) this.trigger('poke');
      },
      onError: () => {
        // Possibly signed out or offline: a (backoff-respecting) sync attempt finds out.
        if (this.failures === 0) this.schedule(this.o.debounceMs);
      },
    });
  }

  private attachDom(): void {
    if (!this.o.attachDomListeners || this.detachDom) return;
    const onOnline = () => this.trigger('online');
    const onVisible = () => {
      if (document.visibilityState === 'visible') this.trigger('visible');
    };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    this.detachDom = () => {
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }
}
