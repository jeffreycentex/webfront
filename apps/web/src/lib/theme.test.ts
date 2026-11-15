// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import {
  THEMES,
  THEME_BOOT_KEY,
  THEME_STORAGE_KEY,
  cycleTheme,
  getResolvedTheme,
  getThemePreference,
  initTheme,
  getThemeId,
  resolveTheme,
  resolveThemeId,
  setSystemDarkTheme,
  setSystemLightTheme,
  setThemePreference,
} from './theme';

function mockMatchMedia(dark: boolean) {
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const mq = {
    matches: dark,
    addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.delete(fn),
  };
  vi.stubGlobal('matchMedia', () => mq);
  return {
    set(next: boolean) {
      mq.matches = next;
      for (const l of listeners) l({ matches: next });
    },
  };
}

describe('theme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    document.head.innerHTML = '<meta name="theme-color" content="#fff">';
  });

  it('resolves system by the media query', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
  });

  it('defaults to system and follows the OS', () => {
    const mm = mockMatchMedia(true);
    initTheme();
    expect(getThemePreference()).toBe('system');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    mm.set(false);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('persists the preference and applies it', () => {
    mockMatchMedia(false);
    initTheme();
    setThemePreference('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
      '#0f0f18',
    );
    expect(getResolvedTheme()).toBe('dark');
  });

  it('restores the stored preference on init (no flash after reload)', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    mockMatchMedia(true);
    initTheme();
    expect(getThemePreference()).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('ignores junk in storage', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'purple');
    mockMatchMedia(false);
    initTheme();
    expect(getThemePreference()).toBe('system');
  });

  it('cycles light -> dark -> system', () => {
    mockMatchMedia(false);
    initTheme();
    setThemePreference('light');
    expect(cycleTheme()).toBe('dark');
    expect(cycleTheme()).toBe('system');
    expect(cycleTheme()).toBe('light');
  });

  it('sets data-theme, the dark class by mode, and the chrome colour', () => {
    mockMatchMedia(false);
    initTheme();
    setThemePreference('latte');
    const root = document.documentElement;
    expect(root.dataset.theme).toBe('latte');
    expect(root.classList.contains('dark')).toBe(false);
    expect(getResolvedTheme()).toBe('light');
    setThemePreference('mocha');
    expect(root.dataset.theme).toBe('mocha');
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.style.colorScheme).toBe('dark');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
      '#181825',
    );
    expect(getThemeId()).toBe('mocha');
  });

  it('system uses the chosen light and dark themes and follows the OS', () => {
    const mm = mockMatchMedia(false);
    initTheme();
    setThemePreference('system');
    setSystemLightTheme('latte');
    setSystemDarkTheme('adventure-time');
    expect(document.documentElement.dataset.theme).toBe('latte');
    void mm;
    mockMatchMedia(true);
    initTheme(); // (the OS change listener is covered by 'defaults to system and follows the OS')
    expect(document.documentElement.dataset.theme).toBe('adventure-time');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(resolveThemeId('system', true, 'latte', 'mocha')).toBe('mocha');
    expect(resolveTheme('system', false, 'latte', 'mocha')).toBe('light');
    // Persisted and restored.
    expect(localStorage.getItem('wf.theme.light')).toBe('latte');
    initTheme();
    expect(document.documentElement.dataset.theme).toBe('adventure-time');
  });

  it('refuses a dark theme as the light choice and junk preferences', () => {
    mockMatchMedia(false);
    initTheme();
    setSystemLightTheme('mocha');
    expect(localStorage.getItem('wf.theme.light')).toBeNull();
    localStorage.setItem('wf.theme.dark', 'latte');
    localStorage.setItem(THEME_STORAGE_KEY, 'system');
    initTheme();
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('accepts any theme id as the stored preference', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'frappe');
    mockMatchMedia(false);
    initTheme();
    expect(getThemePreference()).toBe('frappe');
    expect(document.documentElement.dataset.theme).toBe('frappe');
  });
});

/** Runs public/theme-init.js against a fake DOM and reports what it applied. */
function runInit(store: Record<string, string>, osDark: boolean, throwing = false) {
  const attrs: Record<string, string> = {};
  const classes = new Set<string>();
  const meta: Record<string, string> = {};
  const style: Record<string, string> = {};
  const src = readFileSync(resolve(import.meta.dirname, '../../public/theme-init.js'), 'utf8');
  runInNewContext(src, {
    localStorage: throwing
      ? {
          getItem() {
            throw new Error('denied');
          },
        }
      : { getItem: (k: string) => store[k] ?? null },
    matchMedia: () => ({ matches: osDark }),
    document: {
      documentElement: {
        setAttribute: (k: string, v: string) => (attrs[k] = v),
        classList: { add: (c: string) => classes.add(c) },
        style,
      },
      querySelector: () => ({ setAttribute: (_: string, v: string) => (meta.content = v) }),
    },
  });
  return { theme: attrs['data-theme'], dark: classes.has('dark'), meta: meta.content, style };
}

describe('theme-init.js (no flash)', () => {
  it('falls back to the stored light | dark | system preference', () => {
    expect(runInit({ 'wf.theme': 'dark' }, false)).toMatchObject({ theme: 'dark', dark: true });
    expect(runInit({ 'wf.theme': 'light' }, true)).toMatchObject({ theme: 'light', dark: false });
    expect(runInit({}, true)).toMatchObject({ theme: 'dark', meta: '#0f0f18' });
    expect(runInit({}, false)).toMatchObject({ theme: 'light', meta: '#f5f3ee' });
  });

  it('applies the boot cache written by the app for every theme and OS mode', () => {
    document.head.innerHTML = '';
    mockMatchMedia(false);
    for (const t of THEMES) {
      localStorage.clear();
      initTheme();
      setThemePreference(t.id);
      const boot = localStorage.getItem(THEME_BOOT_KEY)!;
      for (const os of [false, true]) {
        const r = runInit({ [THEME_BOOT_KEY]: boot }, os);
        expect(r).toMatchObject({ theme: t.id, dark: t.mode === 'dark', meta: t.chrome });
        expect(r.style.colorScheme).toBe(t.mode);
      }
    }
  });

  it('boots the right pair for system', () => {
    mockMatchMedia(false);
    localStorage.clear();
    initTheme();
    setSystemLightTheme('latte');
    setSystemDarkTheme('mocha');
    setThemePreference('system');
    const boot = localStorage.getItem(THEME_BOOT_KEY)!;
    expect(runInit({ [THEME_BOOT_KEY]: boot }, false).theme).toBe('latte');
    expect(runInit({ [THEME_BOOT_KEY]: boot }, true).theme).toBe('mocha');
  });

  it('never throws, even on garbage or blocked storage', () => {
    expect(() => runInit({ [THEME_BOOT_KEY]: '{not json' }, true)).not.toThrow();
    expect(runInit({ [THEME_BOOT_KEY]: '{not json' }, true).theme).toBe('dark');
    expect(runInit({ [THEME_BOOT_KEY]: '{"l":[1]}' }, false).theme).toBe('light');
    expect(() => runInit({}, false, true)).not.toThrow();
  });
});
