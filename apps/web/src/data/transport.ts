import {
  API,
  SYNC_EVENT,
  pullResponseSchema,
  pushResponseSchema,
  syncChangedEventSchema,
  syncHelloEventSchema,
} from '@webfront/shared';
import { apiFetch } from '@/lib/api';
import type { SyncEventHandlers, SyncTransport } from './engine';

/** HTTP transport over `apiFetch` plus an EventSource for pokes. */
export function createHttpTransport(): SyncTransport {
  return {
    push: (request) =>
      apiFetch(API.sync.push, { method: 'POST', body: request, schema: pushResponseSchema }),
    pull: (since, limit) =>
      apiFetch(`${API.sync.pull}?since=${since}&limit=${limit}`, { schema: pullResponseSchema }),
    connectEvents: connectEventSource,
  };
}

const SSE_RETRY_MIN_MS = 2_000;
const SSE_RETRY_MAX_MS = 60_000;

function connectEventSource(clientId: string, handlers: SyncEventHandlers): () => void {
  if (typeof EventSource === 'undefined') return () => {};
  let closed = false;
  let es: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;

  const parse = <T>(schema: { safeParse(v: unknown): { success: boolean; data?: T } }, raw: string) => {
    try {
      const r = schema.safeParse(JSON.parse(raw));
      return r.success ? (r.data as T) : undefined;
    } catch {
      return undefined;
    }
  };

  const open = () => {
    if (closed) return;
    es = new EventSource(`${API.sync.events}?clientId=${encodeURIComponent(clientId)}`, {
      withCredentials: true,
    });
    es.addEventListener(SYNC_EVENT.hello, (e) => {
      failures = 0;
      const data = parse(syncHelloEventSchema, (e as MessageEvent<string>).data);
      if (data) handlers.onHello(data);
    });
    es.addEventListener(SYNC_EVENT.changed, (e) => {
      const data = parse(syncChangedEventSchema, (e as MessageEvent<string>).data);
      if (data) handlers.onChanged(data);
    });
    es.onerror = () => {
      handlers.onError();
      // CONNECTING: the browser retries by itself. CLOSED (e.g. HTTP 401/5xx): we retry.
      if (es && es.readyState === EventSource.CLOSED) {
        es.close();
        es = null;
        failures++;
        const delay = Math.min(SSE_RETRY_MAX_MS, SSE_RETRY_MIN_MS * 2 ** (failures - 1));
        retry = setTimeout(open, delay / 2 + Math.random() * (delay / 2));
      }
    };
  };

  open();
  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    es?.close();
    es = null;
  };
}
