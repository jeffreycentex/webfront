// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearLocalData, put, reader } from '@/data';
import { ToastProvider } from '@/ui';
import { MemoryRouter } from 'react-router';
import { NoteText } from './PostitCard';
import { PostitsPage } from './PostitsPage';
import { postitsSearchProvider } from './search';

beforeEach(async () => {
  await clearLocalData();
  localStorage.clear();
});
afterEach(cleanup);

const renderPage = () =>
  render(
    <MemoryRouter>
      <ToastProvider>
        <PostitsPage />
      </ToastProvider>
    </MemoryRouter>,
  );

describe('post-its page', () => {
  it('quick capture: Enter saves, Shift+Enter adds a line, focus stays', async () => {
    const user = userEvent.setup();
    renderPage();
    const box = await screen.findByLabelText('New post-it');
    await user.click(box);
    await user.type(box, 'first line{Shift>}{Enter}{/Shift}second line{Enter}');
    await waitFor(async () => expect(await reader.list('postits')).toHaveLength(1));
    const [saved] = await reader.list('postits');
    expect(saved?.text).toBe('first line\nsecond line');
    expect(box).toHaveValue('');
    expect(box).toHaveFocus();
    expect(await screen.findByText(/second line/)).toBeInTheDocument();
  });

  it('ignores blank notes and renders urls as links without injecting HTML', async () => {
    const user = userEvent.setup();
    renderPage();
    const box = await screen.findByLabelText('New post-it');
    await user.type(box, '   {Enter}');
    expect(await reader.list('postits')).toHaveLength(0);
    await user.type(box, '<b>bold</b> https://example.com/x{Enter}');
    const link = await screen.findByRole('link', { name: 'https://example.com/x' });
    expect(link).toHaveAttribute('href', 'https://example.com/x');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(screen.getByText(/<b>bold<\/b>/)).toBeInTheDocument();
    expect(document.querySelector('b')).toBeNull();
  });

  it('edits in place with autosave and archives into the Archived view', async () => {
    const user = userEvent.setup();
    const rec = await put('postits', { text: 'old text', sortKey: 'a0' });
    renderPage();
    await user.click(await screen.findByText('old text'));
    const area = await screen.findByLabelText('Note text');
    await user.clear(area);
    await user.type(area, 'new text');
    await user.keyboard('{Escape}');
    await waitFor(async () => expect((await reader.list('postits'))[0]?.text).toBe('new text'));
    await user.click(await screen.findByRole('button', { name: 'Archive' }));
    await waitFor(async () => expect((await reader.list('postits'))[0]?.archived).toBe(true));
    await user.click(screen.getByRole('button', { name: /Archived/ }));
    expect(await screen.findAllByText('new text')).not.toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(async () => expect((await reader.list('postits'))[0]?.archived).toBe(false));
    expect(rec.id).toBeTruthy();
  });
});

describe('search provider', () => {
  it('finds notes and links to the focused note', async () => {
    const a = await put('postits', { text: 'Wifi password hint', sortKey: 'a0' });
    await put('postits', { text: 'Other', sortKey: 'a1' });
    const res = await postitsSearchProvider.search('wifi', 5);
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ id: a.id, href: `/postits?focus=${a.id}` });
    expect(await postitsSearchProvider.search('', 5)).toEqual([]);
  });
});

describe('note text', () => {
  const title = (text: string) => {
    const { container } = render(<NoteText text={text} />);
    return container.querySelector('[data-postit-title]')?.textContent ?? null;
  };

  it('shows the first line of a multi-line note as its title', () => {
    expect(title('Plumber\nCall before Friday')).toBe('Plumber');
  });

  it('gives one-line notes, and notes with only blank lines after, no title', () => {
    expect(title('Just one line')).toBeNull();
    expect(title('Trailing break\n\n')).toBeNull();
    expect(title('\nStarts with a blank line')).toBeNull();
  });
});
