import { isIP } from 'node:net';
import type { Context } from 'hono';
import type { Config } from '../../config.js';

/**
 * Request helpers: client IP, origin policy and a readable device label.
 */

function normaliseIp(raw: string): string | null {
  let ip = raw.trim();
  // "[::1]:1234" or "1.2.3.4:5678" forms are not expected from tailscale serve, but be lenient.
  if (ip.startsWith('[')) ip = ip.slice(1, ip.indexOf(']'));
  if (ip.toLowerCase().startsWith('::ffff:') && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return isIP(ip) ? ip.toLowerCase() : null;
}

/**
 * Client IP for rate limiting and the sessions list.
 *
 * With `trustProxy` (the default: the server listens on localhost behind `tailscale serve`) the
 * right-most X-Forwarded-For entry is used: that is the one appended by the proxy itself, so a
 * client cannot spoof it by sending its own header. Otherwise the socket address is used.
 */
export function clientIp(c: Context, config: Pick<Config, 'trustProxy'>): string {
  if (config.trustProxy) {
    const xff = c.req.header('x-forwarded-for');
    if (xff) {
      const last = xff.split(',').at(-1);
      const ip = last ? normaliseIp(last) : null;
      if (ip) return ip;
    }
  }
  const env = c.env as { incoming?: { socket?: { remoteAddress?: unknown } } } | undefined;
  const remote = env?.incoming?.socket?.remoteAddress;
  return (typeof remote === 'string' && normaliseIp(remote)) || 'unknown';
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether a mutating request's origin is acceptable.
 *
 * - `Origin` present: must equal `publicOrigin` (outside production, any http(s) loopback
 *   origin is also accepted so `npm start` on :8787 works without configuring PUBLIC_ORIGIN).
 * - `Origin` absent: browsers always send it on cross-origin and same-origin POST/PUT/PATCH/
 *   DELETE fetches, so this is a non-browser client (curl, tests). If `Sec-Fetch-Site` is present
 *   it must say same-origin or none.
 */
export function originAllowed(c: Context, config: Pick<Config, 'publicOrigin' | 'isProduction'>) {
  const origin = c.req.header('origin');
  if (origin !== undefined) {
    if (origin === config.publicOrigin) return true;
    if (!config.isProduction) {
      try {
        const u = new URL(origin);
        return (
          (u.protocol === 'http:' || u.protocol === 'https:') &&
          LOOPBACK_HOSTS.has(u.hostname) &&
          u.origin === origin
        );
      } catch {
        return false;
      }
    }
    return false;
  }
  const site = c.req.header('sec-fetch-site');
  return site === undefined || site === 'same-origin' || site === 'none';
}

/**
 * Fetch-metadata check for every /api request, safe methods included.
 *
 * The session cookie is SameSite=Lax, so a top-level GET navigation from another site still
 * carries it, and on a tailnet every `*.<tailnet>.ts.net` host is the same *site* as this one
 * (ts.net is a public suffix), so even subresource requests from another machine's web UI
 * carry it. Some GET endpoints have side effects (favicons and page titles make the server
 * fetch a caller-chosen URL, which may be on the LAN), so only same-origin requests and
 * user-initiated ones (`none`: typed URL, bookmark) are accepted. Clients that do not send the
 * header (curl, older browsers) are allowed; the Origin and CSRF checks still apply to them.
 */
export function fetchSiteAllowed(c: Context): boolean {
  const site = c.req.header('sec-fetch-site');
  return site === undefined || site === 'same-origin' || site === 'none';
}

/** "Firefox on Windows", "Safari on iPhone", … from a user agent; null if nothing recognisable. */
export function deviceLabel(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  const ua = userAgent;
  const browser = /Edg(?:e|A|iOS)?\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Vivaldi\//.test(ua)
        ? 'Vivaldi'
        : /Firefox\/|FxiOS\//.test(ua)
          ? 'Firefox'
          : /Chrome\/|CriOS\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : null;
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /CrOS/.test(ua)
          ? 'ChromeOS'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Mac OS X|Macintosh/.test(ua)
              ? 'macOS'
              : /Linux/.test(ua)
                ? 'Linux'
                : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os;
}
