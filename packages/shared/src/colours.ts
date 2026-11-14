import { z } from 'zod';

/**
 * The shared 12-colour palette. Data stores only the key; the web app maps each key to
 * light/dark theme values (CSS variables `--wf-<key>` in apps/web/src/styles).
 * Order is the order shown in colour pickers.
 */
export const COLOUR_KEYS = [
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'teal',
  'cyan',
  'blue',
  'indigo',
  'violet',
  'pink',
] as const;

export const colourKeySchema = z.enum(COLOUR_KEYS);
export type ColourKey = z.infer<typeof colourKeySchema>;

/** Deterministic default colour for a tag (or any label) not given an explicit colour. */
export function colourForLabel(label: string): ColourKey {
  // FNV-1a 32-bit over the normalised label.
  let hash = 0x811c9dc5;
  const s = label.trim().toLowerCase();
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return COLOUR_KEYS[(hash >>> 0) % COLOUR_KEYS.length]!;
}
