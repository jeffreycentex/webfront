import { useSyncExternalStore } from 'react';

function subscribe(fn: () => void): () => void {
  window.addEventListener('online', fn);
  window.addEventListener('offline', fn);
  return () => {
    window.removeEventListener('online', fn);
    window.removeEventListener('offline', fn);
  };
}

/** Browser connectivity (`navigator.onLine`). The server being reachable is a separate matter. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
}

function subscribeMedia(query: string) {
  return (fn: () => void) => {
    const mq = window.matchMedia(query);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  };
}

/** Live `matchMedia` result. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? subscribeMedia(query)
      : () => () => {},
    () =>
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia(query).matches
        : false,
    () => false,
  );
}

/** True below the 640px breakpoint (phone layout). */
export function useIsPhone(): boolean {
  return useMediaQuery('(max-width: 639px)');
}
