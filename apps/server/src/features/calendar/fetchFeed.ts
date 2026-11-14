/**
 * Safe ICS download. The feed URL is a secret: every error raised from here carries a fixed,
 * URL-free message, and nothing here logs.
 */

export const FETCH_TIMEOUT_MS = 20_000;
export const MAX_FEED_BYTES = 10 * 1024 * 1024;
export const MAX_REDIRECTS = 5;

/** Error whose message is safe to show to the user and store in `lastError`. */
export class FeedFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedFetchError';
  }
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export type FeedFetchResult =
  | { status: 'ok'; body: string; etag: string | null; lastModified: string | null }
  | { status: 'not_modified' };

export interface FeedFetchOptions {
  fetch?: FetchFn;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  etag?: string | null;
  lastModified?: string | null;
}

/** `webcal(s)://` becomes `https://`; only http and https survive. Throws FeedFetchError. */
export function normaliseFeedUrl(raw: string): URL {
  let s = raw.trim();
  s = s.replace(/^webcals?:\/\//i, 'https://');
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new FeedFetchError('The feed address is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new FeedFetchError('Only http, https and webcal addresses are supported');
  }
  return url;
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new FeedFetchError('The calendar file is too large');
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new FeedFetchError('The calendar file is too large');
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder('utf-8').decode(buf);
}

export async function fetchFeed(
  rawUrl: string,
  options: FeedFetchOptions = {},
): Promise<FeedFetchResult> {
  const doFetch: FetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  const maxBytes = options.maxBytes ?? MAX_FEED_BYTES;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const signal = AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS);

  const headers: Record<string, string> = {
    accept: 'text/calendar, text/plain;q=0.8, */*;q=0.5',
    'user-agent': 'Webfront-Calendar/1',
  };
  if (options.etag) headers['if-none-match'] = options.etag;
  if (options.lastModified) headers['if-modified-since'] = options.lastModified;

  try {
    let url = normaliseFeedUrl(rawUrl);
    for (let hop = 0; ; hop++) {
      const res = await doFetch(url.toString(), { headers, redirect: 'manual', signal });
      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        const location = res.headers.get('location');
        await res.body?.cancel().catch(() => undefined);
        if (!location) throw new FeedFetchError('The server sent a redirect without a location');
        if (hop >= maxRedirects) throw new FeedFetchError('Too many redirects');
        try {
          url = normaliseFeedUrl(new URL(location, url).toString());
        } catch {
          throw new FeedFetchError('The server redirected to an unsupported address');
        }
        continue;
      }
      if (res.status === 304) {
        await res.body?.cancel().catch(() => undefined);
        return { status: 'not_modified' };
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new FeedFetchError(`The calendar server answered HTTP ${res.status}`);
      }
      const body = await readCapped(res, maxBytes);
      if (!/BEGIN:VCALENDAR/i.test(body)) {
        throw new FeedFetchError('The address did not return an iCalendar (.ics) file');
      }
      return {
        status: 'ok',
        body,
        etag: res.headers.get('etag'),
        lastModified: res.headers.get('last-modified'),
      };
    }
  } catch (err) {
    if (err instanceof FeedFetchError) throw err;
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new FeedFetchError('The calendar server took too long to respond');
    }
    // Never forward err.message: undici errors can embed the host or URL.
    throw new FeedFetchError('Could not reach the calendar server');
  }
}
