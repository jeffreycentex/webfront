import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthMethod, SessionInfo, SessionSummary } from '@webfront/shared';
import type { Db } from '../../db/database.js';
import type { EventBus } from '../../events.js';

/**
 * Persistence for the single account and its sessions.
 *
 * Session tokens: 32 random bytes (base64url) in the cookie; only SHA-256(token) is stored, so a
 * leaked database cannot be replayed as cookies. The CSRF token is HMAC(token, "csrf"): it needs
 * no storage, is stable for the session's lifetime and cannot be derived from the database.
 * Sessions also have a separate random public id used in the API (list/revoke, events).
 */

export interface AccountRow {
  username: string;
  password_hash: string;
  webauthn_user_id: string;
  created_at: string;
  password_changed_at: string;
}

export interface SessionRow {
  id: string;
  token_hash: string;
  method: AuthMethod;
  device_name: string | null;
  user_agent: string | null;
  ip: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
}

export interface SessionPolicy {
  /** Sliding lifetime (default 90 days). */
  ttlMs: number;
  /** Write last-seen/expiry at most this often per session (default 60 s). */
  touchIntervalMs: number;
}

export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  ttlMs: 90 * 24 * 60 * 60_000,
  touchIntervalMs: 60_000,
};

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export const csrfTokenFor = (token: string) =>
  createHmac('sha256', token).update('webfront-csrf-v1').digest('base64url');

/** Constant-time string comparison (via fixed-length digests). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
}

export interface LoadedSession {
  row: SessionRow;
  token: string;
  username: string;
  /** Set when this request extended the session (the cookie should be re-sent). */
  touched: boolean;
}

export interface NewSession {
  method: AuthMethod;
  deviceName: string | null;
  userAgent: string | null;
  ip: string | null;
}

export class AuthStore {
  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
    private readonly now: () => number,
    readonly policy: SessionPolicy = DEFAULT_SESSION_POLICY,
  ) {}

  private iso(ms = this.now()) {
    return new Date(ms).toISOString();
  }

  /* ---- account ---- */

  account(): AccountRow | undefined {
    return this.db.get<AccountRow>(
      'SELECT username, password_hash, webauthn_user_id, created_at, password_changed_at FROM auth_account WHERE id = 1',
    );
  }

  /** Returns false if an account already exists (the single-row CHECK makes this race-free). */
  createAccount(username: string, passwordHash: string): boolean {
    const now = this.iso();
    const r = this.db.run(
      `INSERT INTO auth_account (id, username, password_hash, webauthn_user_id, created_at, password_changed_at)
       VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
      username,
      passwordHash,
      randomBytes(32).toString('base64url'),
      now,
      now,
    );
    return r.changes === 1;
  }

  setPasswordHash(passwordHash: string, changed: boolean): void {
    if (changed) {
      this.db.run(
        'UPDATE auth_account SET password_hash = ?, password_changed_at = ? WHERE id = 1',
        passwordHash,
        this.iso(),
      );
    } else {
      // Transparent re-hash with new parameters: not a password change.
      this.db.run('UPDATE auth_account SET password_hash = ? WHERE id = 1', passwordHash);
    }
  }

  /* ---- sessions ---- */

  createSession(input: NewSession): { row: SessionRow; token: string } {
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    const row: SessionRow = {
      id: randomBytes(16).toString('hex'),
      token_hash: sha256(token),
      method: input.method,
      device_name: input.deviceName,
      user_agent: input.userAgent,
      ip: input.ip,
      created_at: this.iso(now),
      last_seen_at: this.iso(now),
      expires_at: this.iso(now + this.policy.ttlMs),
    };
    this.db.run(
      `INSERT INTO auth_sessions (id, token_hash, method, device_name, user_agent, ip, created_at, last_seen_at, expires_at)
       VALUES (@id, @token_hash, @method, @device_name, @user_agent, @ip, @created_at, @last_seen_at, @expires_at)`,
      { ...row },
    );
    return { row, token };
  }

  /**
   * Resolve a cookie token to a live session, deleting it if expired and sliding its expiry
   * (throttled to `touchIntervalMs`).
   */
  loadSession(token: string, ip: string | null): LoadedSession | null {
    if (!TOKEN_PATTERN.test(token)) return null;
    const row = this.db.get<SessionRow>(
      'SELECT * FROM auth_sessions WHERE token_hash = ?',
      sha256(token),
    );
    if (!row) return null;
    const account = this.account();
    const now = this.now();
    if (!account || Date.parse(row.expires_at) <= now) {
      this.revoke(row.id);
      return null;
    }
    let touched = false;
    if (now - Date.parse(row.last_seen_at) >= this.policy.touchIntervalMs || row.ip !== ip) {
      row.last_seen_at = this.iso(now);
      row.expires_at = this.iso(now + this.policy.ttlMs);
      row.ip = ip;
      this.db.run(
        'UPDATE auth_sessions SET last_seen_at = ?, expires_at = ?, ip = ? WHERE id = ?',
        row.last_seen_at,
        row.expires_at,
        ip,
        row.id,
      );
      touched = true;
    }
    return { row, token, username: account.username, touched };
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.get<SessionRow>('SELECT * FROM auth_sessions WHERE id = ?', id);
  }

  listSessions(): SessionRow[] {
    return this.db.all<SessionRow>(
      'SELECT * FROM auth_sessions WHERE expires_at > ? ORDER BY last_seen_at DESC, id',
      this.iso(),
    );
  }

  /** Delete one session; emits `session.revoked`. Returns whether it existed. */
  revoke(id: string): boolean {
    const changed = this.db.run('DELETE FROM auth_sessions WHERE id = ?', id).changes > 0;
    if (changed) this.events.emit('session.revoked', { sessionId: id });
    return changed;
  }

  /** Delete every session except `keepId` (all if null); emits per session. Returns the count. */
  revokeAllExcept(keepId: string | null): number {
    const ids = this.db
      .all<{ id: string }>('SELECT id FROM auth_sessions WHERE id IS NOT ?', keepId)
      .map((r) => r.id);
    this.db.transaction(() => {
      for (const id of ids) this.db.run('DELETE FROM auth_sessions WHERE id = ?', id);
    });
    for (const id of ids) this.events.emit('session.revoked', { sessionId: id });
    return ids.length;
  }

  /** Housekeeping: drop expired sessions (emitting events) and expired challenges. */
  purgeExpired(): void {
    const now = this.iso();
    const expired = this.db
      .all<{ id: string }>('SELECT id FROM auth_sessions WHERE expires_at <= ?', now)
      .map((r) => r.id);
    for (const id of expired) this.revoke(id);
    this.db.run('DELETE FROM auth_challenges WHERE expires_at <= ?', now);
  }

  /* ---- shapes ---- */

  sessionInfo(
    s: LoadedSession | { row: SessionRow; token: string; username: string },
  ): SessionInfo {
    return {
      username: s.username,
      sessionId: s.row.id,
      deviceName: s.row.device_name,
      createdAt: s.row.created_at,
      expiresAt: s.row.expires_at,
      csrfToken: csrfTokenFor(s.token),
    };
  }

  static summary(row: SessionRow, currentId: string | null): SessionSummary {
    return {
      id: row.id,
      deviceName: row.device_name,
      userAgent: row.user_agent,
      ip: row.ip,
      authMethod: row.method,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
      current: row.id === currentId,
    };
  }
}
