import { z } from 'zod';

/** Every API error response body. */
export const apiErrorSchema = z.object({
  error: z.object({
    /** Stable machine-readable code, snake_case (e.g. `validation_error`, `unauthorized`). */
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/** Well-known error codes. Features may use their own additional snake_case codes. */
export const ERROR_CODES = {
  validation: 'validation_error',
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  csrf: 'csrf_failed',
  notFound: 'not_found',
  conflict: 'conflict',
  rateLimited: 'rate_limited',
  setupRequired: 'setup_required',
  wrongPassword: 'wrong_password',
  passkeyFailed: 'passkey_failed',
  payloadTooLarge: 'payload_too_large',
  internal: 'internal_error',
  notImplemented: 'not_implemented',
  /** Sync push rejection reasons (per-change `rejected` results). */
  clockDrift: 'clock_drift',
  incompleteRecord: 'incomplete_record',
  readOnly: 'read_only',
  /** Client-side fallback when an error response had no ApiError body. */
  httpError: 'http_error',
} as const;

export const okResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof okResponseSchema>;

/** `GET /api/health` (unauthenticated). */
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  time: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/**
 * CSRF: mutations (POST/PUT/PATCH/DELETE) under /api must send this header with the
 * token from the session response. Implemented by Task 2.
 */
export const CSRF_HEADER = 'x-csrf-token';
/** Session cookie name (HttpOnly, Secure, SameSite=Lax). */
export const SESSION_COOKIE = 'wf_session';

/** All API paths in one place. Server features mount these; the web client calls them. */
export const API = {
  health: '/api/health',
  auth: {
    status: '/api/auth/status',
    setup: '/api/auth/setup',
    login: '/api/auth/login',
    logout: '/api/auth/logout',
    session: '/api/auth/session',
    password: '/api/auth/password',
    sessions: '/api/auth/sessions',
    /** DELETE `${sessions}/:id` */
    passkeys: '/api/auth/passkeys',
    /** DELETE `${passkeys}/:id` */
    passkeyRegisterOptions: '/api/auth/passkeys/register/options',
    passkeyRegisterVerify: '/api/auth/passkeys/register/verify',
    passkeyLoginOptions: '/api/auth/passkeys/login/options',
    passkeyLoginVerify: '/api/auth/passkeys/login/verify',
  },
  sync: {
    push: '/api/sync/push',
    pull: '/api/sync/pull',
    events: '/api/sync/events',
  },
  /** Task 5: `GET /api/favicons?url=<page url>` -> image. */
  favicons: '/api/favicons',
  /** Task 5: `POST /api/services/:bookmarkId/check` to check now; dead-link check `POST /api/services/link-check`. */
  services: '/api/services',
  /** Task 9: `POST /api/calendar/feeds/:id/refresh` to refetch now. */
  calendar: '/api/calendar',
  /** Task 8: `POST /api/attachments` (upload), `GET /api/attachments/:id`. */
  attachments: '/api/attachments',
  /** `POST /api/attachments/cleanup` -> `{ ok, removed, kept }`: delete unreferenced images. */
  attachmentsCleanup: '/api/attachments/cleanup',
} as const;

export const attachmentsCleanupResponseSchema = z.object({
  ok: z.literal(true),
  removed: z.number().int().nonnegative(),
  kept: z.number().int().nonnegative(),
});
export type AttachmentsCleanupResponse = z.infer<typeof attachmentsCleanupResponseSchema>;
