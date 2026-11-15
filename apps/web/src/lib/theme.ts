import { useSyncExternalStore } from 'react';
import { safeStorage } from './platform';

/**
 * Themes. The selected theme is `<html data-theme="<id>">`, and the `dark` class on <html>
 * mirrors the theme's mode (so `dark:` variants and `.dark` selectors keep working). The tokens
 * live in `src/styles/index.css`, one `[data-theme='<id>']` block per theme.
 *
 * ADDING A THEME (one place): add a `[data-theme='<id>']` block to index.css that defines every
 * token, then add one entry to THEMES below. The picker, header menu, command palette, /dev/ui
 * gallery, no-flash boot and the contrast test (themes.test.ts) all read this registry.
 *
 * Preference (localStorage `wf.theme`) is a theme id or 'system'. 'system' follows the OS and
 * uses the chosen light theme (`wf.theme.light`) or dark theme (`wf.theme.dark`).
 * `public/theme-init.js` (loaded by index.html) applies it before first paint (no flash) using
 * the boot cache (`wf.theme.boot`) written by `apply()`; `initTheme()` keeps everything in sync
 * afterwards (system changes, other tabs).
 */
export type ResolvedTheme = 'light' | 'dark';

export interface ThemeDef {
  id: string;
  name: string;
  mode: ResolvedTheme;
  /** Browser chrome colour (meta theme-color, PWA title bar); the theme's --wf-bg. */
  chrome: string;
  /** Preview chips: [surface, accent, ok, warn, bad]; the card itself is shown on `chrome`. */
  swatch: [string, string, string, string, string];
}

export const THEMES = [
  {
    id: 'light',
    name: 'Light',
    mode: 'light',
    chrome: '#f5f3ee',
    swatch: ['#fefdfc', '#4351e4', '#05893e', '#e0a21a', '#d72630'],
  },
  {
    id: 'dark',
    name: 'Dark',
    mode: 'dark',
    chrome: '#0f0f18',
    swatch: ['#14161d', '#899aff', '#51c672', '#e8b84a', '#fa6863'],
  },
  {
    id: 'latte',
    name: 'Catppuccin Latte',
    mode: 'light',
    chrome: '#e6e9ef',
    swatch: ['#eff1f5', '#8839ef', '#40a02b', '#df8e1d', '#d20f39'],
  },
  {
    id: 'frappe',
    name: 'Catppuccin Frappé',
    mode: 'dark',
    chrome: '#292c3c',
    swatch: ['#303446', '#ca9ee6', '#a6d189', '#e5c890', '#e78284'],
  },
  {
    id: 'macchiato',
    name: 'Catppuccin Macchiato',
    mode: 'dark',
    chrome: '#1e2030',
    swatch: ['#24273a', '#c6a0f6', '#a6da95', '#eed49f', '#ed8796'],
  },
  {
    id: 'mocha',
    name: 'Catppuccin Mocha',
    mode: 'dark',
    chrome: '#181825',
    swatch: ['#1e1e2e', '#cba6f7', '#a6e3a1', '#f9e2af', '#f38ba8'],
  },
  {
    id: 'adventure-time',
    name: 'Adventure Time',
    mode: 'dark',
    chrome: '#1f1d45',
    swatch: ['#2c284c', '#1997c6', '#4ab118', '#efc11a', '#fc5f5a'],
  },
] as const satisfies readonly ThemeDef[];

export type ThemeId = (typeof THEMES)[number]['id'];
/** A theme id or 'system'. (Stored values 'light' | 'dark' | 'system' from before themes still work.) */
export type ThemePreference = ThemeId | 'system';

export const THEME_STORAGE_KEY = 'wf.theme';
export const THEME_LIGHT_KEY = 'wf.theme.light';
export const THEME_DARK_KEY = 'wf.theme.dark';
/** What theme-init.js applies before first paint: {l: [id, mode, chrome], d: [...]} for OS light / dark. */
export const THEME_BOOT_KEY = 'wf.theme.boot';

/** Browser chrome colours of the two default themes (kept for compatibility). */
export const THEME_COLOURS: Record<ResolvedTheme, string> = { light: '#f5f3ee', dark: '#0f0f18' };

const DEFAULT_LIGHT: ThemeId = 'light';
const DEFAULT_DARK: ThemeId = 'dark';

export function getThemeDef(id: string): ThemeDef | undefined {
  return THEMES.find((t) => t.id === id);
}
function isThemeId(v: unknown): v is ThemeId {
  return typeof v === 'string' && THEMES.some((t) => t.id === v);
}
function isPreference(v: unknown): v is ThemePreference {
  return v === 'system' || isThemeId(v);
}
function themeOfMode(v: unknown, mode: ResolvedTheme, fallback: ThemeId): ThemeId {
  return isThemeId(v) && getThemeDef(v)?.mode === mode ? v : fallback;
}

const listeners = new Set<() => void>();
let preference: ThemePreference = readStored();
let systemLight: ThemeId = readPair(THEME_LIGHT_KEY, 'light', DEFAULT_LIGHT);
let systemDark: ThemeId = readPair(THEME_DARK_KEY, 'dark', DEFAULT_DARK);
let prefersDark = false;

function readStored(): ThemePreference {
  const v = safeStorage.get(THEME_STORAGE_KEY);
  return isPreference(v) ? v : 'system';
}
function readPair(key: string, mode: ResolvedTheme, fallback: ThemeId): ThemeId {
  return themeOfMode(safeStorage.get(key), mode, fallback);
}

