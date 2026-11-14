// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { displayHint, MASK, useReveal } from './reveal';

describe('hint masking', () => {
  it('masks by default and shows the hint only when revealed', () => {
    expect(displayHint('first pet + year', false)).toBe(MASK);
    expect(displayHint('first pet + year', true)).toBe('first pet + year');
    expect(displayHint(null, true)).toBe('');
    expect(MASK).not.toContain('pet');
  });

  it('re-masks when closed or when another bookmark is shown', () => {
    const { result, rerender } = renderHook(({ open, k }) => useReveal(open, k), {
      initialProps: { open: true, k: 'a' },
    });
    expect(result.current[0]).toBe(false);
    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);
    rerender({ open: true, k: 'b' });
    expect(result.current[0]).toBe(false);
    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);
    rerender({ open: false, k: 'b' });
    expect(result.current[0]).toBe(false);
    rerender({ open: true, k: 'b' });
    expect(result.current[0]).toBe(false);
  });
});
