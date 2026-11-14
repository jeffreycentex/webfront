// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearLocalData, patch, reader } from '@/data';
import { ToastProvider } from '@/ui';
import { createPage } from './data';
import { WikiPage } from './WikiPage';
import WikiWidget from './WikiWidget';
import { hashText } from './lib/text';
import { AUTOSAVE_MS, recoverBackup, useBodyEditor } from './useBodyEditor';

/** Smoke tests of the wiki screens in jsdom against the real local data layer. */

beforeAll(() => {
  // jsdom lacks these.
  window.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});
beforeEach(async () => {
  await clearLocalData();
});
afterEach(cleanup);

function Where() {
  const l = useLocation();
  return <span data-testid="where">{l.pathname + l.search}</span>;
}

function renderAt(path: string) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/wiki/*" element={<WikiPage />} />
          <Route path="/" element={<WikiWidget />} />
        </Routes>
        <Where />
      </MemoryRouter>
    </ToastProvider>,
  );
}

describe('wiki screens', () => {
  it('first run offers to create a Home page', async () => {
    const user = userEvent.setup();
    renderAt('/wiki');
    const btn = await screen.findByRole('button', { name: 'Create a Home page' });
    await user.click(btn);
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/wiki/home'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
    const pages = await reader.list('wikiPages');
    expect(pages).toHaveLength(1);
    expect(pages[0]!.body).toContain('Welcome to your wiki');
  });

  it('renders a page with the tree, wiki links, backlinks and a table of contents', async () => {
    const home = await createPage({
      title: 'Home',
      colour: 'teal',
      body: '# Home\n\nGo to [[Garden]] or [[Nowhere]].\n\n## One\n\n## Two\n\n## Three',
    });
    await createPage({ title: 'Garden', parentId: home.id, body: 'Back to [[Home]].' });
    renderAt('/wiki/home');
    const tree = await screen.findByRole('tree', { name: 'Wiki pages' });
    expect(within(tree).getByText('Garden')).toBeInTheDocument();
    const article = await screen.findByRole('article');
    const [link] = await within(article).findAllByRole('link', { name: 'Garden' });
    expect(link).toHaveAttribute('href', '/wiki/garden');
    expect(within(article).getByRole('link', { name: 'Nowhere' })).toHaveClass('wikilink-missing');
    expect(
      within(article).getAllByRole('navigation', { name: 'On this page' }).length,
    ).toBeGreaterThan(0);
    // Backlinks: Garden links to Home.
    const backlinks = screen.getByRole('heading', { name: 'Linked from' }).closest('section')!;
    expect(within(backlinks).getByRole('link', { name: 'Garden' })).toBeInTheDocument();
  });

  it('clicking a missing-page link creates the page', async () => {
    const user = userEvent.setup();
    await createPage({ title: 'Home', body: 'See [[Brand New]].' });
    renderAt('/wiki/home');
    await user.click(await screen.findByRole('link', { name: 'Brand New' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/wiki/brand-new'));
    expect((await reader.list('wikiPages')).map((p) => p.title).sort()).toEqual([
      'Brand New',
      'Home',
    ]);
  });

  it('redirects old slugs after a rename and shows not-found otherwise', async () => {
    const p = await createPage({ title: 'Old name' });
    await patch('wikiPages', p.id, { title: 'New name', slug: 'new-name', oldSlugs: ['old-name'] });
    renderAt('/wiki/old-name');
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/wiki/new-name'));
    cleanup();
    renderAt('/wiki/missing-page');
    expect(await screen.findByText('Page not found')).toBeInTheDocument();
  });

  it('shows the conflict banner with keep / take / combine actions, and resolves', async () => {
    const user = userEvent.setup();
    const p = await createPage({ title: 'Clash', body: 'mine text' });
    await patch('wikiPages', p.id, {
      conflict: { body: 'their text', revisionId: null, detectedAt: new Date().toISOString() },
    });
    renderAt('/wiki/clash');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Edit conflict');
    await user.click(within(alert).getByRole('button', { name: 'Show differences' }));
    expect(alert).toHaveTextContent('their text');
    await user.click(within(alert).getByRole('button', { name: 'Take theirs' }));
    await waitFor(async () => {
      const rec = await reader.get('wikiPages', p.id);
      expect(rec).toMatchObject({ body: 'their text', conflict: null });
    });
    // The losing text stays in the history.
    const revs = await reader.list('wikiRevisions', { where: { pageId: p.id } });
    expect(revs.map((r) => r.body)).toContain('mine text');
  });

  it('dashboard widget lists pinned and recent pages', async () => {
    const a = await createPage({ title: 'Alpha' });
    await createPage({ title: 'Beta' });
    await patch('wikiPages', a.id, { pinned: true });
    renderAt('/');
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByLabelText('Pinned')).toBeInTheDocument();
  });

  it('opens the CodeMirror editor in split view with ?edit=1', async () => {
    await createPage({ title: 'Doc', body: 'Hello **world**' });
    renderAt('/wiki/doc?edit=1');
    expect(await screen.findByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('.cm-editor')).not.toBeNull(), {
      timeout: 5000,
    });
    expect(document.querySelector('.cm-content')?.textContent).toContain('Hello **world**');
    expect(screen.getByLabelText('Preview')).toHaveTextContent('Hello world');
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });
});

describe('useBodyEditor', () => {
  it('autosaves after a pause, flushes on unmount and keeps a crash backup until stored', async () => {
    const p = await createPage({ title: 'Draft', body: 'one' });
    const { result, unmount } = renderHook(() => useBodyEditor(p));
    act(() => result.current.setDraft('one two'));
    expect(result.current.state).toBe('unsaved');
    expect(localStorage.getItem(`webfront.wiki.draft.${p.id}`)).toContain('one two');
    await waitFor(async () => expect((await reader.get('wikiPages', p.id))?.body).toBe('one two'), {
      timeout: AUTOSAVE_MS + 2000,
    });
    await waitFor(() => expect(result.current.state).toBe('saved'));
    expect(localStorage.getItem(`webfront.wiki.draft.${p.id}`)).toBeNull();

    act(() => result.current.setDraft('one two three'));
    unmount(); // route change: flushed immediately, no debounce wait
    await waitFor(async () =>
      expect((await reader.get('wikiPages', p.id))?.body).toBe('one two three'),
    );
  });

  it('merges a backup left by a closed tab into the page', async () => {
    const p = await createPage({ title: 'Crash', body: 'alpha\nbeta\ngamma' });
    localStorage.setItem(
      `webfront.wiki.draft.${p.id}`,
      JSON.stringify({ text: 'ALPHA\nbeta\ngamma', from: 'alpha\nbeta\ngamma', at: Date.now() }),
    );
    // Meanwhile another device changed a different line (declaring the text it started from).
    await patch('wikiPages', p.id, {
      body: 'alpha\nbeta\nGAMMA',
      bodyBase: hashText('alpha\nbeta\ngamma'),
    });
    expect(await recoverBackup(p.id)).toBe(true);
    expect(await reader.get('wikiPages', p.id)).toMatchObject({
      body: 'ALPHA\nbeta\nGAMMA',
      conflict: null,
    });
    expect(localStorage.getItem(`webfront.wiki.draft.${p.id}`)).toBeNull();
  });
});
