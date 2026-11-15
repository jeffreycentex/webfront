// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Favicon } from './Favicon';

describe('letter avatar', () => {
  it('does not use white text on a solid palette colour', () => {
    // A non-http URL has no favicon endpoint, so the avatar renders.
    const { container } = render(<Favicon url="ftp://files.example.com/" title="Files" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.textContent).toBe('F');
    expect(el.className).not.toContain('text-white');
    expect(el.className).not.toContain('bg-[var(--c)]');
    // Guaranteed pair in every theme: fg on the palette -soft background (themes.test.ts).
    expect(el.className).toContain('text-fg');
    expect(el.className).toContain('bg-[var(--c-soft)]');
  });
});
