// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  THEME_STORAGE_KEY,
  cycleTheme,
  getResolvedTheme,
  getThemePreference,
  initTheme,
  resolveTheme,
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
});
