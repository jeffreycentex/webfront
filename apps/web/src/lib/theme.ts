import { useSyncExternalStore } from 'react';
import { safeStorage } from './platform';

/**
 * Theme preference: light, dark or system. Persisted in localStorage and applied as the `dark`
 * class on <html>. `public/theme-init.js` (loaded by index.html) applies it before first paint (no flash);
 * `initTheme()` keeps it in sync afterwards (system changes, other tabs).
 */
export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'wf.theme';
/** Browser chrome colours (meta theme-color) per theme; match --wf-bg. */
export const THEME_COLOURS: Record<ResolvedTheme, string> = { light: '#f5f3ee', dark: '#0f0f18' };

const listeners = new Set<() => void>();
let preference: ThemePreference = readStored();
let systemDark = false;

function readStored(): ThemePreference {
  const v = safeStorage.get(THEME_STORAGE_KEY);
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
}

function matchDark(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;
}

export function resolveTheme(pref: ThemePreference, prefersDark: boolean): ResolvedTheme {
  return pref === 'system' ? (prefersDark ? 'dark' : 'light') : pref;
}

function currentResolved(): ResolvedTheme {
  return resolveTheme(preference, systemDark);
}

function apply(): void {
  if (typeof document === 'undefined') return;
  const resolved = currentResolved();
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  root.style.colorScheme = resolved;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', THEME_COLOURS[resolved]);
}

function emit(): void {
  cachedSnapshot = null;
  for (const l of listeners) l();
}

export function getThemePreference(): ThemePreference {
  return preference;
}

export function getResolvedTheme(): ResolvedTheme {
  return currentResolved();
}

export function setThemePreference(next: ThemePreference): void {
  preference = next;
  safeStorage.set(THEME_STORAGE_KEY, next);
  apply();
  emit();
}

/** light -> dark -> system -> light */
export function cycleTheme(): ThemePreference {
  const next: ThemePreference =
    preference === 'light' ? 'dark' : preference === 'dark' ? 'system' : 'light';
  setThemePreference(next);
  return next;
}

let initialised = false;
/** Apply the stored theme and start following system / cross-tab changes. Idempotent. */
export function initTheme(): void {
  preference = readStored();
  const mq = matchDark();
  systemDark = mq?.matches ?? false;
  apply();
  emit();
  if (initialised) return;
  initialised = true;
  mq?.addEventListener?.('change', (e) => {
    systemDark = e.matches;
    apply();
    emit();
  });
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
      if (e.key === THEME_STORAGE_KEY) {
        preference = readStored();
        apply();
        emit();
      }
    });
  }
}

interface ThemeSnapshot {
  preference: ThemePreference;
  resolved: ResolvedTheme;
}
let cachedSnapshot: ThemeSnapshot | null = null;
function getSnapshot(): ThemeSnapshot {
  const resolved = currentResolved();
  if (
    !cachedSnapshot ||
    cachedSnapshot.preference !== preference ||
    cachedSnapshot.resolved !== resolved
  ) {
    cachedSnapshot = { preference, resolved };
  }
  return cachedSnapshot;
}
function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useTheme(): ThemeSnapshot & {
  setPreference: (p: ThemePreference) => void;
  cycle: () => ThemePreference;
} {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { ...snap, setPreference: setThemePreference, cycle: cycleTheme };
}
