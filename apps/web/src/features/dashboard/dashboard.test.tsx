// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { lazy, useState } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { put } from '@/data';
import { FeatureRegistryProvider } from '../context';
import { defineFeature, type SearchProvider } from '../types';
import { DashboardPage } from './DashboardPage';
import { SearchBar } from './SearchBar';

afterEach(cleanup);

const engine = { name: 'DuckDuckGo', urlTemplate: 'https://duckduckgo.com/?q=%s' };

function provider(
  id: string,
  label: string,
  items: Array<[string, number, boolean?]>,
): SearchProvider {
  return {
    id,
    label,
    search: async (q) =>
      items
        .filter(([t]) => t.toLowerCase().includes(q.toLowerCase()))
        .map(([title, score, external]) => ({
          id: title,
          title,
          href: external ? `https://ext.test/${title}` : `/${id}/${title}`,
          external: !!external,
          score,
        })),
  };
}

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderBar(providers: SearchProvider[], openUrl = vi.fn()) {
  const features = providers.map((p) => defineFeature({ id: p.id, routes: [], searchProvider: p }));
  const Harness = () => {
    const [q, setQ] = useState('');
    return <SearchBar query={q} onQueryChange={setQ} engine={engine} openUrl={openUrl} />;
  };
  render(
    <FeatureRegistryProvider features={features}>
      <MemoryRouter>
        <Harness />
        <Routes>
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </FeatureRegistryProvider>,
  );
  return { openUrl, input: screen.getByRole('combobox') };
}

describe('SearchBar', () => {
  it('is focused on load, groups results by feature and opens the top result with Enter', async () => {
    const user = userEvent.setup();
    const { input } = renderBar([
      provider('tasks', 'Tasks', [['milk run', 0.4]]),
      provider('shopping', 'Shopping', [['milk', 0.9]]),
    ]);
    expect(input).toHaveFocus();
    await user.type(input, 'milk');
    const list = await screen.findByRole('listbox');
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(3));
    // Groups ordered by best score; labels shown.
    const text = list.textContent ?? '';
    expect(text.indexOf('Shopping')).toBeLessThan(text.indexOf('Tasks'));
    const options = within(list).getAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowDown}{ArrowUp}{Enter}');
    expect(screen.getByTestId('where')).toHaveTextContent('/shopping/milk');
  });

  it('goes to the web search when nothing matches, and with Ctrl+Enter / Alt+Enter', async () => {
    const user = userEvent.setup();
    const { input, openUrl } = renderBar([provider('tasks', 'Tasks', [['milk', 0.9]])]);
    await user.type(input, 'zebra crossing{Enter}');
    expect(openUrl).toHaveBeenLastCalledWith('https://duckduckgo.com/?q=zebra%20crossing', false);

    await user.clear(input);
    await user.type(input, 'milk');
    await screen.findByRole('option', { name: /^milk/ });
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(openUrl).toHaveBeenLastCalledWith('https://duckduckgo.com/?q=milk', false);
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await user.keyboard('{Alt>}{Enter}{/Alt}');
    // Alt+Enter on the top (internal) result opens a new tab, not the engine.
    expect(open).toHaveBeenCalledWith('http://localhost:3000/tasks/milk', '_blank');
    expect(openUrl).toHaveBeenCalledTimes(2);
    open.mockRestore();
  });

  it('opens external results and typed addresses straight away', async () => {
    const user = userEvent.setup();
    const { input, openUrl } = renderBar([
      provider('bookmarks', 'Bookmarks', [['nas', 0.8, true]]),
    ]);
    await user.type(input, 'nas');
    await screen.findByRole('option', { name: /^nas/ });
    await user.keyboard('{Enter}');
    expect(openUrl).toHaveBeenLastCalledWith('https://ext.test/nas', false);
    await user.clear(input);
    await user.type(input, 'example.org{Enter}');
    expect(openUrl).toHaveBeenLastCalledWith('https://example.org/', false);
  });

  it('never opens a non-http(s) result URL (stored javascript: bookmark)', async () => {
    const user = userEvent.setup();
    const evil: SearchProvider = {
      id: 'bookmarks',
      label: 'Bookmarks',
      search: async () => [
        { id: 'x', title: 'evil', href: 'javascript:alert(1)', external: true, score: 1 },
      ],
    };
    const { input, openUrl } = renderBar([evil]);
    await user.type(input, 'evil');
    await screen.findByRole('option', { name: /^evil/ });
    await user.keyboard('{Enter}');
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('Escape clears the text first', async () => {
    const user = userEvent.setup();
    const { input } = renderBar([]);
    await user.type(input, 'abc');
    await user.keyboard('{Escape}');
    expect(input).toHaveValue('');
  });
});

describe('DashboardPage', () => {
  const Widget = (title: string) => () => <p>{`widget ${title}`}</p>;
  const Crash = () => {
    throw new Error('boom');
  };
  const widgets = [
    { id: 'bookmarks', title: 'Bookmarks', order: 10, component: Widget('bookmarks') },
    { id: 'postits', title: 'Post-its', order: 30, component: Widget('postits') },
    { id: 'agenda', title: 'Today', order: 40, component: Crash },
    {
      id: 'wiki',
      title: 'Wiki',
      order: 60,
      component: lazy(async () => ({ default: Widget('wiki') })),
    },
  ];
  const features = [defineFeature({ id: 'x', routes: [], dashboardWidgets: widgets })];

  const renderPage = () =>
    render(
      <FeatureRegistryProvider features={features}>
        <MemoryRouter>
          <DashboardPage />
        </MemoryRouter>
      </FeatureRegistryProvider>,
    );
  const order = () =>
    [...document.querySelectorAll('[data-section]')].map((n) => n.getAttribute('data-section'));

  it('a crashing widget shows an inline error and the others still render', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderPage();
    expect(await screen.findByText('widget bookmarks')).toBeInTheDocument();
    expect(await screen.findByText('widget wiki')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Today could not be shown');
    expect(screen.getByText('widget postits')).toBeInTheDocument();
    spy.mockRestore();
  });

  it('follows the synced section order and visibility', async () => {
    await put(
      'settings',
      {
        value: [
          { id: 'search', hidden: false },
          { id: 'wiki', hidden: false },
          { id: 'postits', hidden: true },
          { id: 'bookmarks', hidden: false },
        ],
      },
      { id: 'dashboard.sections' },
    );
    renderPage();
    await waitFor(() => expect(order()).toEqual(['wiki', 'bookmarks', 'agenda']));
    expect(screen.queryByText('widget postits')).toBeNull();
  });
});
