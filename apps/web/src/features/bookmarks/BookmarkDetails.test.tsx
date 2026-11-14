// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { BookmarkDetails } from './BookmarkDetails';
import type { Bookmark } from './model';

const bookmark = {
  id: 'b1',
  title: 'Router',
  url: 'https://router.lan/',
  categoryId: null,
  tags: [],
  username: 'admin',
  hint: 'sticker on the back',
  notes: '',
  isService: false,
  serviceCheck: null,
} as unknown as Bookmark;

describe('BookmarkDetails hint', () => {
  it('masks the hint until Reveal is pressed, then re-masks on hide and on reopen', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<BookmarkDetails bookmark={bookmark} onClose={() => {}} />);
    expect(screen.getByTestId('hint').textContent).not.toContain('sticker');
    expect(screen.getByText(/real passwords/i)).toBeTruthy();
    expect(screen.queryByText(/password$/i)).toBeNull();

    await user.click(screen.getByRole('button', { name: /reveal/i }));
    expect(screen.getByTestId('hint').textContent).toBe('sticker on the back');

    rerender(<BookmarkDetails bookmark={null} onClose={() => {}} />);
    rerender(<BookmarkDetails bookmark={bookmark} onClose={() => {}} />);
    expect(screen.getByTestId('hint').textContent).not.toContain('sticker');
  });
});

describe('BookmarkDetails links', () => {
  it('shows a stored javascript: URL as text, never as a link', () => {
    render(
      <BookmarkDetails
        bookmark={{ ...bookmark, url: 'javascript:alert(1)' } as Bookmark}
        onClose={() => {}}
      />,
    );
    for (const a of document.querySelectorAll('a')) {
      expect(a.getAttribute('href') ?? '').not.toMatch(/^javascript:/i);
    }
  });
});
