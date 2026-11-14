import { z } from 'zod';
import { isoDateTimeSchema } from '../record.js';

/**
 * Auth API request/response shapes. Owner of the implementation: Task 2 (server) and
 * Task 4 (web screens). Paths are in `API.auth` (api/common.ts).
 *
 * Single user. Sessions are per device, HttpOnly cookie, 90-day sliding expiry.
 * Mutating requests need the `x-csrf-token` header (value from `SessionInfo.csrfToken`),
 * except the public sign-in endpoints (setup, login, passkey login), which are protected by the
 * Origin check instead. All mutating requests must come from `PUBLIC_ORIGIN`.
 *
 * Errors (ApiError body): 400 `validation_error`, 401 `unauthorized`, 403 `csrf_failed`,
 * 404 `not_found`, 409 `setup_required` / `conflict`, 429 `rate_limited` (with a
 * `Retry-After` header and `details.retryAfterSeconds`).
 */

export const USERNAME_PATTERN = /^[a-zA-Z0-9._-]+$/;
export const usernameSchema = z.string().trim().min(1).max(64).regex(USERNAME_PATTERN);
/** Length limits only; no composition rules. Argon2id handles the rest. */
export const passwordSchema = z.string().min(10).max(1024);
export const deviceNameSchema = z.string().trim().min(1).max(100);
export const passkeyNameSchema = z.string().trim().min(1).max(100);

export const authMethodSchema = z.enum(['setup', 'password', 'passkey']);
export type AuthMethod = z.infer<typeof authMethodSchema>;

export const sessionInfoSchema = z.object({
  username: z.string(),
  sessionId: z.string(),
  /** Explicit device name, or a label derived from the user agent ("Firefox on Windows"). */
  deviceName: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
  /** Send in the `x-csrf-token` header on every mutating request. */
  csrfToken: z.string(),
});
export type SessionInfo = z.infer<typeof sessionInfoSchema>;

/** `GET /api/auth/status` (public): what screen to show. */
export const authStatusResponseSchema = z.object({
  /** No account yet: show the one-time "create account" screen. */
  setupRequired: z.boolean(),
  session: sessionInfoSchema.nullable(),
  /** Whether any passkey is registered (to offer "Sign in with a passkey"). */
  passkeysAvailable: z.boolean(),
});
export type AuthStatusResponse = z.infer<typeof authStatusResponseSchema>;

/** `POST /api/auth/setup` (public, only while setupRequired; 409 `conflict` afterwards) -> SessionInfo */
export const setupRequestSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  deviceName: deviceNameSchema.optional(),
});
export type SetupRequest = z.infer<typeof setupRequestSchema>;

/**
 * `POST /api/auth/login` (public) -> SessionInfo; 401 `unauthorized`, 429 `rate_limited`,
 * 409 `setup_required` before setup. The username is matched case-insensitively.
 */
