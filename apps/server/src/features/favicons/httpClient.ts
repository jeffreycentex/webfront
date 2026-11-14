import http from 'node:http';
import https from 'node:https';

/**
 * Hardened outbound HTTP GET used for favicons, page titles, link checks and service checks.
 *
 * - http/https only; at most `maxRedirects` redirects, each re-validated.
 * - Hard timeout over the whole exchange, and a cap on the bytes read (the socket is destroyed
 *   as soon as the cap is reached).
 * - No cookies or credentials are ever sent, `Accept-Encoding: identity` (no decompression
 *   bombs), and URL credentials are stripped.
 * - Self-signed certificates can be allowed per request (homelab services, own sites).
 *
 * Private addresses are deliberately NOT blocked: the whole point is to reach the user's own
 * LAN services, and every endpoint using this requires a signed-in session.
 */

export interface HttpRequestOptions {
  url: string;
  method?: 'GET' | 'HEAD';
  timeoutMs: number;
  /** Stop reading the body after this many bytes (`truncated` is then true). */
  maxBytes: number;
  maxRedirects: number;
  insecureTls?: boolean;
  accept?: string;
}

export interface HttpResult {
  status: number;
  /** Final URL after redirects. */
  url: string;
  /** Lower-cased header names; repeated headers joined with ", ". */
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
  redirects: number;
}

export type HttpGet = (options: HttpRequestOptions) => Promise<HttpResult>;

export class HttpClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpClientError';
  }
}

const USER_AGENT = 'Webfront/1.0 (+personal homepage; favicon and status checks)';

/** Parse and validate a URL for outbound requests; strips credentials and the fragment. */
export function parseHttpUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpClientError('bad_url', 'Invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new HttpClientError('bad_protocol', 'Only http and https URLs are allowed');
  }
  if (!u.hostname) throw new HttpClientError('bad_url', 'Invalid URL');
  u.username = '';
  u.password = '';
  u.hash = '';
  return u;
}

function once(options: HttpRequestOptions, url: URL, deadline: number): Promise<HttpResult> {
  return new Promise<HttpResult>((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      reject(new HttpClientError('timeout', 'Timed out'));
      return;
    }
    const lib = url.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const req = lib.request(
      url,
      {
        method: options.method ?? 'GET',
        headers: {
          'user-agent': USER_AGENT,
          accept: options.accept ?? '*/*',
          'accept-encoding': 'identity',
        },
        agent: false,
        ...(url.protocol === 'https:' && options.insecureTls ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v;
        }
        const done = () =>
          finish(() =>
            resolve({
              status: res.statusCode ?? 0,
              url: url.href,
              headers,
              body: Buffer.concat(chunks),
              truncated,
              redirects: 0,
            }),
          );
        const len = Number(headers['content-length']);
        if (Number.isFinite(len) && len > options.maxBytes) truncated = true;
        res.on('data', (chunk: Buffer) => {
          if (settled) return;
          const room = options.maxBytes - size;
          if (chunk.length >= room) {
            if (room > 0) chunks.push(chunk.subarray(0, room));
            size += Math.max(room, 0);
            truncated = true;
            done();
            req.destroy();
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        res.on('end', done);
        res.on('error', (err) => finish(() => reject(err)));
        res.on('close', done);
      },
    );
    const timer = setTimeout(() => {
      finish(() => reject(new HttpClientError('timeout', 'Timed out')));
      req.destroy();
    }, remaining);
    req.on('error', (err) => finish(() => reject(err)));
    req.end();
  });
}

/** The real implementation of `HttpGet`. */
export const httpGet: HttpGet = async (options) => {
  const deadline = Date.now() + options.timeoutMs;
  let url = parseHttpUrl(options.url);
  for (let redirects = 0; ; redirects++) {
    const res = await once(options, url, deadline);
    const location = res.headers['location'];
    if (res.status >= 300 && res.status < 400 && location) {
      if (redirects >= options.maxRedirects) {
        if (options.maxRedirects === 0) return { ...res, redirects };
        throw new HttpClientError('too_many_redirects', 'Too many redirects');
      }
      url = parseHttpUrl(new URL(location, url).href);
      continue;
    }
    return { ...res, redirects };
  }
};

/** Short, safe diagnostic for a failed request (never includes URLs or credentials). */
export function describeError(err: unknown): string {
  if (err instanceof HttpClientError) return err.message;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string') return code.slice(0, 60);
  return 'Request failed';
}
