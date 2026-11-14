-- Auth (Task 2): the single account, sessions, passkeys and WebAuthn challenges.

-- Exactly one account: the CHECK makes a second INSERT fail, so first-run setup is race-free.
CREATE TABLE auth_account (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username TEXT NOT NULL,
  -- Argon2id PHC string.
  password_hash TEXT NOT NULL,
  -- Random WebAuthn user handle (base64url), never the username.
  webauthn_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  password_changed_at TEXT NOT NULL
) STRICT;

-- One row per signed-in device. Only the SHA-256 of the cookie token is stored.
CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  method TEXT NOT NULL CHECK (method IN ('setup', 'password', 'passkey')),
  device_name TEXT,
  user_agent TEXT,
  ip TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

CREATE INDEX auth_sessions_expires_at ON auth_sessions (expires_at);

CREATE TABLE auth_passkeys (
  id TEXT PRIMARY KEY,
  -- base64url credential id as sent by the authenticator.
  credential_id TEXT NOT NULL UNIQUE,
  -- COSE public key.
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  -- JSON array of AuthenticatorTransport strings.
  transports TEXT NOT NULL DEFAULT '[]',
  device_type TEXT NOT NULL,
  backed_up INTEGER NOT NULL DEFAULT 0,
  aaguid TEXT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
) STRICT;

-- Outstanding WebAuthn challenges (single use, short-lived). Only a hash is stored.
-- Registration challenges are bound to the session that requested them.
CREATE TABLE auth_challenges (
  challenge_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('register', 'login')),
  session_id TEXT REFERENCES auth_sessions (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

CREATE INDEX auth_challenges_expires_at ON auth_challenges (expires_at);
