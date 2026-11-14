// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeatureRegistryProvider } from '../features/context';
import { defineFeature } from '../features/types';
import { CommandPalette } from './CommandPalette';
import { scoreCommand, scoreText } from './fuzzy';
import { currentNav } from './Layout';
import { describeSync } from './SyncIndicator';

afterEach(cleanup);

const Icon = () => <svg />;
const run = vi.fn();
const features = [
  defineFeature({
    id: 'bookmarks',
    routes: [],
    nav: { label: 'Bookmarks', icon: Icon, path: '/bookmarks', order: 10, shortcut: 'g b' },
    commands: [{ id: 'bm.new', title: 'New bookmark', keywords: ['add', 'link'], run }],
    searchProvider: {
      id: 'bookmarks',
      label: 'Bookmark',
      search: async (q) =>
        q.toLowerCase() === 'evil'
          ? [{ id: 'b2', title: 'Evil', href: 'javascript:alert(1)', external: true, score: 0.9 }]
          : 'router'.includes(q.toLowerCase())
            ? [
                {
                  id: 'b1',
                  title: 'Router admin',
                  href: 'http://192.168.1.1',
                  external: true,
                  score: 0.9,
                },
              ]
            : [],
    },
  }),
  defineFeature({
    id: 'wiki',
    routes: [],
    nav: { label: 'Wiki', icon: Icon, path: '/wiki', order: 20 },
    searchProvider: {
      id: 'wiki',
      label: 'Page',
      search: async () => {
        throw new Error('provider bug');
      },
    },
  }),
];

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

function renderPalette(onClose = vi.fn(), extra = []) {
  render(
    <MemoryRouter>
      <FeatureRegistryProvider features={features}>
        <CommandPalette open onClose={onClose} extraCommands={extra} />
        <Where />
      </FeatureRegistryProvider>
    </MemoryRouter>,
  );
  return onClose;
}

describe('CommandPalette', () => {
  it('lists nav entries and feature commands, filters as you type, Enter navigates', async () => {
    const user = userEvent.setup();
    const onClose = renderPalette();
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    expect(screen.getByText('Go to Bookmarks')).toBeInTheDocument();
    expect(screen.getByText('New bookmark')).toBeInTheDocument();
    await user.keyboard('wiki');
    expect(screen.queryByText('New bookmark')).toBeNull();
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('where')).toHaveTextContent('/wiki');
    expect(onClose).toHaveBeenCalled();
  });

  it('runs a command by keyword', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('link{Enter}');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('shows search provider results (and survives a throwing provider)', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('rout');
    expect(await screen.findByText('Router admin')).toBeInTheDocument();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('opens an external result in a new tab with noopener', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('rout');
    await screen.findByText('Router admin');
    await waitFor(() => expect(screen.getAllByRole('option')[0]).toHaveTextContent('Router admin'));
    await user.keyboard('{Enter}');
    expect(open).toHaveBeenCalledWith('http://192.168.1.1', '_blank', 'noopener,noreferrer');
    open.mockRestore();
  });

  it('never opens a non-http(s) external result', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('evil');
    await waitFor(() => expect(screen.getAllByRole('option')[0]).toHaveTextContent('Evil'));
    await user.keyboard('{Enter}');
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it('ArrowDown moves the active option; Escape closes', async () => {
    const user = userEvent.setup();
    const onClose = renderPalette();
    const input = screen.getByRole('combobox');
    const first = screen.getAllByRole('option')[0]!;
    expect(first).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowDown}');
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[1]!.id);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('says when nothing matches', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('zzzzqq');
    expect(await screen.findByText(/Nothing matches/)).toBeInTheDocument();
  });
});

describe('fuzzy scoring', () => {
  it('ranks prefix above word-start above substring above subsequence', () => {
    const q = 'sho';
    const s = [
      scoreText(q, 'Shopping'),
      scoreText(q, 'Go to Shopping'),
      scoreText(q, 'Reshow'),
      scoreText('shp', 'Shopping'),
    ];
    expect(s[0]).toBeGreaterThan(s[1]!);
    expect(s[1]).toBeGreaterThan(s[2]!);
    expect(s[2]).toBeGreaterThan(s[3]!);
    expect(scoreText('xyz', 'Shopping')).toBe(0);
  });
  it('falls back to keywords', () => {
    expect(scoreCommand('link', 'New bookmark', ['add', 'link'])).toBeGreaterThan(0);
    expect(scoreCommand('', 'Anything')).toBeGreaterThan(0);
  });
});

describe('currentNav', () => {
  const nav = features.flatMap((f) => (f.nav ? [f.nav] : []));
  it('matches the longest path prefix', () => {
    expect(currentNav(nav, '/wiki/some-page')?.label).toBe('Wiki');
    expect(currentNav(nav, '/bookmarks')?.label).toBe('Bookmarks');
    expect(currentNav(nav, '/nope')).toBeUndefined();
  });
});

describe('describeSync', () => {
  const base = { pendingChanges: 0, rejectedChanges: 0, lastSyncedAt: null, error: null };
  it('maps every state', () => {
    expect(describeSync({ ...base, state: 'idle' })).toMatchObject({ tone: 'ok', label: 'Synced' });
    expect(describeSync({ ...base, state: 'syncing', pendingChanges: 2 })).toMatchObject({
      tone: 'busy',
      label: 'Syncing',
    });
    expect(describeSync({ ...base, state: 'offline', pendingChanges: 3 })).toMatchObject({
      tone: 'warn',
      label: 'Offline · 3',
    });
    expect(describeSync({ ...base, state: 'offline' }).label).toBe('Offline');
    expect(describeSync({ ...base, state: 'error', error: 'boom' })).toMatchObject({
      tone: 'bad',
      label: 'Sync error',
    });
    expect(describeSync({ ...base, state: 'error', error: 'boom' }).detail).toContain('boom');
    expect(describeSync({ ...base, state: 'unauthenticated' })).toMatchObject({
      tone: 'bad',
      label: 'Sign in',
    });
    expect(describeSync({ ...base, state: 'idle', pendingChanges: 4 })).toMatchObject({
      tone: 'warn',
      label: '4 pending',
    });
  });
});
