import { useSyncExternalStore } from 'react';

/** Per-device dashboard density (compact is the default). Stored in localStorage. */
export type Density = 'compact' | 'comfortable';
export const DENSITY_KEY = 'wf.density';
const listeners = new Set<() => void>();

export function getDensity(): Density {
  try {
    return localStorage.getItem(DENSITY_KEY) === 'comfortable' ? 'comfortable' : 'compact';
  } catch {
    return 'compact';
  }
}

export function setDensity(next: Density): void {
  try {
    localStorage.setItem(DENSITY_KEY, next);
  } catch {
    /* storage blocked: the choice lasts until reload only */
  }
  for (const l of listeners) l();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => e.key === DENSITY_KEY && fn();
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}

export function useDensity(): [Density, (d: Density) => void] {
  return [useSyncExternalStore(subscribe, getDensity, () => 'compact' as const), setDensity];
}
