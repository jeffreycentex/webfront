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
 * - Recurring tasks (`repeat !== null`): completing one NEVER sets `completedAt`; the web app only
 *   moves `dueDate` forward to the next occurrence (and updates `lastCompletedAt` /
 *   `completionCount`). So the contract above holds unchanged for recurring tasks: an open task
 *   is `completedAt === null`, and its `dueDate` is always the next occurrence. Only "Complete
 *   and stop repeating" sets `completedAt`, and it sets `repeat` back to `null` in the same write.
 *   (A client that sets `completedAt` on a recurring task would end the series; it should instead
 *   roll `dueDate` forward as described on `repeat`.)
 * Deleted (tombstoned) tasks are hidden by `@/data` and must not be shown.
 */
export const taskFields = z.object({
  title: nameField,
  notes: notesField.default(''),
  /** Local calendar date, YYYY-MM-DD (all-day, zone-less). `null` = no due date. */
  dueDate: isoDateSchema.nullable().default(null),
  /** Set (UTC ISO timestamp) when completed; null = open. */
  completedAt: isoDateTimeSchema.nullable().default(null),
  /**
   * Repeat rule, `null` = does not repeat. One clocked field: the whole rule is written
   * together, so devices never merge half of one rule with half of another.
   * - `unit`: 'day' | 'week' | 'month' | 'year'; `interval`: every N units (1..999).
   * - `weekdays`: only for 'week': days of the week 0=Sun..6=Sat (sorted, unique). Empty means
   *   "the weekday of the due date". Weeks run Monday to Sunday; with `interval` > 1 the
   *   occurrence weeks are counted from the week of the current due date.
   * - `day`: for 'month' (and the day part of 'year'): the day of the month 1..31 to keep, or
   *   `null` for the due date's own day. It is clamped to short months (31 in February is the
   *   28th/29th) but remembered, so Jan 31 -> Feb 28 -> Mar 31 does not drift.
   * Completing a recurring task moves `dueDate` to the first occurrence strictly after
   * max(dueDate, today): a pure function of (dueDate, rule, local today), see
   * features/tasks/recurrence.ts. Two devices completing the same occurrence offline write the
   * same `dueDate`, so last-writer-wins converges instead of advancing twice.
   */
  repeat: z
    .object({
      unit: z.enum(['day', 'week', 'month', 'year']),
      interval: z.number().int().min(1).max(999).default(1),
      weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
      day: z.number().int().min(1).max(31).nullable().default(null),
    })
    .nullable()
    .default(null),
  /** UTC ISO timestamp of the last time a recurring task was completed; `null` = never. */
  lastCompletedAt: isoDateTimeSchema.nullable().default(null),
  /** How many times a recurring task has been completed (rolled forward). */
  completionCount: z.number().int().min(0).default(0),
  sortKey: sortKeySchema,
});
