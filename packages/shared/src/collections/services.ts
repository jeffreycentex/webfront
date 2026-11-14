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
