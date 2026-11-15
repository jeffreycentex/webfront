import { z } from 'zod';
import { isoDateTimeSchema } from '../record.js';
import { refField } from './common.js';

/** Owner: Task 5 (Bookmarks: service health checker). */

export const SERVICE_CHECK_INTERVAL_SECONDS = 60;

export const serviceStateSchema = z.enum(['up', 'down', 'unknown']);
export type ServiceState = z.infer<typeof serviceStateSchema>;

/**
 * Server-owned: one record per service bookmark, with `id === bookmarkId`.
 * To avoid sync churn the checker should write only when `state` (or `message`) changes,
 * not on every check.
 */
export const serviceStatusFields = z.object({
  bookmarkId: refField,
  state: serviceStateSchema.default('unknown'),
  /** When the state last changed ("down since 10:42"). */
  changedAt: isoDateTimeSchema.nullable().default(null),
  /** When the check that produced this state ran. */
  checkedAt: isoDateTimeSchema.nullable().default(null),
  latencyMs: z.int().min(0).nullable().default(null),
  /** Short diagnostic, e.g. "HTTP 502" or "ECONNREFUSED". */
  message: z.string().max(500).nullable().default(null),
});

/* -----------------------------------------------------------------------------------------
 * HTTP API shapes (apps/server/src/features/{services,favicons}).
 * --------------------------------------------------------------------------------------- */

/** `POST /api/services/check-now` */
export const checkNowResponseSchema = z.object({ checked: z.int().min(0) });
export type CheckNowResponse = z.infer<typeof checkNowResponseSchema>;

/** `POST /api/services/check-links` (body: optional list of bookmark ids; default all). */
export const checkLinksRequestSchema = z.object({
  ids: z.array(z.uuid()).max(2000).optional(),
});

export const linkCheckStateSchema = z.enum(['ok', 'redirected', 'dead']);
export type LinkCheckState = z.infer<typeof linkCheckStateSchema>;

export const linkCheckResultSchema = z.object({
  id: z.string(),
  state: linkCheckStateSchema,
  httpStatus: z.int().nullable(),
  message: z.string().nullable(),
  /** Final URL after redirects, when different from the bookmark's own. */
  finalUrl: z.string().nullable(),
});
export type LinkCheckResult = z.infer<typeof linkCheckResultSchema>;

export const checkLinksResponseSchema = z.object({
  results: z.array(linkCheckResultSchema),
  checkedAt: isoDateTimeSchema,
});
export type CheckLinksResponse = z.infer<typeof checkLinksResponseSchema>;

/** `GET /api/favicons/title?url=` */
export const pageTitleResponseSchema = z.object({ title: z.string().nullable() });
export type PageTitleResponse = z.infer<typeof pageTitleResponseSchema>;

/* -----------------------------------------------------------------------------------------
 * Pushover outage notifications (server-only state; never part of the synced `settings`).
 * `GET/PUT /api/services/notifications`, `DELETE …/credentials`, `POST …/test`.
 * --------------------------------------------------------------------------------------- */

/** Pushover application tokens and user/group keys: 30 characters of [A-Za-z0-9]. */
export const PUSHOVER_KEY_PATTERN = /^[A-Za-z0-9]{30}$/;

export const pushoverKeySchema = z
  .string()
  .trim()
  .regex(PUSHOVER_KEY_PATTERN, { error: 'Must be exactly 30 letters and digits' });

/** Pushover's built-in notification sounds (`none` = silent). */
export const PUSHOVER_SOUNDS = [
  'pushover',
  'bike',
  'bugle',
  'cashregister',
  'classical',
  'cosmic',
  'falling',
  'gamelan',
  'incoming',
  'intermission',
  'magic',
  'mechanical',
  'pianobar',
  'siren',
  'spacealarm',
  'tugboat',
  'alien',
  'climb',
  'persistent',
  'echo',
  'updown',
  'vibrate',
  'none',
] as const;
export const pushoverSoundSchema = z.enum(PUSHOVER_SOUNDS);

/** Minimum time a confirmed outage must last before the down alert is sent. */
export const NOTIFY_MIN_DOWN_MINUTES = [0, 2, 5, 10, 15] as const;
/** Reminder interval while a service stays down (0 = off). */
export const NOTIFY_REPEAT_MINUTES = [0, 30, 60, 360, 1440] as const;

export const notificationOptionsSchema = z.strictObject({
  notifyDown: z.boolean().default(true),
  notifyRecovery: z.boolean().default(true),
  minDownMinutes: z.literal(NOTIFY_MIN_DOWN_MINUTES, { error: 'Unsupported delay' }).default(0),
  repeatMinutes: z
    .literal(NOTIFY_REPEAT_MINUTES, { error: 'Unsupported reminder interval' })
    .default(0),
  /** Pushover priority 0 (normal) or 1 (high). Emergency (2) is deliberately not offered. */
  downPriority: z.enum(['normal', 'high']).default('normal'),
  /** Pushover priority -1 (low: no sound) or 0 (normal). */
  recoveryPriority: z.enum(['low', 'normal']).default('normal'),
  /** Send to one device only (Pushover device name), or null for all devices. */
  device: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,25}$/, { error: 'Up to 25 letters, digits, "_" or "-"' })
    .nullable()
    .default(null),
  sound: pushoverSoundSchema.nullable().default(null),
});
export type NotificationOptions = z.infer<typeof notificationOptionsSchema>;

export const DEFAULT_NOTIFICATION_OPTIONS: NotificationOptions = notificationOptionsSchema.parse(
  {},
);

/** Where a credential comes from: saved on the server, or the server's env file (read-only). */
export const credentialSourceSchema = z.enum(['saved', 'env']);

/** A credential as shown to the browser: never the value, only whether it is set. */
export const maskedCredentialSchema = z.object({
  configured: z.boolean(),
  /** Last 4 characters, e.g. "…a1B2", or null when not configured. */
  hint: z.string().max(8).nullable(),
  source: credentialSourceSchema.nullable(),
});
export type MaskedCredential = z.infer<typeof maskedCredentialSchema>;

/** `GET /api/services/notifications` (also returned by PUT and DELETE …/credentials). */
export const notificationConfigResponseSchema = z.object({
  enabled: z.boolean(),
  /** Both credentials are present. */
  configured: z.boolean(),
  token: maskedCredentialSchema,
  userKey: maskedCredentialSchema,
  options: notificationOptionsSchema,
  delivery: z.object({
    lastSuccessAt: isoDateTimeSchema.nullable(),
    lastErrorAt: isoDateTimeSchema.nullable(),
    /** Pushover's own error text (or a short network reason), secrets redacted. */
    lastError: z.string().max(500).nullable(),
    /** Automatic alerts are paused after Pushover rejected a request (4xx) until the next save. */
    paused: z.boolean(),
  }),
});
export type NotificationConfigResponse = z.infer<typeof notificationConfigResponseSchema>;

/**
 * `PUT /api/services/notifications`. `token` and `userKey` are optional: leave them out to keep
 * the saved values and change only the options.
 */
export const notificationConfigRequestSchema = z.strictObject({
  enabled: z.boolean(),
  token: pushoverKeySchema.optional(),
  userKey: pushoverKeySchema.optional(),
  options: notificationOptionsSchema,
});
export type NotificationConfigRequest = z.input<typeof notificationConfigRequestSchema>;

/** `POST /api/services/notifications/test` (empty body). */
export const notificationTestResponseSchema = z.object({
  ok: z.literal(true),
  sentAt: isoDateTimeSchema,
});
export type NotificationTestResponse = z.infer<typeof notificationTestResponseSchema>;
