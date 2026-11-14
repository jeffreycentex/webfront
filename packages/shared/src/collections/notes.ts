import { z } from 'zod';
import { colourKeySchema } from '../colours.js';
import { isoDateSchema, isoDateTimeSchema } from '../record.js';
import { sortKeySchema } from '../sortKey.js';
import { nameField, notesField } from './common.js';

/** Owner: Task 6 (Post-its and to-do list). */

export const postitFields = z.object({
  text: z.string().max(10_000),
  colour: colourKeySchema.default('yellow'),
  pinned: z.boolean().default(false),
  /** Archive rather than delete. */
  archived: z.boolean().default(false),
  /** Arrangement order (fractional index); see sortKey.ts. */
  sortKey: sortKeySchema,
});

/**
 * To-do items.
 *
 * Fields other features (the dashboard agenda) may rely on:
 * - `title`: the task text (trimmed, 1..200 chars).
 * - `dueDate`: an all-day LOCAL calendar date `YYYY-MM-DD` (never a timestamp, no zone). It is
 *   compared as a plain string against the viewer's local "today" (`YYYY-MM-DD` built from local
 *   year/month/day), so it never shifts across time zones. `null` = no due date.
 * - `completedAt`: UTC ISO timestamp set when the task is completed, `null` while open. An open
 *   task is `completedAt === null`; "overdue" is open with `dueDate < today`, "due today" is
 *   open with `dueDate === today`.
 * Deleted (tombstoned) tasks are hidden by `@/data` and must not be shown.
 */
export const taskFields = z.object({
  title: nameField,
  notes: notesField.default(''),
  /** Local calendar date, YYYY-MM-DD (all-day, zone-less). `null` = no due date. */
  dueDate: isoDateSchema.nullable().default(null),
  /** Set (UTC ISO timestamp) when completed; null = open. */
  completedAt: isoDateTimeSchema.nullable().default(null),
  sortKey: sortKeySchema,
});
