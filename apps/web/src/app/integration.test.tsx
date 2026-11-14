// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { Bookmark, ListTodo } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeatureRegistryProvider } from '../features/context';
import { features } from '../features/registry';
import { defineFeature } from '../features/types';
import { CommandPalette } from './CommandPalette';
import { RejectedBanner, phoneNav } from './Layout';

const status = vi.hoisted(() => ({ rejectedChanges: 0 }));
vi.mock('../data', async (orig) => ({
  ...(await orig<typeof import('../data')>()),
  useSyncStatus: () => ({
    state: 'idle',
    pendingChanges: 0,
    rejectedChanges: status.rejectedChanges,
    lastSyncedAt: null,
    error: null,
  }),
}));

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  status.rejectedChanges = 0;
});

describe('phone tab bar order', () => {
  it('puts Home, Shopping, Tasks, Bookmarks first without touching desktop order', () => {
    const nav = features.flatMap((f) => (f.nav ? [f.nav] : [])).sort((a, b) => a.order - b.order);
    expect(
      phoneNav(nav)
        .slice(0, 4)
        .map((n) => n.label),
    ).toEqual(['Home', 'Shopping', 'Tasks', 'Bookmarks']);
    expect(nav[1]?.label).toBe('Bookmarks');
  });

  it('the tasks entry supplies a badge hook', () => {
    const tasks = features.find((f) => f.id === 'tasks');
    expect(typeof tasks?.nav?.useBadge).toBe('function');
  });
});

describe('RejectedBanner', () => {
  it('is hidden at 0, explains the cause when rejected, and is dismissible for the session', async () => {
    const user = userEvent.setup();
    const ui = () => (
      <MemoryRouter>
        <RejectedBanner />
      </MemoryRouter>
    );
    const { rerender } = render(ui());
    expect(screen.queryByRole('alert')).toBeNull();
    status.rejectedChanges = 2;
    rerender(ui());
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/clock is wrong/);
    expect(within(alert).getByRole('link')).toHaveAttribute('href', '/settings#data');
    await user.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('command palette', () => {
  it('lists one "Go to" entry per nav item even if a feature registers a duplicate', async () => {
    const user = userEvent.setup();
    const dup = defineFeature({
      id: 'dup',
      routes: [],
      nav: { label: 'Bookmarks', icon: Bookmark, path: '/bookmarks', order: 1 },
      commands: [
        { id: 'dup.go', title: 'Go to bookmarks', run: () => {} },
        { id: 'dup.other', title: 'Other thing', run: () => {} },
      ],
    });
    const other = defineFeature({
      id: 'o',
      routes: [],
      nav: { label: 'Tasks', icon: ListTodo, path: '/tasks', order: 2 },
    });
    render(
      <FeatureRegistryProvider features={[dup, other]}>
        <MemoryRouter>
          <CommandPalette open onClose={() => {}} />
        </MemoryRouter>
      </FeatureRegistryProvider>,
    );
    await user.keyboard('go to book');
    expect(await screen.findAllByText(/go to bookmarks/i)).toHaveLength(1);
  });

  it('no registered feature ships a redundant "Go to" command', () => {
    const goTitles = features.flatMap((f) => f.commands ?? []).map((c) => c.title.toLowerCase());
    const navGo = features.flatMap((f) => (f.nav ? [`go to ${f.nav.label}`.toLowerCase()] : []));
    expect(goTitles.filter((t) => navGo.includes(t))).toEqual([]);
  });
});
