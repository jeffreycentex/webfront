// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import ImportDialog from './ImportDialog';

afterEach(cleanup);

const FILE = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
<DT><H3>Dev</H3>
<DL><p>
<DT><A HREF="https://a.example.com/">Alpha <img src=x onerror="alert(1)"></A>
<DT><A HREF="javascript:alert(1)">bad</A>
</DL><p>
</DL>`;

describe('ImportDialog', () => {
  it('previews a chosen file, shows skipped counts and lets folders be excluded', async () => {
    const user = userEvent.setup();
    render(<ImportDialog open onClose={() => {}} />);
    await user.upload(
      screen.getByLabelText('Bookmarks HTML file'),
      new File([FILE], 'bookmarks.html', { type: 'text/html' }),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Import 1 bookmark$/ })).toBeEnabled(),
    );
    expect(screen.getByText(/1 javascript: bookmarklets/)).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: 'Import Dev' }));
    expect(screen.getByRole('button', { name: /Import 0 bookmarks/ })).toBeDisabled();
  });

  it('shows a clear message for a file that is not a bookmarks export', async () => {
    const user = userEvent.setup();
    render(<ImportDialog open onClose={() => {}} />);
    await user.upload(
      screen.getByLabelText('Bookmarks HTML file'),
      new File(['{}'], 'x.html', { type: 'text/html' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/No bookmarks were found/);
  });
});
