import { z } from 'zod';
import { colourKeySchema } from '../colours.js';
import { sortKeySchema } from '../sortKey.js';
import { nameField, refField, shortTextField } from './common.js';

/** Owner: Task 7 (Shopping list). */

/** Default store sections for a new list; editable per list. */
export const DEFAULT_SHOPPING_SECTIONS: readonly string[] = [
  'Produce',
  'Bakery',
  'Dairy',
  'Meat & fish',
  'Frozen',
  'Pantry',
  'Drinks',
  'Household',
  'Other',
];

export const shoppingSectionName = z.string().trim().min(1).max(60);

export const shoppingListFields = z.object({
  name: nameField,
  colour: colourKeySchema.default('green'),
  sortKey: sortKeySchema,
  /** Ordered store sections for this list. Items reference them by name. */
  sections: z
    .array(shoppingSectionName)
    .max(40)
    .default(() => [...DEFAULT_SHOPPING_SECTIONS]),
});

export const shoppingItemFields = z.object({
  listId: refField,
  name: nameField,
  /** Free text, e.g. "2", "500 g". */
  quantity: shortTextField.nullable().default(null),
  /** Optional store section name, e.g. "Dairy". */
  section: shortTextField.nullable().default(null),
  checked: z.boolean().default(false),
  sortKey: sortKeySchema,
  /** Free-text note shown under the name. */
  note: shortTextField.default(''),
  /**
   * Staple flag. A list's staples are derived from the flagged item records (soft-deleted ones
   * included, so "Clear checked" keeps them): one staple per name per list. Stored on the item,
   * not as an array on the list, so two devices flagging different items never overwrite each
   * other under per-field last-writer-wins. Defaults to false so existing records stay valid.
   */
  staple: z.boolean().default(false),
});
