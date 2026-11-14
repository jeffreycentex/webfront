import { SLUG_PATTERN } from '@webfront/shared';

/**
 * Text helpers: content fingerprints, slugs and titles.
 */

/**
 * Stable 64-bit fingerprint of a text (two independent 32-bit FNV-1a style hashes plus the
 * length), as 16+ hex chars. Used to name a body version in `bodyBase`; collisions only matter
 * between versions of the same page, so this is ample.
 */
export function hashText(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9747b28c;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
    h2 ^= h2 >>> 15;
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return `${hex(h1)}${hex(h2)}${text.length.toString(36)}`;
}

/** URL slug of a title: lower-case ASCII words joined by "-" (accents folded). */
export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug || 'page';
}

/** `slugify(title)`, made unique against `taken` by appending -2, -3, … */
export function uniqueSlug(title: string, taken: ReadonlySet<string>, own?: string): string {
  const base = slugify(title);
  if (base === own || !taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (candidate === own || !taken.has(candidate)) return candidate;
  }
}

export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug) && slug.length <= 200;
}

/** Case- and whitespace-insensitive key for matching `[[Page title]]` to a page. */
export function titleKey(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

/** URL prefix of images pasted while offline (rewritten to the real URL once uploaded). */
export const PENDING_IMAGE_PREFIX = '/api/attachments/pending/';