export const loginRequestSchema = z.object({
  username: z.string().max(64),
  password: z.string().min(1).max(1024),
  deviceName: deviceNameSchema.optional(),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/**
 * `GET /api/auth/session` (signed in) -> SessionInfo, 401 if not signed in.
 * `POST /api/auth/logout` (no body) -> OkResponse; always succeeds and clears the cookie.
 */

/**
 * `POST /api/auth/password` (signed in) -> OkResponse; 400 `wrong_password` if the current
 * password is wrong (counts towards the login rate limit, so 429 is possible too).
 */
export const passwordChangeRequestSchema = z.object({
  currentPassword: z.string().max(1024),
  newPassword: passwordSchema,
  /** Sign out every other device. */
  revokeOtherSessions: z.boolean().default(true),
});
export type PasswordChangeRequest = z.infer<typeof passwordChangeRequestSchema>;

/**
 * `GET /api/auth/sessions` (signed in) -> SessionListResponse, newest activity first.
 * `DELETE /api/auth/sessions/:id` -> OkResponse (revoking the current one signs this device out).
 * `DELETE /api/auth/sessions` -> RevokeOtherSessionsResponse (revokes every session but this one).
 */
export const sessionSummarySchema = z.object({
  id: z.string(),
  deviceName: z.string().nullable(),
  userAgent: z.string().nullable(),
  /** Client IP at the last request (Tailscale address). */
  ip: z.string().nullable(),
  authMethod: authMethodSchema,
  createdAt: isoDateTimeSchema,
  lastSeenAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
  current: z.boolean(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export const sessionListResponseSchema = z.object({ sessions: z.array(sessionSummarySchema) });
export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;
export const revokeOtherSessionsResponseSchema = z.object({
  ok: z.literal(true),
  revoked: z.number().int().nonnegative(),
});
export type RevokeOtherSessionsResponse = z.infer<typeof revokeOtherSessionsResponseSchema>;

/* ---- Passkeys (WebAuthn). Options/credentials are the JSON forms used by @simplewebauthn. ---- */

const b64url = z
  .string()
  .max(16_384)
  .regex(/^[A-Za-z0-9_-]*$/, 'Expected base64url');

/** PublicKeyCredentialCreationOptionsJSON / RequestOptionsJSON: passed through opaquely. */
const webauthnJson = z.looseObject({ challenge: z.string() });

/** RegistrationResponseJSON from @simplewebauthn/browser `startRegistration()`. */
export const passkeyRegistrationCredentialSchema = z.looseObject({
  id: b64url,
  rawId: b64url,
  type: z.literal('public-key'),
  response: z.looseObject({
    clientDataJSON: b64url,
    attestationObject: b64url,
    transports: z.array(z.string().max(32)).max(10).optional(),
  }),
  clientExtensionResults: z.looseObject({}).default({}),
  authenticatorAttachment: z.string().max(32).optional(),
});
export type PasskeyRegistrationCredential = z.infer<typeof passkeyRegistrationCredentialSchema>;

/** AuthenticationResponseJSON from @simplewebauthn/browser `startAuthentication()`. */
export const passkeyAuthenticationCredentialSchema = z.looseObject({
  id: b64url,
  rawId: b64url,
  type: z.literal('public-key'),
  response: z.looseObject({
    clientDataJSON: b64url,
    authenticatorData: b64url,
    signature: b64url,
    userHandle: b64url.optional(),
  }),
  clientExtensionResults: z.looseObject({}).default({}),
  authenticatorAttachment: z.string().max(32).optional(),
});
export type PasskeyAuthenticationCredential = z.infer<typeof passkeyAuthenticationCredentialSchema>;

/**
 * `POST /api/auth/passkeys/register/options` (signed in; body optional). The challenge is valid
 * for 5 minutes, once, and only for the session that requested it.
 */
export const passkeyRegisterOptionsRequestSchema = z.object({
  name: passkeyNameSchema.optional(),
});
export type PasskeyRegisterOptionsRequest = z.infer<typeof passkeyRegisterOptionsRequestSchema>;
export const passkeyRegisterOptionsResponseSchema = z.object({ options: webauthnJson });
export type PasskeyRegisterOptionsResponse = z.infer<typeof passkeyRegisterOptionsResponseSchema>;

/** `POST /api/auth/passkeys/register/verify` (signed in) -> PasskeyInfo */
export const passkeyRegisterVerifyRequestSchema = z.object({
  name: passkeyNameSchema,
  response: passkeyRegistrationCredentialSchema,
});
export type PasskeyRegisterVerifyRequest = z.infer<typeof passkeyRegisterVerifyRequestSchema>;

/**
 * `POST /api/auth/passkeys/login/options` (public, no body). Usernameless: `allowCredentials`
 * is empty, so the browser offers any discoverable passkey for this site (conditional UI works).
 */
export const passkeyLoginOptionsResponseSchema = z.object({ options: webauthnJson });
export type PasskeyLoginOptionsResponse = z.infer<typeof passkeyLoginOptionsResponseSchema>;

/** `POST /api/auth/passkeys/login/verify` (public) -> SessionInfo; 401, 429 */
export const passkeyLoginVerifyRequestSchema = z.object({
  response: passkeyAuthenticationCredentialSchema,
  deviceName: deviceNameSchema.optional(),
});
export type PasskeyLoginVerifyRequest = z.infer<typeof passkeyLoginVerifyRequestSchema>;

/**
 * `GET /api/auth/passkeys` (signed in) -> PasskeyListResponse;
 * `PATCH /api/auth/passkeys/:id` (PasskeyRenameRequest) -> PasskeyInfo;
 * `DELETE /api/auth/passkeys/:id` -> OkResponse
 */
export const passkeyInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Synced passkey (e.g. iCloud Keychain, Google Password Manager). */
  backedUp: z.boolean(),
  createdAt: isoDateTimeSchema,
  lastUsedAt: isoDateTimeSchema.nullable(),
});
export type PasskeyInfo = z.infer<typeof passkeyInfoSchema>;
export const passkeyListResponseSchema = z.object({ passkeys: z.array(passkeyInfoSchema) });
export type PasskeyListResponse = z.infer<typeof passkeyListResponseSchema>;
export const passkeyRenameRequestSchema = z.object({ name: passkeyNameSchema });
export type PasskeyRenameRequest = z.infer<typeof passkeyRenameRequestSchema>;
