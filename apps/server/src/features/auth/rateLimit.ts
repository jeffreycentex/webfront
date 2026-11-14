/**
 * In-memory failure backoff for sign-in attempts.
 *
 * Each key (a client IP, or the global key) has a failure count. Once `threshold` failures are
 * reached, further attempts are refused until `last failure + base * 2^(failures - threshold)`
 * (capped at `maxMs`). A key that has been quiet for `decayMs` starts over.
 *
 * Attempts are counted pessimistically: `begin()` records a failure *before* the password is
 * checked (so a burst of parallel requests cannot all slip in under the threshold), and
 * `succeed()` takes it back.
 *
 * State lives in memory only: a restart clears it. That is acceptable for one account behind
 * Tailscale (an attacker cannot trigger restarts), and keeps the hot path free of writes.
 */

export interface BackoffPolicy {
  /** Failures allowed before any delay applies. */
  threshold: number;
  /** First delay once the threshold is reached. */
  baseMs: number;
  /** Maximum delay. */
  maxMs: number;
  /** Forget a key after this long without failures. */
  decayMs: number;
}

interface Entry {
  failures: number;
  last: number;
}

export class Backoff {
  private readonly entries = new Map<string, Entry>();

  constructor(
    readonly policy: BackoffPolicy,
    private readonly now: () => number,
    private readonly maxEntries = 10_000,
  ) {}

  private entry(key: string): Entry | undefined {
    const e = this.entries.get(key);
    if (e && this.now() - e.last > this.policy.decayMs) {
      this.entries.delete(key);
      return undefined;
    }
    return e;
  }

  /** Milliseconds until another attempt is allowed (0 = allowed now). */
  retryAfterMs(key: string): number {
    const e = this.entry(key);
    if (!e || e.failures < this.policy.threshold) return 0;
    const exp = Math.min(e.failures - this.policy.threshold, 30);
    const delay = Math.min(this.policy.baseMs * 2 ** exp, this.policy.maxMs);
    return Math.max(0, e.last + delay - this.now());
  }

  /** Record an attempt as failed (call before checking credentials). */
  begin(key: string): void {
    const e = this.entry(key);
    if (e) {
      e.failures++;
      e.last = this.now();
      // Keep insertion order roughly LRU for pruning.
      this.entries.delete(key);
      this.entries.set(key, e);
      return;
    }
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { failures: 1, last: this.now() });
  }

  /** The attempt succeeded: forget the key entirely. */
  reset(key: string): void {
    this.entries.delete(key);
  }

  /** The attempt succeeded: take back the one failure `begin` recorded. */
  forgiveOne(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    e.failures--;
    if (e.failures <= 0) this.entries.delete(key);
  }

  prune(): void {
    for (const key of [...this.entries.keys()]) this.entry(key);
  }

  get size(): number {
    return this.entries.size;
  }
}

export interface LoginLimiterOptions {
  perIp: BackoffPolicy;
  global: BackoffPolicy;
}

export const DEFAULT_LOGIN_LIMITS: LoginLimiterOptions = {
  // One device: 5 free attempts, then 1s, 2s, 4s, … up to 15 minutes.
  perIp: { threshold: 5, baseMs: 1_000, maxMs: 15 * 60_000, decayMs: 60 * 60_000 },
  // Everyone together (distributed guessing): capped low so the owner is never locked out long.
  global: { threshold: 30, baseMs: 1_000, maxMs: 60_000, decayMs: 15 * 60_000 },
};

const GLOBAL_KEY = '*';

/** Combined per-IP and global limiter for password checks. */
export class LoginLimiter {
  readonly perIp: Backoff;
  readonly global: Backoff;

  constructor(options: LoginLimiterOptions, now: () => number) {
    this.perIp = new Backoff(options.perIp, now);
    this.global = new Backoff(options.global, now);
  }

  /** Milliseconds to wait, considering the IP and (unless `ipOnly`) the global limit. */
  retryAfterMs(ip: string, ipOnly = false): number {
    const a = this.perIp.retryAfterMs(ip);
    return ipOnly ? a : Math.max(a, this.global.retryAfterMs(GLOBAL_KEY));
  }

  begin(ip: string, ipOnly = false): void {
    this.perIp.begin(ip);
    if (!ipOnly) this.global.begin(GLOBAL_KEY);
  }

  succeed(ip: string, ipOnly = false): void {
    this.perIp.reset(ip);
    if (!ipOnly) this.global.forgiveOne(GLOBAL_KEY);
  }

  prune(): void {
    this.perIp.prune();
    this.global.prune();
  }
}
