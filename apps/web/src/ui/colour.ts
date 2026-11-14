import type { ColourKey } from '@webfront/shared';
import type { CSSProperties } from 'react';

/**
 * Palette helpers. Colours are CSS variables defined in src/styles/index.css for light and
 * dark themes: `--wf-<key>` (strong: dots, left edges, text accents) and `--wf-<key>-soft`
 * (tinted backgrounds: headers, chips, post-its). Never build Tailwind class names from a
 * colour key (they would be purged); use these helpers or `var(--wf-…)` in arbitrary values.
 */
export function colourVar(colour: ColourKey, tone: 'strong' | 'soft' = 'strong'): string {
  return tone === 'soft' ? `var(--wf-${colour}-soft)` : `var(--wf-${colour})`;
}

/**
 * Sets `--c` and `--c-soft` on an element so children can use `bg-[var(--c-soft)]`,
 * `border-[color:var(--c)]`, `text-[color:var(--c)]`, etc. (the `color:` hint matters for
 * text-/border- utilities, where a bare var() is ambiguous with font-size / border-width).
 */
export function colourStyle(colour: ColourKey | null | undefined): CSSProperties {
  if (!colour) return {};
  return {
    ['--c' as string]: colourVar(colour),
    ['--c-soft' as string]: colourVar(colour, 'soft'),
  };
}
