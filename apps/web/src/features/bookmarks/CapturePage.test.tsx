// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { reader } from '@/data';
import { CapturePage } from './CapturePage';

afterEach(cleanup);

function renderAt(search: string) {
  render(
    <MemoryRouter initialEntries={[`/capture${search}`]}>
      <CapturePage />
    </MemoryRouter>,
  );
}

describe('CapturePage (bookmarklet window: query string is attacker-controlled)', () => {
  it('drops a javascript: URL from the query string and renders the title as text', async () => {
    renderAt(
      `?url=${encodeURIComponent('javascript:alert(1)')}&title=${encodeURIComponent('<img src=x onerror=alert(1)>')}`,
    );
    expect(screen.getByLabelText('Address')).toHaveValue('');
    expect(screen.getByLabelText('Title')).toHaveValue('<img src=x onerror=alert(1)>');
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('refuses to save a non-http(s) address typed into the field', async () => {
    const user = userEvent.setup();
    renderAt(`?url=${encodeURIComponent('https://example.com/')}&title=Example`);
    const address = screen.getByLabelText('Address');
    await user.clear(address);
    await user.type(address, 'javascript:alert(1)');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/http/);
    const saved = await reader.list('bookmarks');
    expect(saved.some((b) => !/^https?:/.test(b.url))).toBe(false);
  });
});
