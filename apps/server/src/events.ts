import type { CollectionName } from '@webfront/shared';
import type { Logger } from './logger.js';

/**
 * In-process, synchronous, typed event bus. Listeners must not throw (errors are logged and
 * swallowed so one bad listener cannot break a write path).
 *
 * Add new events to `ServerEvents` (Task 1 file; coordinate via docs/CONTRACTS.md).
 */
export interface ServerEvents {
  /**
   * Emitted by the sync feature after records were written (client push or server write).
   * The SSE endpoint turns this into a `changed` poke.
   */
  'records.changed': {
    maxSeq: number;
    collections: CollectionName[];
    /** Client that pushed the change; null for server-originated writes. */
    originClientId: string | null;
  };
  /** Emitted by auth when a session is revoked/expired so SSE connections can be closed. */
  'session.revoked': { sessionId: string };
}

export type ServerEventName = keyof ServerEvents;
export type Listener<K extends ServerEventName> = (payload: ServerEvents[K]) => void;

export interface EventBus {
  /** Subscribe; returns an unsubscribe function. */
  on<K extends ServerEventName>(event: K, listener: Listener<K>): () => void;
  emit<K extends ServerEventName>(event: K, payload: ServerEvents[K]): void;
}

export function createEventBus(logger: Logger): EventBus {
  const listeners = new Map<ServerEventName, Set<(p: unknown) => void>>();
  return {
    on(event, listener) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      const fn = listener as (p: unknown) => void;
      set.add(fn);
      return () => {
        set.delete(fn);
      };
    },
    emit(event, payload) {
      for (const fn of [...(listeners.get(event) ?? [])]) {
        try {
          fn(payload);
        } catch (err) {
          logger.error('event listener failed', { event, err });
        }
      }
    },
  };
}
