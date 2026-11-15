import {
  DEFAULT_NOTIFICATION_OPTIONS,
  PUSHOVER_KEY_PATTERN,
  notificationOptionsSchema,
  type NotificationConfigResponse,
  type NotificationOptions,
  type MaskedCredential,
} from '@webfront/shared';
import type { Db } from '../../../db/database.js';
import type { Logger } from '../../../logger.js';
import {
  downMessage,
  evaluateAlerts,
  recoveryMessage,
  type AlertRow,
  type Observation,
} from './alerts.js';
import {
  cleanText,
  deliver,
  type DeliveryOutcome,
  type PushoverCredentials,
  type PushoverMessage,
  type PushoverSend,
} from './pushover.js';

/**
 * Server-side Pushover notifier: config and credential storage (SQLite, never synced),
 * alert state per service, and a sequential delivery queue with retry/backoff.
 */

/** Waits before retrying a temporary failure (Pushover asks for at least 5 s). */
export const RETRY_DELAYS_MS = [15_000, 60_000, 5 * 60_000] as const;
/** Minimum spacing between test notifications. */
export const TEST_COOLDOWN_MS = 5_000;
const MAX_QUEUE = 20;

export interface NotifierEnv {
  PUSHOVER_APP_TOKEN?: string | undefined;
  PUSHOVER_USER_KEY?: string | undefined;
}

export interface NotifierOptions {
  db: Db;
  logger: Logger;
  now: () => number;
  send: PushoverSend;
  /** Delay used between retries (tests inject an instant one). */
  sleep: (ms: number) => Promise<void>;
  /** Environment overrides for the credentials (default: process.env). */
  env: NotifierEnv;
}

interface ConfigRow {
  enabled: number;
  app_token: string | null;
  user_key: string | null;
  options: string;
  last_success_at: number | null;
  last_error_at: number | null;
  last_error: string | null;
  paused: number;
}

interface StateRow {
  bookmark_id: string;
  state: 'up' | 'down';
  seen_up: number;
  down_since: number | null;
  alert: AlertRow['alert'];
  last_alert_at: number | null;
}

const iso = (ms: number | null) =>
  ms === null ? null : new Date(ms).toISOString().replace(/\.\d{3}Z$/, '.000Z');

function mask(value: string | null, source: 'saved' | 'env' | null): MaskedCredential {
  if (!value) return { configured: false, hint: null, source: null };
  return { configured: true, hint: `…${value.slice(-4)}`, source };
}

export class Notifier {
  private readonly db: Db;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly send: PushoverSend;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly envToken: string | null;
  private readonly envUser: string | null;
  private queue: PushoverMessage[] = [];
  private draining: Promise<void> | null = null;
  private closed = false;
  private lastTestAt = -Infinity;

