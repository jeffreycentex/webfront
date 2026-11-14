import {
  DEFAULT_PULL_LIMIT,
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

/** Thrown internally when the server's database identity changed mid-cycle. */
class ServerResetError extends Error {}

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
   * Compare the server's identity with what we know. On a change (database replaced), or if
   * the server's seq went backwards (restored from a backup), reset and re-push everything.
   * `seqCheck` pairs the server's maxSeq from a response with our cursor read BEFORE that
   * request was sent: every seq we had pulled then existed on the server, so a correct server
   * always answers maxSeq >= cursor. Anything less means its database went back in time.
   */
  private async checkServer(
    serverId: string,
    seqCheck?: { maxSeq: number; cursorBefore: number },
  ): Promise<boolean> {
    const known = await this.local.knownServerId();
    if (known === null) {
      await this.local.rememberServerId(serverId);
      return false;
    }
    const regressed = seqCheck !== undefined && seqCheck.maxSeq < seqCheck.cursorBefore;
    if (known !== serverId || regressed) {
      console.warn('@/data: server database changed; re-syncing everything');
      await this.local.resetForNewServer(serverId);
      return true;
    }
    return false;
  }

  private async cycle(): Promise<void> {
    const clientId = this.clientIdCache ?? (await this.local.clientId());
    if (this.verifyServer) {
      // After start or an SSE (re)connect, ask the server for its identity and maxSeq with an
      // empty push, so a replaced or restored database is noticed even with nothing to push.
      const cursorBefore = await this.local.cursor();
      const res = await this.transport.push({ clientId, changes: [] });
      await this.checkServer(res.serverId, { maxSeq: res.maxSeq, cursorBefore });
      this.verifyServer = false;
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await this.pushAll(clientId);
        await this.pullAll();
        if ((await this.local.pendingCount()) > 0) this.again = true;
        return;
      } catch (err) {
        // After a reset the outbox holds everything and the cursor is 0: start over once.
        if (err instanceof ServerResetError && attempt < 2) continue;
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
      const res = await this.transport.push({ clientId, changes: batch.map(outboxEntryToChange) });
      // The batch was processed by whichever server answered, so ack it before any reset.
      const reset = await this.checkServer(res.serverId, { maxSeq: res.maxSeq, cursorBefore });
      const matched = await this.local.ackPush(batch, res.results);
      if (matched === 0) throw new Error('push response did not match the request');
      if (reset) throw new ServerResetError();
    }
  }

  private async pullAll(): Promise<void> {
    for (;;) {
      if (!this.running) return;
      const since = await this.local.cursor();
      const page = await this.transport.pull(since, this.o.pullLimit);
      if (await this.checkServer(page.serverId)) throw new ServerResetError();
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
        // Verified at the start of the next cycle, never concurrently with one.
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
