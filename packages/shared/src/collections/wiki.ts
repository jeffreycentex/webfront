import { z } from 'zod';
import { colourKeySchema } from '../colours.js';
import { clientIdSchema } from '../ids.js';
import { isoDateTimeSchema } from '../record.js';
import { sortKeySchema } from '../sortKey.js';
import { longTextField, nameField, nullableRef, refField } from './common.js';

/** Owner: Task 8 (Wiki). */

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const wikiPageFields = z.object({
  title: nameField,
  /** URL slug, unique among live pages (enforced by the app, not the schema). */
  slug: z.string().min(1).max(200).regex(SLUG_PATTERN),
  /** Previous slugs (newest first): `/wiki/<old>` redirects here after a rename. */
  oldSlugs: z.array(z.string().min(1).max(200).regex(SLUG_PATTERN)).max(20).default([]),
  /** Page tree parent; null = top level. Top-level pages are "sections" and may carry a colour. */
  parentId: nullableRef,
  /** Markdown. Merged with a client-side three-way merge (registry `textMergeFields`). */
  body: longTextField.default(''),
  colour: colourKeySchema.nullable().default(null),
  sortKey: sortKeySchema,
  /**
   * The latest wikiRevisions snapshot this body is known to descend from: moved forward when a
   * three-way merge (or a restore) produces a new body. Informational; the merge itself finds
   * its common ancestor through `bodyBase` (see the wiki's bodySync.ts). null = none yet.
   */
  baseRevisionId: nullableRef,
  /**
   * Fingerprint (`hashText`) of the text this body was edited from, i.e. the common ancestor a
   * three-way merge can use. Written together with the body by the wiki; a replica whose own
   * unsynced text is replaced by a body with a different `bodyBase` knows the two were
   * concurrent edits and merges them instead of losing its own. null = unknown.
   */
  bodyBase: z.string().max(64).nullable().default(null),
  /** Pinned pages appear on the dashboard widget. */
  pinned: z.boolean().default(false),
  /** Set when a three-way merge failed: the other side's body is kept here and the page is flagged. */
  conflict: z
    .object({
      body: longTextField,
      revisionId: z.uuid().nullable(),
      detectedAt: isoDateTimeSchema,
    })
    .nullable()
    .default(null),
});

/**
 * Immutable snapshots of a page body. Created, never edited, except when pruned: the body is
 * emptied and the record tombstoned, so old revisions do not keep using storage.
 */
export const wikiRevisionFields = z.object({
  pageId: refField,
  title: nameField,
  body: longTextField,
  /** Revision this one was derived from; null for the first. */
  parentRevisionId: nullableRef,
  /** Replica that created the revision. */
  authorClientId: clientIdSchema.nullable().default(null),
});
