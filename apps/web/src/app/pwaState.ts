import { useSyncExternalStore } from 'react';

/** Service worker lifecycle state, shared between `pwa.ts` (registration) and the UI. */
export interface PwaState {
  /** A new version is installed and waiting: show the "reload" prompt. */
  needRefresh: boolean;
  /** The app shell is cached: it now works offline. */
  offlineReady: boolean;
}

let state: PwaState = { needRefresh: false, offlineReady: false };
let updater: ((reload?: boolean) => Promise<void>) | null = null;
const listeners = new Set<() => void>();

export function setPwaState(patch: Partial<PwaState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function setPwaUpdater(fn: (reload?: boolean) => Promise<void>): void {
  updater = fn;
}

/** Activate the waiting service worker and reload. */
export function applyPwaUpdate(): void {
  void updater?.(true);
}

export function dismissPwaPrompt(): void {
  setPwaState({ needRefresh: false, offlineReady: false });
}

export function usePwaState(): PwaState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
    () => state,
  );
}