  constructor(o: NotifierOptions) {
    this.db = o.db;
    this.log = o.logger;
    this.now = o.now;
    this.send = o.send;
    this.sleep = o.sleep;
    this.envToken = this.envKey(o.env.PUSHOVER_APP_TOKEN, 'PUSHOVER_APP_TOKEN');
    this.envUser = this.envKey(o.env.PUSHOVER_USER_KEY, 'PUSHOVER_USER_KEY');
    this.db.run(
      `INSERT INTO notification_config (id, options, updated_at) VALUES (1, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      JSON.stringify(DEFAULT_NOTIFICATION_OPTIONS),
      this.now(),
    );
  }

  private envKey(raw: string | undefined, name: string): string | null {
    const v = raw?.trim();
    if (!v) return null;
    if (!PUSHOVER_KEY_PATTERN.test(v)) {
      // Never log the value itself.
      this.log.warn('ignoring invalid Pushover credential from the environment', {
        variable: name,
      });
      return null;
    }
    return v;
  }

  /* ---------------------------------------------------------------------------------------
   * Config
   * ------------------------------------------------------------------------------------- */

  private row(): ConfigRow {
    return this.db.get<ConfigRow>('SELECT * FROM notification_config WHERE id = 1')!;
  }

  options(): NotificationOptions {
    try {
      return notificationOptionsSchema.parse(JSON.parse(this.row().options));
    } catch {
      return DEFAULT_NOTIFICATION_OPTIONS;
    }
  }

  credentials(): PushoverCredentials | null {
    const r = this.row();
    const token = this.envToken ?? r.app_token;
    const user = this.envUser ?? r.user_key;
    return token && user ? { token, user } : null;
  }

  /** Enabled, configured and not paused after a rejection: automatic alerts go out. */
  active(): boolean {
    const r = this.row();
    return r.enabled === 1 && r.paused === 0 && this.credentials() !== null;
  }

  view(): NotificationConfigResponse {
    const r = this.row();
    const token = mask(this.envToken ?? r.app_token, this.envToken ? 'env' : 'saved');
    const userKey = mask(this.envUser ?? r.user_key, this.envUser ? 'env' : 'saved');
    return {
      enabled: r.enabled === 1,
      configured: token.configured && userKey.configured,
      token,
      userKey,
      options: this.options(),
      delivery: {
        lastSuccessAt: iso(r.last_success_at),
        lastErrorAt: iso(r.last_error_at),
        lastError: r.last_error,
        paused: r.paused === 1,
      },
    };
  }

  /** Save options (and credentials when given). Saving clears a delivery pause. */
  save(input: {
    enabled: boolean;
    token?: string | undefined;
    userKey?: string | undefined;
    options: NotificationOptions;
  }): void {
    this.db.transaction(() => {
      this.db.run(
        `UPDATE notification_config SET enabled = ?, options = ?, updated_at = ?, paused = 0
         WHERE id = 1`,
        input.enabled,
        JSON.stringify(input.options),
        this.now(),
      );
      if (input.token !== undefined) {
        this.db.run('UPDATE notification_config SET app_token = ? WHERE id = 1', input.token);
      }
      if (input.userKey !== undefined) {
        this.db.run('UPDATE notification_config SET user_key = ? WHERE id = 1', input.userKey);
      }
    });
    this.log.info('notification settings saved', {
      enabled: input.enabled,
      tokenChanged: input.token !== undefined,
      userKeyChanged: input.userKey !== undefined,
    });
  }

  clearCredentials(): void {
    this.db.run(
      `UPDATE notification_config SET app_token = NULL, user_key = NULL, paused = 0,
       updated_at = ? WHERE id = 1`,
      this.now(),
    );
    this.queue = [];
    this.log.info('saved Pushover credentials removed');
  }

  private recordOutcome(outcome: DeliveryOutcome): void {
    const t = this.now();
    if (outcome.kind === 'ok') {
      this.db.run('UPDATE notification_config SET last_success_at = ? WHERE id = 1', t);
      return;
    }
    this.db.run(
      `UPDATE notification_config SET last_error_at = ?, last_error = ?,
       paused = CASE WHEN ? THEN 1 ELSE paused END WHERE id = 1`,
      t,
      outcome.error,
      outcome.kind === 'rejected',
    );
  }

  /* ---------------------------------------------------------------------------------------
   * Alerts (called from the sweep, synchronously; delivery runs in the background)
   * ------------------------------------------------------------------------------------- */

  onSweep(observations: readonly Observation[], currentIds: ReadonlySet<string>): void {
    const now = this.now();
    const rows = new Map(
      this.db.all<StateRow>('SELECT * FROM service_alert_state').map((r): [string, AlertRow] => [
        r.bookmark_id,
        {
          bookmarkId: r.bookmark_id,
          state: r.state,
          seenUp: r.seen_up === 1,
          downSince: r.down_since,
          alert: r.alert,
          lastAlertAt: r.last_alert_at,
        },
      ]),
    );
    const options = this.options();
    const result = evaluateAlerts({
      rows,
      observations: observations.map((o) => ({
        ...o,
        reason: o.reason === null ? null : cleanText(o.reason, 120),
      })),
      currentIds,
      options,
      active: this.active(),
      now,
    });

    // Persist first: a transition is acted on exactly once even if delivery later fails.
    if (result.upserts.length > 0 || result.deletes.length > 0) {
      this.db.transaction(() => {
        for (const r of result.upserts) {
          this.db.run(
            `INSERT INTO service_alert_state
               (bookmark_id, state, seen_up, down_since, alert, last_alert_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (bookmark_id) DO UPDATE SET state = excluded.state,
               seen_up = excluded.seen_up, down_since = excluded.down_since,
               alert = excluded.alert, last_alert_at = excluded.last_alert_at`,
            r.bookmarkId,
            r.state,
            r.seenUp,
            r.downSince,
            r.alert,
            r.lastAlertAt,
          );
        }
        for (const id of result.deletes) {
          this.db.run('DELETE FROM service_alert_state WHERE bookmark_id = ?', id);
        }
      });
    }

    const messages = [
      downMessage(result.down, options, now),
      recoveryMessage(result.recovered, options, now),
    ].filter((m): m is PushoverMessage => m !== null);
    for (const m of messages) this.enqueue(m);
  }

  private enqueue(m: PushoverMessage): void {
    if (this.closed) return;
    if (this.queue.length >= MAX_QUEUE) {
      this.log.warn('notification queue full, dropping a message');
      return;
    }
    this.queue.push(m);
    this.draining ??= this.drain().finally(() => {
      this.draining = null;
    });
  }

  /** Sends queued messages one at a time (never concurrently). */
  private async drain(): Promise<void> {
    while (!this.closed && this.queue.length > 0) {
      const m = this.queue.shift()!;
      for (let attempt = 0; ; attempt++) {
        const creds = this.credentials();
        if (!creds || !this.active()) break; // removed, disabled or paused meanwhile
        const outcome = await deliver(this.send, creds, m);
        this.recordOutcome(outcome);
        if (outcome.kind === 'ok') {
          this.log.info('alert sent', { title: m.title });
          break;
        }
        if (outcome.kind === 'rejected') {
          // 4xx: repeating it will not help, and repeated 4xx get the server's IP blocked.
          // Pause automatic alerts until the owner saves the settings again.
          this.log.warn('Pushover rejected an alert; automatic alerts paused', {
            status: outcome.status,
            error: outcome.error,
          });
          this.queue = [];
          return;
        }
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined || this.closed) {
          this.log.warn('alert not delivered, giving up', { error: outcome.error });
          break;
        }
        this.log.warn('alert delivery failed, will retry', {
          error: outcome.error,
          retryInMs: delay,
        });
        await this.sleep(delay);
      }
    }
  }

  /** Resolves once the queue is empty (tests). */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  /** Send a test notification now (no retry). Bypasses the enabled flag and the pause. */
  async sendTest(): Promise<
    | { kind: 'ok'; sentAt: number }
    | { kind: 'not_configured' }
    | { kind: 'too_soon'; retryAfterMs: number }
    | Exclude<DeliveryOutcome, { kind: 'ok' }>
  > {
    const creds = this.credentials();
    if (!creds) return { kind: 'not_configured' };
    const now = this.now();
    const wait = this.lastTestAt + TEST_COOLDOWN_MS - now;
    if (wait > 0) return { kind: 'too_soon', retryAfterMs: wait };
    this.lastTestAt = now;
    const options = this.options();
    const outcome = await deliver(this.send, creds, {
      title: 'Webfront test',
      message: 'Test notification from Webfront. Service outage alerts will look like this.',
      priority: 0,
      sound: options.sound,
      device: options.device,
    });
    this.recordOutcome(outcome);
    if (outcome.kind === 'ok') {
      // A working test proves the settings; lift a pause from an earlier rejection.
      this.db.run('UPDATE notification_config SET paused = 0 WHERE id = 1');
      return { kind: 'ok', sentAt: this.now() };
    }
    this.log.warn('test notification failed', { error: outcome.error });
    return outcome;
  }

  close(): void {
    this.closed = true;
    this.queue = [];
  }
}
