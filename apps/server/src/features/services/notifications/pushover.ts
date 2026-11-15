import https from 'node:https';

/**
 * Pushover message API client (https://pushover.net/api).
 *
 * The destination is fixed: HTTPS to api.pushover.net, path /1/messages.json, certificate
 * verification on. Only form field values vary, and every value is encoded with
 * URLSearchParams, so text derived from bookmark titles cannot add or override fields.
 * No redirects are followed (node:https never follows them), the whole exchange has a hard
 * timeout, and at most MAX_RESPONSE_BYTES of the response are read.
 */

export const PUSHOVER_HOST = 'api.pushover.net';
export const PUSHOVER_PATH = '/1/messages.json';
export const PUSHOVER_TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = 16 * 1024;

/** Limits from the API documentation. */
export const LIMITS = { message: 1024, title: 250, url: 512, urlTitle: 100 } as const;

export interface PushoverMessage {
  title: string;
  message: string;
  /** -1 low, 0 normal, 1 high. Emergency (2) is never sent. */
  priority: -1 | 0 | 1;
  url?: string | null;
  urlTitle?: string | null;
  sound?: string | null;
  device?: string | null;
  /** Unix seconds the event happened (shown instead of the receipt time). */
  timestamp?: number | null;
}

export interface PushoverCredentials {
  token: string;
  user: string;
}

/** What the sender returns: the HTTP status and (capped) body text. */
export interface PushoverHttpResponse {
  status: number;
  body: string;
}

/**
 * Transport: POST an urlencoded body to the fixed Pushover endpoint. Injected in tests (no
 * network). Rejects on network errors and timeouts.
 */
export type PushoverSend = (body: string) => Promise<PushoverHttpResponse>;

export class PushoverNetworkError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PushoverNetworkError';
  }
}

/** The real transport. Host, port, path and method are constants. */
export const sendToPushover: PushoverSend = (body) =>
  new Promise<PushoverHttpResponse>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const req = https.request(
      {
        host: PUSHOVER_HOST,
        port: 443,
        path: PUSHOVER_PATH,
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(body),
          'user-agent': 'Webfront/1.0 (service outage alerts)',
          accept: 'application/json',
          'accept-encoding': 'identity',
        },
        agent: false,
        // Certificate verification stays on (the default); never relaxed for this host.
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const done = () =>
          finish(() =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
          );
        res.on('data', (chunk: Buffer) => {
          if (settled) return;
          const room = MAX_RESPONSE_BYTES - size;
          if (chunk.length >= room) {
            if (room > 0) chunks.push(chunk.subarray(0, room));
            size = MAX_RESPONSE_BYTES;
            done();
            req.destroy();
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        res.on('end', done);
        res.on('close', done);
        res.on('error', (err) => finish(() => reject(networkError(err))));
      },
    );
    const timer = setTimeout(() => {
      finish(() => reject(new PushoverNetworkError('Timed out')));
      req.destroy();
    }, PUSHOVER_TIMEOUT_MS);
    req.on('error', (err) => finish(() => reject(networkError(err))));
    req.end(body);
  });

function networkError(err: unknown): PushoverNetworkError {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return new PushoverNetworkError(typeof code === 'string' ? code.slice(0, 60) : 'Network error');
}

/** Remove control characters (newlines are kept in the message body) and cap the length. */
export function cleanText(text: string, max: number, keepNewlines = false): string {
  // eslint-disable-next-line no-control-regex
  const re = keepNewlines ? /[\u0000-\u0009\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g;
  const s = text.replace(re, ' ');
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max - 1).join('') + '…';
}

/** Build the urlencoded form body. Every value is a single encoded field. */
export function encodeMessage(creds: PushoverCredentials, m: PushoverMessage): string {
  const form = new URLSearchParams();
  form.set('token', creds.token);
  form.set('user', creds.user);
  form.set('title', cleanText(m.title, LIMITS.title) || 'Webfront');
  form.set('message', cleanText(m.message, LIMITS.message, true) || '-');
  form.set('priority', String(m.priority));
  if (m.url && m.url.length <= LIMITS.url) {
    form.set('url', m.url);
    if (m.urlTitle) form.set('url_title', cleanText(m.urlTitle, LIMITS.urlTitle));
  }
  if (m.sound) form.set('sound', m.sound);
  if (m.device) form.set('device', m.device);
  if (m.timestamp) form.set('timestamp', String(Math.floor(m.timestamp)));
  return form.toString();
}

/** Replace every occurrence of the secrets in `text`. */
export function redact(text: string, secrets: readonly (string | null | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('[redacted]');
  return out;
}

export type DeliveryOutcome =
  | { kind: 'ok' }
  /** 4xx: the request cannot succeed as sent; do not retry. */
  | { kind: 'rejected'; status: number; error: string }
  /** 5xx, unexpected answer or network failure: retry later. */
  | { kind: 'temporary'; error: string };

/**
 * Send one message and classify the outcome. Never throws, and the returned error text never
 * contains the credentials (Pushover's error strings are redacted defensively).
 */
export async function deliver(
  send: PushoverSend,
  creds: PushoverCredentials,
  m: PushoverMessage,
): Promise<DeliveryOutcome> {
  const secrets = [creds.token, creds.user];
  let res: PushoverHttpResponse;
  try {
    res = await send(encodeMessage(creds, m));
  } catch (err) {
    const reason = err instanceof PushoverNetworkError ? err.message : 'Network error';
    return {
      kind: 'temporary',
      error: cleanText(redact(`Could not reach Pushover (${reason})`, secrets), 300),
    };
  }
  const parsed = parseBody(res.body);
  if (res.status === 200 && parsed?.status === 1) return { kind: 'ok' };
  if (res.status >= 400 && res.status < 500) {
    const text =
      parsed?.errors.join('; ') ||
      (res.status === 429 ? 'Message limit reached' : `HTTP ${res.status}`);
    return {
      kind: 'rejected',
      status: res.status,
      error: cleanText(redact(`Pushover: ${text}`, secrets), 300),
    };
  }
  const text = parsed?.errors.join('; ') || `HTTP ${res.status}`;
  return { kind: 'temporary', error: cleanText(redact(`Pushover: ${text}`, secrets), 300) };
}

function parseBody(body: string): { status: number | null; errors: string[] } | null {
  try {
    const json = JSON.parse(body) as unknown;
    if (!json || typeof json !== 'object') return null;
    const o = json as Record<string, unknown>;
    const errors = Array.isArray(o.errors)
      ? o.errors.filter((e): e is string => typeof e === 'string').slice(0, 5)
      : [];
    return { status: typeof o.status === 'number' ? o.status : null, errors };
  } catch {
    return null;
  }
}
