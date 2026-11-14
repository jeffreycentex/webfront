import { apiErrorSchema, CSRF_HEADER } from '@webfront/shared';
import type { z } from 'zod';

/**
 * Typed fetch wrapper for the Webfront API (same origin; dev goes through the Vite proxy).
 * Owner after Task 1: Task 4 (app shell / auth client), which calls `setCsrfToken` after
 * sign-in. Feature code generally does not call the API (it uses `@/data`), except for
 * server-only actions (favicons, "check now", feed refresh, attachment upload).
 *
 *   const info = await apiFetch(API.auth.session, { schema: sessionInfoSchema });
 */

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

type UnauthorizedHandler = (path: string) => void;
let onUnauthorized: UnauthorizedHandler | null = null;

/**
 * Called when any non-auth API request answers 401 (session expired or revoked). The auth
 * provider registers itself here and re-checks the session, which moves the app to the login
 * screen while keeping local data. Returns an unsubscribe function.
 */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): () => void {
  onUnauthorized = handler;
  return () => {
    if (onUnauthorized === handler) onUnauthorized = null;
  };
}

/** True for failures that mean "server not reachable" (offline, or a proxy 502/503/504). */
export function isUnreachable(err: unknown): boolean {
  return (
    err instanceof NetworkError ||
    (err instanceof ApiRequestError && [502, 503, 504].includes(err.status))
  );
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/** Thrown when the request never reached the server (offline, DNS, CORS). */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super('Network request failed', { cause });
    this.name = 'NetworkError';
  }
}

export interface ApiFetchOptions<S extends z.ZodType | undefined> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** JSON-serialised as the request body. */
  body?: unknown;
  /** Validates the JSON response; omit for responses you do not read. */
  schema?: S;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export async function apiFetch<S extends z.ZodType | undefined = undefined>(
  path: string,
  options: ApiFetchOptions<S> = {},
): Promise<S extends z.ZodType ? z.output<S> : unknown> {
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
  const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers[CSRF_HEADER] = csrfToken;

  let res: Response;
  try {
    const init: RequestInit = { method, headers, credentials: 'same-origin' };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    if (options.signal) init.signal = options.signal;
    res = await fetch(path, init);
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new NetworkError(err);
  }

  const text = await res.text();
  const json: unknown = text ? safeJson(text) : undefined;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) onUnauthorized?.(path);
    const parsed = apiErrorSchema.safeParse(json);
    if (parsed.success) {
      const e = parsed.data.error;
      throw new ApiRequestError(res.status, e.code, e.message, e.details);
    }
    throw new ApiRequestError(res.status, 'http_error', `HTTP ${res.status}`);
  }
  return (options.schema ? options.schema.parse(json) : json) as S extends z.ZodType
    ? z.output<S>
    : unknown;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
