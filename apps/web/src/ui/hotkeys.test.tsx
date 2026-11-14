// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatShortcut, shortcutText, useHotkeys, type HotkeyOptions } from './hotkeys';

afterEach(cleanup);

function Harness({
  map,
  options,
  withInput,
}: {
  map: Record<string, () => void | boolean>;
  options?: HotkeyOptions;
  withInput?: boolean;
}) {
  useHotkeys(map, options);
  return withInput ? <input aria-label="field" /> : <div />;
}

describe('useHotkeys', () => {
  it('fires a single key', async () => {
    const fn = vi.fn();
    render(<Harness map={{ '?': fn }} />);
    await userEvent.keyboard('?');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('handles mod+k as Ctrl on non-mac (jsdom)', async () => {
    const fn = vi.fn();
    render(<Harness map={{ 'mod+k': fn }} />);
    await userEvent.keyboard('{Control>}k{/Control}');
    expect(fn).toHaveBeenCalledTimes(1);
    await userEvent.keyboard('k');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('handles sequences like "g b" and resets on a wrong key', async () => {
    const fn = vi.fn();
    render(<Harness map={{ 'g b': fn }} />);
    await userEvent.keyboard('gb');
    expect(fn).toHaveBeenCalledTimes(1);
    await userEvent.keyboard('gxb');
    expect(fn).toHaveBeenCalledTimes(1);
    await userEvent.keyboard('g');
    await userEvent.keyboard('b');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('sequence times out', () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      render(<Harness map={{ 'g b': fn }} />);
      fireEvent.keyDown(document.body, { key: 'g' });
      vi.advanceTimersByTime(1500);
      fireEvent.keyDown(document.body, { key: 'b' });
      expect(fn).not.toHaveBeenCalled();
      fireEvent.keyDown(document.body, { key: 'g' });
      fireEvent.keyDown(document.body, { key: 'b' });
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('plain keys do not fire while typing in an input, but mod combos and escape do', async () => {
    const plain = vi.fn();
    const mod = vi.fn();
    const esc = vi.fn();
    render(<Harness map={{ '?': plain, 'mod+k': mod, escape: esc }} withInput />);
    const input = document.querySelector('input')!;
    input.focus();
    await userEvent.keyboard('?');
    expect(plain).not.toHaveBeenCalled();
    await userEvent.keyboard('{Control>}k{/Control}');
    expect(mod).toHaveBeenCalledTimes(1);
    await userEvent.keyboard('{Escape}');
    expect(esc).toHaveBeenCalledTimes(1);
  });

  it('allowInInput opts plain keys in', async () => {
    const fn = vi.fn();
    render(<Harness map={{ '/': fn }} options={{ allowInInput: true }} withInput />);
    document.querySelector('input')!.focus();
    await userEvent.keyboard('/');
    expect(fn).toHaveBeenCalled();
  });

  it('the most recently registered binding wins (open dialog over page)', async () => {
    const page = vi.fn();
    const dialog = vi.fn();
    render(
      <>
        <Harness map={{ escape: page }} />
        <Harness map={{ escape: dialog }} />
      </>,
    );
    await userEvent.keyboard('{Escape}');
    expect(dialog).toHaveBeenCalledTimes(1);
    expect(page).not.toHaveBeenCalled();
  });

  it('a handler returning false lets the next binding run', async () => {
    const page = vi.fn();
    render(
      <>
        <Harness map={{ escape: page }} />
        <Harness map={{ escape: () => false }} />
      </>,
    );
    await userEvent.keyboard('{Escape}');
    expect(page).toHaveBeenCalledTimes(1);
  });

  it('disabled bindings do not fire and unmount cleans up', async () => {
    const fn = vi.fn();
    const { rerender, unmount } = render(<Harness map={{ x: fn }} options={{ enabled: false }} />);
    await userEvent.keyboard('x');
    expect(fn).not.toHaveBeenCalled();
    rerender(<Harness map={{ x: fn }} options={{ enabled: true }} />);
    await userEvent.keyboard('x');
    expect(fn).toHaveBeenCalledTimes(1);
    unmount();
    await userEvent.keyboard('x');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses the latest handler without re-registering', async () => {
    const a = vi.fn();
    const b = vi.fn();
    const { rerender } = render(<Harness map={{ x: a }} />);
    rerender(<Harness map={{ x: b }} />);
    await userEvent.keyboard('x');
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe('formatShortcut', () => {
  it('formats for mac and others', () => {
    expect(formatShortcut('mod+k', true)).toEqual([['⌘', 'K']]);
    expect(formatShortcut('mod+k', false)).toEqual([['Ctrl', 'K']]);
    expect(formatShortcut('g b', false)).toEqual([['G'], ['B']]);
    expect(formatShortcut('mod+shift+p', false)).toEqual([['Ctrl', 'Shift', 'P']]);
    expect(formatShortcut('escape', false)).toEqual([['Esc']]);
    expect(shortcutText('g b', false)).toBe('G then B');
    expect(shortcutText('mod+k', false)).toBe('Ctrl+K');
  });
});
