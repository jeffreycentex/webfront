import { useEffect, useSyncExternalStore } from 'react';
import { safeStorage } from '../lib/platform';

/**
 * Idle lock setting: minutes of inactivity before the lock screen shows (0 = off, the default).
 * A per-device convenience stored in localStorage; the settings screen can bind a control to
 * `useIdleLockMinutes()`.
 */
export const IDLE_LOCK_KEY = 'wf.lock.minutes';
const listeners = new Set<() => void>();

export function getIdleLockMinutes(): number {
  const n = Number(safeStorage.get(IDLE_LOCK_KEY));
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 24 * 60) : 0;
}

export function setIdleLockMinutes(minutes: number): void {
  safeStorage.set(IDLE_LOCK_KEY, String(Math.max(0, Math.round(minutes))));
  for (const l of listeners) l();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useIdleLockMinutes(): [number, (minutes: number) => void] {
  const minutes = useSyncExternalStore(subscribe, getIdleLockMinutes, () => 0);
  return [minutes, setIdleLockMinutes];
}

/** Lock after `minutes` without input. Uses wall-clock time, so a sleeping tab locks on wake. */
export function useIdleLock(active: boolean, minutes: number, lock: () => void): void {
  useEffect(() => {
    if (!active || minutes <= 0) return;
    let last = Date.now();
    const touch = () => {
      last = Date.now();
    };
    const check = () => {
      if (Date.now() - last >= minutes * 60_000) lock();
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    for (const e of events) window.addEventListener(e, touch, { passive: true });
    const onVisible = () => document.visibilityState === 'visible' && check();
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(check, 10_000);
    return () => {
      for (const e of events) window.removeEventListener(e, touch);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
    };
  }, [active, minutes, lock]);
}
