import net from 'node:net';
import type { LinkCheckResult, RecordOf, ServiceCheck, ServiceState } from '@webfront/shared';
import { describeError, type HttpGet } from '../favicons/httpClient.js';

/** Service probing logic (pure of timers and storage so tests can inject everything). */

export type TcpConnect = (host: string, port: number, timeoutMs: number) => Promise<void>;

export const tcpConnect: TcpConnect = (host, port, timeoutMs) =>
  new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host, port });
    const fail = (err: Error) => {
      socket.destroy();
      reject(err);
    };
    socket.setTimeout(timeoutMs, () =>
      fail(Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' })),
    );
    socket.once('error', fail);
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
  });

export interface ProbeDeps {
  httpGet: HttpGet;
  tcpConnect: TcpConnect;
  now: () => number;
}

export interface ProbeResult {
  state: Exclude<ServiceState, 'unknown'>;
  latencyMs: number;
  message: string | null;
}

type Bookmark = RecordOf<'bookmarks'>;

/** Probe one service once. Never throws. */
export async function probeService(
  bookmark: Pick<Bookmark, 'url'>,
  check: ServiceCheck,
  deps: ProbeDeps,
): Promise<ProbeResult> {
  const started = deps.now();
  try {
    if (check.type === 'tcp') {
      await deps.tcpConnect(check.host, check.port, check.timeoutMs);
      return { state: 'up', latencyMs: deps.now() - started, message: null };
    }
    const res = await deps.httpGet({
      url: check.url ?? bookmark.url,
      method: check.method,
      timeoutMs: check.timeoutMs,
      maxBytes: 1024,
      maxRedirects: 0,
      insecureTls: check.allowInsecureTls,
    });
    const latencyMs = deps.now() - started;
    const ok =
      check.expectedStatus === null ? res.status < 500 : res.status === check.expectedStatus;
    return { state: ok ? 'up' : 'down', latencyMs, message: ok ? null : `HTTP ${res.status}` };
  } catch (err) {
    return { state: 'down', latencyMs: deps.now() - started, message: describeError(err) };
  }
}

/** Round latency up to a coarse bucket so small jitter never rewrites a status record. */
export function latencyBucket(ms: number): number {
  for (const b of [50, 100, 250, 500, 1000, 2500, 5000]) if (ms <= b) return b;
  return 10_000;
}

/** ISO timestamp rounded down to `stepMs` (default 5 minutes). */
export function coarseIso(ms: number, stepMs = 5 * 60_000): string {
  return new Date(Math.floor(ms / stepMs) * stepMs).toISOString().replace(/\.\d{3}Z$/, '.000Z');
}

export interface StatusView {
  state: ServiceState;
  checkedAt: string | null;
  message: string | null;
}

export const STATUS_REFRESH_MS = 30 * 60_000;
export const DOWN_AFTER_FAILURES = 2;

export interface Decision {
  write: boolean;
  state: ServiceState;
  changedAt: string | null;
}

/**
 * Decide whether a probe result should be written. A record is written only when the state or
 * message changes (up -> down requires `DOWN_AFTER_FAILURES` consecutive failures, so a single
 * blip does not flap), on first sight, or as a slow heartbeat so `checkedAt` does not go stale.
 */
export function decideWrite(
  prev: (StatusView & { changedAt: string | null }) | undefined,
  result: ProbeResult,
  consecutiveFailures: number,
  nowMs: number,
): Decision {
  const nowIso = coarseIso(nowMs, 1000);
  if (!prev || prev.state === 'unknown') {
    return { write: true, state: result.state, changedAt: nowIso };
  }
  let state: ServiceState = result.state;
  if (result.state === 'down' && prev.state === 'up' && consecutiveFailures < DOWN_AFTER_FAILURES) {
    state = 'up';
  }
  if (state !== prev.state) return { write: true, state, changedAt: nowIso };
  const message = state === 'down' ? result.message : null;
  if (message !== prev.message) return { write: true, state, changedAt: prev.changedAt };
  const stale = !prev.checkedAt || nowMs - Date.parse(prev.checkedAt) > STATUS_REFRESH_MS;
  return { write: stale, state, changedAt: prev.changedAt };
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Dead-link check for one bookmark. Never throws. */
export async function checkLink(
  bookmark: Pick<Bookmark, 'id' | 'url'>,
  deps: { httpGet: HttpGet },
): Promise<LinkCheckResult> {
  try {
    const res = await deps.httpGet({
      url: bookmark.url,
      method: 'GET',
      timeoutMs: 8_000,
      maxBytes: 2048,
      maxRedirects: 5,
      insecureTls: true,
    });
    const finalUrl = res.url !== bookmark.url && res.redirects > 0 ? res.url : null;
    // Auth walls and bot blockers mean the page exists.
    const alive =
      (res.status >= 200 && res.status < 400) || [401, 403, 405, 429, 999].includes(res.status);
    if (!alive) {
      return {
        id: bookmark.id,
        state: 'dead',
        httpStatus: res.status,
        message: `HTTP ${res.status}`,
        finalUrl,
      };
    }
    const moved = finalUrl !== null && new URL(finalUrl).origin !== new URL(bookmark.url).origin;
    return {
      id: bookmark.id,
      state: moved ? 'redirected' : 'ok',
      httpStatus: res.status,
      message: null,
      finalUrl,
    };
  } catch (err) {
    return {
      id: bookmark.id,
      state: 'dead',
      httpStatus: null,
      message: describeError(err),
      finalUrl: null,
    };
  }
}
