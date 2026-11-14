import { describeError, HttpClientError, parseHttpUrl, type HttpGet } from './httpClient.js';

/** Pure helpers: finding an icon link in HTML, sniffing image types, extracting titles. */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, g: string) => {
    if (g[0] === '#') {
      const code =
        g[1]?.toLowerCase() === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      if (!Number.isFinite(code) || code < 32 || code > 0x10ffff) return ' ';
      try {
        return String.fromCodePoint(code);
      } catch {
        return ' ';
      }
    }
    return ENTITIES[g.toLowerCase()] ?? m;
  });
}

function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  const inner = tag.replace(/^<\s*\w+/, '').replace(/\/?>$/, '');
  for (const m of inner.matchAll(re)) {
    const name = m[1]!.toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

export interface IconCandidate {
  url: string;
  score: number;
}

/** Icon `<link>` tags in document order, best first, resolved against `base`. */
export function extractIconLinks(html: string, base: string): IconCandidate[] {
  const head = html.slice(0, 200_000);
  const out: IconCandidate[] = [];
  const seen = new Set<string>();
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const a = parseAttrs(m[0]);
    const rel = (a['rel'] ?? '').toLowerCase().split(/\s+/);
    const href = a['href']?.trim();
    if (!href || href.startsWith('data:')) continue;
    const isIcon = rel.includes('icon');
    const isApple = rel.includes('apple-touch-icon');
    if (!isIcon && !isApple) continue;
    let resolved: string;
    try {
      const u = new URL(href, base);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      resolved = u.href;
    } catch {
      continue;
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    // Prefer icons around 32-64px; SVG and unsized icons are fine; huge touch icons last.
    let score = isApple ? 1 : 3;
    const size = parseInt((a['sizes'] ?? '').split(/[x\s]/)[0] ?? '', 10);
    if (Number.isFinite(size)) score += size >= 32 && size <= 96 ? 2 : size > 96 ? 0 : 1;
    if ((a['type'] ?? '').includes('svg') || resolved.toLowerCase().endsWith('.svg')) score += 1;
    out.push({ url: resolved, score });
  }
  // Stable sort: higher score first, document order otherwise.
  return out
    .map((c, i) => ({ c, i }))
    .sort((x, y) => y.c.score - x.c.score || x.i - y.i)
    .map((x) => x.c);
}

export const ICON_TYPES = [
  'image/png',
  'image/gif',
  'image/jpeg',
  'image/webp',
  'image/x-icon',
  'image/svg+xml',
] as const;
export type IconType = (typeof ICON_TYPES)[number];

/** Identify an image by its first bytes; never trusts the server's Content-Type. */
export function sniffImage(buf: Buffer): IconType | null {
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png';
  if (
    buf.length >= 6 &&
    (buf.toString('latin1', 0, 6) === 'GIF87a' || buf.toString('latin1', 0, 6) === 'GIF89a')
  )
    return 'image/gif';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf.length >= 12 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  if (
    buf.length >= 6 &&
    buf[0] === 0 &&
    buf[1] === 0 &&
    buf[2] === 1 &&
    buf[3] === 0 &&
    (buf[4] ?? 0) > 0
  )
    return 'image/x-icon';
  const head = buf.toString('utf8', 0, Math.min(buf.length, 1024)).replace(/^﻿/, '').trimStart();
  if (/^(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?<svg[\s>]/i.test(head)) {
    // Served with CSP sandbox, but refuse anything that looks active anyway.
    const text = buf.toString('utf8');
    if (/<script|<foreignObject|\son[a-z]+\s*=|javascript:/i.test(text)) return null;
    return 'image/svg+xml';
  }
  return null;
}

export function extractTitle(html: string): string | null {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html.slice(0, 200_000));
  const og = /<meta\b[^>]*property\s*=\s*["']og:title["'][^>]*>/i.exec(html.slice(0, 200_000));
  let raw = m?.[1];
  if (!raw?.trim() && og) raw = parseAttrs(og[0])['content'];
  if (!raw) return null;
  const t = decodeEntities(raw).replace(/\s+/g, ' ').trim().slice(0, 200);
  return t || null;
}

export interface FoundIcon {
  contentType: IconType;
  data: Buffer;
}

export interface IconFetchDeps {
  httpGet: HttpGet;
}

const PAGE_TIMEOUT = 6_000;
const ICON_TIMEOUT = 5_000;
const MAX_PAGE_BYTES = 256 * 1024;
export const MAX_ICON_BYTES = 128 * 1024;
const MAX_CANDIDATES = 4;

/** Find the site's icon: `<link>` tags on the page first, then `/favicon.ico`. */
export async function findIcon(pageUrl: string, deps: IconFetchDeps): Promise<FoundIcon | null> {
  const page = parseHttpUrl(pageUrl);
  const candidates: string[] = [];
  try {
    const res = await deps.httpGet({
      url: page.href,
      timeoutMs: PAGE_TIMEOUT,
      maxBytes: MAX_PAGE_BYTES,
      maxRedirects: 3,
      insecureTls: true,
      accept: 'text/html,application/xhtml+xml',
    });
    const ct = (res.headers['content-type'] ?? '').toLowerCase();
    if (res.status >= 200 && res.status < 300 && (ct === '' || ct.includes('html'))) {
      for (const c of extractIconLinks(res.body.toString('utf8'), res.url)) candidates.push(c.url);
    }
  } catch {
    // Fall through to /favicon.ico (the page itself may be down or not HTML).
  }
  const fallback = new URL('/favicon.ico', page).href;
  if (!candidates.includes(fallback)) candidates.push(fallback);

  for (const url of candidates.slice(0, MAX_CANDIDATES + 1)) {
    try {
      const res = await deps.httpGet({
        url,
        timeoutMs: ICON_TIMEOUT,
        maxBytes: MAX_ICON_BYTES,
        maxRedirects: 3,
        insecureTls: true,
        accept: 'image/*',
      });
      if (res.status !== 200 || res.truncated || res.body.length < 16) continue;
      const type = sniffImage(res.body);
      if (type) return { contentType: type, data: res.body };
    } catch (err) {
      if (err instanceof HttpClientError && err.code === 'bad_protocol') continue;
      void describeError(err);
    }
  }
  return null;
}

export async function findTitle(pageUrl: string, deps: IconFetchDeps): Promise<string | null> {
  const page = parseHttpUrl(pageUrl);
  const res = await deps.httpGet({
    url: page.href,
    timeoutMs: PAGE_TIMEOUT,
    maxBytes: MAX_PAGE_BYTES,
    maxRedirects: 3,
    insecureTls: true,
    accept: 'text/html,application/xhtml+xml',
  });
  const ct = (res.headers['content-type'] ?? '').toLowerCase();
  if (res.status < 200 || res.status >= 300 || (ct !== '' && !ct.includes('html'))) return null;
  return extractTitle(res.body.toString('utf8'));
}
