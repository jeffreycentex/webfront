import {
  checkLinksResponseSchema,
  checkNowResponseSchema,
  pageTitleResponseSchema,
  type CheckLinksResponse,
} from '@webfront/shared';
import { apiFetch } from '@/lib/api';
import { fallbackTitle } from './model';

/** Server-only actions (everything else goes through `@/data`). */

/** URL the favicon endpoint serves; keyed by origin so the browser caches one icon per site. */
export function faviconSrc(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `/api/favicons?url=${encodeURIComponent(u.origin + '/')}`;
  } catch {
    return null;
  }
}

/** Page title for quick-add: from the server when possible, else the hostname. */
export async function resolveTitle(url: string, online: boolean): Promise<string> {
  if (online) {
    try {
      const res = await apiFetch(`/api/favicons/title?url=${encodeURIComponent(url)}`, {
        schema: pageTitleResponseSchema,
      });
      if (res.title) return res.title;
    } catch {
      // Fall through to the hostname.
    }
  }
  return fallbackTitle(url);
}

export function checkLinks(ids?: string[]): Promise<CheckLinksResponse> {
  return apiFetch('/api/services/check-links', {
    method: 'POST',
    body: ids ? { ids } : {},
    schema: checkLinksResponseSchema,
  });
}

export function checkServicesNow() {
  return apiFetch('/api/services/check-now', {
    method: 'POST',
    body: {},
    schema: checkNowResponseSchema,
  });
}
