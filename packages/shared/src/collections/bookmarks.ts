import { z } from 'zod';
import { colourKeySchema } from '../colours.js';
import { sortKeySchema } from '../sortKey.js';
import {
  nameField,
  notesField,
  nullableRef,
  shortTextField,
  tagField,
  urlField,
} from './common.js';

/** Owner: Task 5 (Bookmarks). */

/** Categories, nested at most one level (a category with a parentId cannot itself be a parent). */
export const bookmarkCategoryFields = z.object({
  name: nameField,
  colour: colourKeySchema.default('blue'),
  parentId: nullableRef,
  sortKey: sortKeySchema,
});

const timeoutMs = z.int().min(500).max(30_000).default(5_000);

/** How the server health-checks a bookmark flagged as a service. */
export const serviceCheckSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('http'),
    /** URL to probe; null = the bookmark's own url. */
    url: urlField.nullable().default(null),
    method: z.enum(['GET', 'HEAD']).default('GET'),
    /** Exact status expected; null = any non-5xx status counts as up. */
    expectedStatus: z.int().min(100).max(599).nullable().default(null),
    /** Accept self-signed / invalid certificates (homelab default). */
    allowInsecureTls: z.boolean().default(true),
    timeoutMs,
  }),
  z.object({
    type: z.literal('tcp'),
    host: z.string().trim().min(1).max(253),
    port: z.int().min(1).max(65_535),
    timeoutMs,
  }),
]);
export type ServiceCheck = z.infer<typeof serviceCheckSchema>;

export const bookmarkFields = z.object({
  url: urlField,
  title: nameField,
  /** null = uncategorised. */
  categoryId: nullableRef,
  tags: z.array(tagField).max(50).default([]),
  /** Credential hint only: a username and a reminder, never a real password. */
  username: shortTextField.nullable().default(null),
  hint: shortTextField.nullable().default(null),
  /** Markdown. */
  notes: notesField.default(''),
  sortKey: sortKeySchema,
  isService: z.boolean().default(false),
  /** Required when isService is true (enforced by the UI; the checker skips nulls). */
  serviceCheck: serviceCheckSchema.nullable().default(null),
});
