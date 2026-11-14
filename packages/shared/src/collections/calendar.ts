import { z } from 'zod';
import { colourKeySchema } from '../colours.js';
import { isoDateSchema, isoDateTimeSchema } from '../record.js';
import { nameField, refField, urlField } from './common.js';

/** Owner: Task 9 (Calendar). */

/** Rolling window the server expands recurring events into. */
export const CALENDAR_WINDOW_DAYS_BACK = 30;
export const CALENDAR_WINDOW_DAYS_AHEAD = 180;
export const CALENDAR_REFRESH_MINUTES = 15;

/** Client-writable feed configuration. `lastFetchedAt`/`lastError` are written by the server. */
export const calendarFeedFields = z.object({
  name: nameField,
  /** ICS URL (https:// or webcal://). Treat as a secret: never log it. */
  url: urlField,
  colour: colourKeySchema.default('blue'),
  enabled: z.boolean().default(true),
  lastFetchedAt: isoDateTimeSchema.nullable().default(null),
  lastError: z.string().max(1000).nullable().default(null),
  /** Server-written: live occurrences currently stored for this feed. */
  eventCount: z.int().min(0).default(0),
});

/**
 * Server-owned: one record per expanded occurrence within the window. Ids are deterministic
 * (derived from feedId + UID + occurrence start) so refetches update rather than churn.
 */
export const calendarEventFields = z.object({
  feedId: refField,
  uid: z.string().max(1000),
  title: z.string().max(1000),
  location: z.string().max(1000).nullable().default(null),
  description: z.string().max(20_000).nullable().default(null),
  allDay: z.boolean().default(false),
  /** ISO datetime (UTC) for timed events; YYYY-MM-DD for all-day events. */
  start: z.union([isoDateTimeSchema, isoDateSchema]),
  /** Exclusive end, same format as start; null when the feed gives none. */
  end: z.union([isoDateTimeSchema, isoDateSchema]).nullable().default(null),
  /** Link out to the event in its source calendar, if the feed provides one. */
  url: z.string().max(4096).nullable().default(null),
  recurring: z.boolean().default(false),
  /** Original IANA time zone of a timed event (display hint only; `start` is already UTC). */
  tz: z.string().max(100).nullable().default(null),
});
