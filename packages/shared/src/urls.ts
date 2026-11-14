/**
 * URL safety for anything the web app turns into a link or navigates to.
 *
 * Stored URLs (bookmarks, imported files, synced records) are user data and schema-valid
 * `z.url()` values may use any scheme, including `javascript:`, `data:` or `vbscript:`. Only
 * http(s) URLs are ever made clickable or opened; everything else is treated as "no link".
 */

/** The URL, normalised, if it is an absolute http(s) URL with a host; otherwise null. */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  return u.href;
}