function matchDark(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;
}

/** The theme id a preference resolves to. */
export function resolveThemeId(
  pref: ThemePreference,
  osDark: boolean,
  light: ThemeId = DEFAULT_LIGHT,
  dark: ThemeId = DEFAULT_DARK,
): ThemeId {
  return pref === 'system' ? (osDark ? dark : light) : pref;
}

/** The mode ('light' | 'dark') a preference resolves to. */
export function resolveTheme(
  pref: ThemePreference,
  osDark: boolean,
  light: ThemeId = DEFAULT_LIGHT,
  dark: ThemeId = DEFAULT_DARK,
): ResolvedTheme {
  return getThemeDef(resolveThemeId(pref, osDark, light, dark))?.mode ?? 'light';
}

function currentId(): ThemeId {
  return resolveThemeId(preference, prefersDark, systemLight, systemDark);
}
function currentResolved(): ResolvedTheme {
  return getThemeDef(currentId())?.mode ?? 'light';
}

function apply(): void {
  if (typeof document === 'undefined') return;
  const def = getThemeDef(currentId()) ?? THEMES[0];
  const root = document.documentElement;
  root.dataset.theme = def.id;
  root.classList.toggle('dark', def.mode === 'dark');
  root.style.colorScheme = def.mode;
  // Keeps the canvas on the theme colour (set early by theme-init.js; must not go stale).
  root.style.backgroundColor = def.chrome;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', def.chrome);
  // Boot cache for theme-init.js: what to apply when the OS is light (l) or dark (d).
  const boot = (osDark: boolean) => {
    const t = getThemeDef(resolveThemeId(preference, osDark, systemLight, systemDark)) ?? THEMES[0];
    return [t.id, t.mode, t.chrome];
  };
  safeStorage.set(THEME_BOOT_KEY, JSON.stringify({ l: boot(false), d: boot(true) }));
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

export function getThemeId(): ThemeId {
  return currentId();
}

export function setThemePreference(next: ThemePreference): void {
  if (!isPreference(next)) return;
  preference = next;
  safeStorage.set(THEME_STORAGE_KEY, next);
  apply();
  emit();
}

/** Choose the light theme used when following the system (must be a light theme). */
export function setSystemLightTheme(id: ThemeId): void {
  if (getThemeDef(id)?.mode !== 'light') return;
  systemLight = id;
  safeStorage.set(THEME_LIGHT_KEY, id);
  apply();
  emit();
}

/** Choose the dark theme used when following the system (must be a dark theme). */
export function setSystemDarkTheme(id: ThemeId): void {
  if (getThemeDef(id)?.mode !== 'dark') return;
  systemDark = id;
  safeStorage.set(THEME_DARK_KEY, id);
  apply();
  emit();
}

/** light -> dark -> system -> light (any other theme goes to system). */
export function cycleTheme(): ThemePreference {
  const next: ThemePreference =
    preference === 'light'
      ? 'dark'
      : preference === 'dark'
        ? 'system'
        : preference === 'system'
          ? 'light'
          : 'system';
  setThemePreference(next);
  return next;
}

function readAll(): void {
  preference = readStored();
  systemLight = readPair(THEME_LIGHT_KEY, 'light', DEFAULT_LIGHT);
  systemDark = readPair(THEME_DARK_KEY, 'dark', DEFAULT_DARK);
}

let initialised = false;
/** Apply the stored theme and start following system / cross-tab changes. Idempotent. */
export function initTheme(): void {
  readAll();
  const mq = matchDark();
  prefersDark = mq?.matches ?? false;
  apply();
  emit();
  if (initialised) return;
  initialised = true;
  mq?.addEventListener?.('change', (e) => {
    prefersDark = e.matches;
    apply();
    emit();
  });
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
      if (e.key === THEME_STORAGE_KEY || e.key === THEME_LIGHT_KEY || e.key === THEME_DARK_KEY) {
        readAll();
        apply();
        emit();
      }
    });
  }
}

interface ThemeSnapshot {
  preference: ThemePreference;
  /** The mode of the active theme. */
  resolved: ResolvedTheme;
  /** The id of the active theme (after resolving 'system'). */
  themeId: ThemeId;
  /** Theme used when following the system and the OS is light / dark. */
  systemLight: ThemeId;
  systemDark: ThemeId;
}
let cachedSnapshot: ThemeSnapshot | null = null;
function getSnapshot(): ThemeSnapshot {
  if (
    !cachedSnapshot ||
    cachedSnapshot.preference !== preference ||
    cachedSnapshot.themeId !== currentId() ||
    cachedSnapshot.systemLight !== systemLight ||
    cachedSnapshot.systemDark !== systemDark
  ) {
    cachedSnapshot = {
      preference,
      resolved: currentResolved(),
      themeId: currentId(),
      systemLight,
      systemDark,
    };
  }
  return cachedSnapshot;
}
function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useTheme(): ThemeSnapshot & {
  themes: readonly ThemeDef[];
  setPreference: (p: ThemePreference) => void;
  setSystemLight: (id: ThemeId) => void;
  setSystemDark: (id: ThemeId) => void;
  cycle: () => ThemePreference;
} {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    ...snap,
    themes: THEMES,
    setPreference: setThemePreference,
    setSystemLight: setSystemLightTheme,
    setSystemDark: setSystemDarkTheme,
    cycle: cycleTheme,
  };
}
