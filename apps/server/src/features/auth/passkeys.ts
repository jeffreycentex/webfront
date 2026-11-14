import { randomUUID } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type {
  PasskeyAuthenticationCredential,
  PasskeyInfo,
  PasskeyRegistrationCredential,
} from '@webfront/shared';
import type { Config } from '../../config.js';
import type { Db } from '../../db/database.js';
import { AppError } from '../../http/errors.js';
import { sha256, type AccountRow } from './store.js';

/**
 * Passkeys (WebAuthn) via @simplewebauthn/server.
 *
 * - RP ID is `config.rpId` (the Tailscale hostname); expected origin is `config.publicOrigin`.
 * - Registration requires a signed-in session; its challenge is bound to that session.
 * - Login is usernameless: empty `allowCredentials`, so registration requires a discoverable
 *   (resident) credential. User verification is required both ways, because a passkey replaces
 *   the password entirely.
 * - Challenges are stored hashed, expire after `challengeTtlMs` and are deleted on first use
 *   (success or failure). The number of outstanding login challenges is capped, since anyone can
 *   request them.
 */

export interface PasskeyRow {
  id: string;
  credential_id: string;
  public_key: Uint8Array;
  counter: number;
  transports: string;
  device_type: string;
  backed_up: number;
  aaguid: string | null;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

export const PASSKEY_CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_LOGIN_CHALLENGES = 100;
const WEBAUTHN_TIMEOUT_MS = 120_000;

export const passkeyFailed = (message = 'Passkey verification failed') =>
  new AppError(400, 'passkey_failed', message);

export function toPasskeyInfo(row: PasskeyRow): PasskeyInfo {
  return {
    id: row.id,
    name: row.name,
    backedUp: row.backed_up === 1,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

/** The challenge a browser signed, read from clientDataJSON (null if malformed). */
export function challengeFromClientData(clientDataJSON: string): string | null {
  try {
    const data = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8')) as unknown;
    if (data && typeof data === 'object' && 'challenge' in data) {
      const c = (data as { challenge: unknown }).challenge;
      return typeof c === 'string' && c.length > 0 && c.length <= 512 ? c : null;
    }
  } catch {
    // fall through
  }
  return null;
}

const parseTransports = (json: string): string[] => {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
};

export class PasskeyService {
  constructor(
    private readonly db: Db,
    private readonly config: Pick<Config, 'rpId' | 'rpName' | 'publicOrigin'>,
    private readonly now: () => number,
    private readonly challengeTtlMs = PASSKEY_CHALLENGE_TTL_MS,
  ) {}

  private iso(ms = this.now()) {
    return new Date(ms).toISOString();
  }

  /* ---- storage ---- */

  list(): PasskeyRow[] {
    return this.db.all<PasskeyRow>('SELECT * FROM auth_passkeys ORDER BY created_at, id');
  }

  count(): number {
    return this.db.get<{ n: number }>('SELECT count(*) AS n FROM auth_passkeys')?.n ?? 0;
  }

  get(id: string): PasskeyRow | undefined {
    return this.db.get<PasskeyRow>('SELECT * FROM auth_passkeys WHERE id = ?', id);
  }

  rename(id: string, name: string): PasskeyRow | undefined {
    this.db.run('UPDATE auth_passkeys SET name = ? WHERE id = ?', name, id);
    return this.get(id);
  }

  remove(id: string): boolean {
    return this.db.run('DELETE FROM auth_passkeys WHERE id = ?', id).changes > 0;
  }

  /* ---- challenges ---- */

  private storeChallenge(challenge: string, kind: 'register' | 'login', sessionId: string | null) {
    const now = this.now();
    this.db.transaction(() => {
      this.db.run('DELETE FROM auth_challenges WHERE expires_at <= ?', this.iso(now));
      if (kind === 'login') {
        this.db.run(
          `DELETE FROM auth_challenges WHERE challenge_hash IN (
             SELECT challenge_hash FROM auth_challenges WHERE kind = 'login'
             ORDER BY created_at DESC LIMIT -1 OFFSET ?)`,
          MAX_LOGIN_CHALLENGES - 1,
        );
      } else {
        // One outstanding registration per session.
        this.db.run(
          "DELETE FROM auth_challenges WHERE kind = 'register' AND session_id = ?",
          sessionId,
        );
      }
      this.db.run(
        'INSERT INTO auth_challenges (challenge_hash, kind, session_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
        sha256(challenge),
        kind,
        sessionId,
        this.iso(now),
        this.iso(now + this.challengeTtlMs),
      );
    });
  }

  /** Delete the challenge and report whether it was valid for this use. */
  private consumeChallenge(
    challenge: string,
    kind: 'register' | 'login',
    sessionId: string | null,
  ): boolean {
    const row = this.db.get<{ kind: string; session_id: string | null; expires_at: string }>(
      'DELETE FROM auth_challenges WHERE challenge_hash = ? RETURNING kind, session_id, expires_at',
      sha256(challenge),
    );
    return (
      !!row &&
      row.kind === kind &&
      row.session_id === sessionId &&
      Date.parse(row.expires_at) > this.now()
    );
  }

  /* ---- registration ---- */

  async registrationOptions(
    account: AccountRow,
    sessionId: string,
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const options = await generateRegistrationOptions({
      rpName: this.config.rpName,
      rpID: this.config.rpId,
      userName: account.username,
      userDisplayName: account.username,
      userID: new Uint8Array(Buffer.from(account.webauthn_user_id, 'base64url')),
      timeout: WEBAUTHN_TIMEOUT_MS,
      attestationType: 'none',
      excludeCredentials: this.list().map((p) => ({
        id: p.credential_id,
        transports: parseTransports(p.transports),
      })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    this.storeChallenge(options.challenge, 'register', sessionId);
    return options;
  }

  async verifyRegistration(
    response: PasskeyRegistrationCredential,
    name: string,
    sessionId: string,
  ): Promise<PasskeyRow> {
    const challenge = challengeFromClientData(response.response.clientDataJSON);
    if (!challenge || !this.consumeChallenge(challenge, 'register', sessionId)) {
      throw passkeyFailed('Passkey challenge is missing, expired or already used');
    }
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: response as unknown as RegistrationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin: this.config.publicOrigin,
        expectedRPID: this.config.rpId,
        requireUserVerification: true,
      });
    } catch {
      throw passkeyFailed();
    }
    if (!verification.verified) throw passkeyFailed();
    const info = verification.registrationInfo;
    const cred = info.credential;
    if (this.db.get('SELECT 1 FROM auth_passkeys WHERE credential_id = ?', cred.id)) {
      throw new AppError(409, 'conflict', 'This passkey is already registered');
    }
    const row: PasskeyRow = {
      id: randomUUID(),
      credential_id: cred.id,
      public_key: cred.publicKey,
      counter: cred.counter,
      transports: JSON.stringify(cred.transports ?? response.response.transports ?? []),
      device_type: info.credentialDeviceType,
      backed_up: info.credentialBackedUp ? 1 : 0,
      aaguid: info.aaguid,
      name,
      created_at: this.iso(),
      last_used_at: null,
    };
    this.db.run(
      `INSERT INTO auth_passkeys (id, credential_id, public_key, counter, transports, device_type, backed_up, aaguid, name, created_at, last_used_at)
       VALUES (@id, @credential_id, @public_key, @counter, @transports, @device_type, @backed_up, @aaguid, @name, @created_at, @last_used_at)`,
      { ...row },
    );
    return row;
  }

  /* ---- authentication ---- */

  async authenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const options = await generateAuthenticationOptions({
      rpID: this.config.rpId,
      allowCredentials: [],
      timeout: WEBAUTHN_TIMEOUT_MS,
      userVerification: 'required',
    });
    this.storeChallenge(options.challenge, 'login', null);
    return options;
  }

  /** Returns the passkey used, or null if verification failed for any reason. */
  async verifyAuthentication(
    response: PasskeyAuthenticationCredential,
    account: AccountRow,
  ): Promise<PasskeyRow | null> {
    const challenge = challengeFromClientData(response.response.clientDataJSON);
    if (!challenge || !this.consumeChallenge(challenge, 'login', null)) return null;
    const row = this.db.get<PasskeyRow>(
      'SELECT * FROM auth_passkeys WHERE credential_id = ?',
      response.id,
    );
    if (!row) return null;
    const handle = response.response.userHandle;
    if (handle && handle !== account.webauthn_user_id) return null;
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: response as unknown as AuthenticationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin: this.config.publicOrigin,
        expectedRPID: this.config.rpId,
        credential: {
          id: row.credential_id,
          publicKey: new Uint8Array(row.public_key),
          counter: row.counter,
          transports: parseTransports(row.transports),
        },
        requireUserVerification: true,
      });
    } catch {
      return null;
    }
    if (!verification.verified) return null;
    const { newCounter, credentialBackedUp } = verification.authenticationInfo;
    const lastUsed = this.iso();
    this.db.run(
      'UPDATE auth_passkeys SET counter = ?, backed_up = ?, last_used_at = ? WHERE id = ?',
      newCounter,
      credentialBackedUp ? 1 : 0,
      lastUsed,
      row.id,
    );
    return { ...row, counter: newCounter, last_used_at: lastUsed };
  }
}
