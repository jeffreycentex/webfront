// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { SessionInfo } from '@webfront/shared';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthGate, AuthProvider } from '../auth';
import { createAuthController } from '../auth/controller';
import { FeatureRegistryProvider } from '../features/context';
import { features } from '../features/registry';
import { ToastProvider } from '../ui';
import { buildRoutes } from './routes';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const session: SessionInfo = {
  username: 'jeff',
  sessionId: 's',
  deviceName: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-04-01T00:00:00.000Z',
  csrfToken: 'c',
};

async function renderApp(path = '/') {
  const controller = createAuthController({
    api: {
      status: async () => ({ setupRequired: false, session, passkeysAvailable: false }),
      setup: async () => session,
      login: async () => session,
      logout: async () => {},
      passkeyLogin: async () => session,
    },
    data: { startSync: () => {}, stopSync: () => {} },
    setCsrfToken: () => {},
    storage: { load: () => null, save: () => {}, clear: () => {} },
    verifier: { set: async () => {}, check: async () => null, clear: () => {} },
    retryMs: 0,
  });
  const router = createMemoryRouter(buildRoutes(features), { initialEntries: [path] });
  render(
    <ToastProvider>
      <AuthProvider controller={controller}>
        <AuthGate>
          <FeatureRegistryProvider features={features}>
            <RouterProvider router={router} />
          </FeatureRegistryProvider>
        </AuthGate>
      </AuthProvider>
    </ToastProvider>,
  );
  // Routes are lazy (the home page too): wait for the layout itself, not the loading fallback.
  await screen.findByRole('navigation', { name: 'Main' });
  if (path === '/') await screen.findByRole('combobox');
  return router;
}

describe('app shell', () => {
  it('renders every feature in the nav, in order, and highlights the current page', async () => {
    await renderApp('/bookmarks');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    const labels = within(nav)
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'));
    expect(labels.slice(0, 3)).toEqual(['/', '/bookmarks', '/postits']);
    expect(within(nav).getByRole('link', { name: /Bookmarks/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(document.title).toBe('Bookmarks · Webfront');
  });

  it('Ctrl+K opens the palette; Enter on "Go to" navigates', async () => {
    const user = userEvent.setup();
    const router = await renderApp('/');
    await user.keyboard('{Control>}k{/Control}');
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    await user.keyboard('go to shopping{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/shopping'));
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
  });

  it('? opens the shortcut cheat sheet built from nav shortcuts', async () => {
    const user = userEvent.setup();
    await renderApp('/');
    await user.keyboard('{Escape}'); // the home page's search bar has focus; Escape blurs it
    await user.keyboard('?');
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(dialog).getByText('Go to Bookmarks')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('"g b" navigates using the nav shortcut', async () => {
    const user = userEvent.setup();
    const router = await renderApp('/');
    await user.keyboard('{Escape}');
    await user.keyboard('gb');
    expect(router.state.location.pathname).toBe('/bookmarks');
  });

  it('unknown URLs show the not-found page inside the layout', async () => {
    await renderApp('/does/not/exist');
    expect(await screen.findByText('Page not found')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
  });

  it('the hidden /dev/ui gallery renders lazily', async () => {
    await renderApp('/dev/ui');
    expect(await screen.findByRole('heading', { name: 'Design system' })).toBeInTheDocument();
  });

  it('theme menu switches and persists the theme', async () => {
    const user = userEvent.setup();
    await renderApp('/');
    await user.click(screen.getByRole('button', { name: /^Theme/ }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Dark' }));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('wf.theme')).toBe('dark');
  });

  it('shows the sync indicator and the browser-offline indicator', async () => {
    await renderApp('/');
    expect(screen.getByRole('button', { name: /Sync status/ })).toBeInTheDocument();
    expect(screen.queryByText('No network')).toBeNull();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await act(async () => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByText('No network')).toBeInTheDocument();
  });

  it('phone layout uses a bottom tab bar with a More menu', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('max-width: 639px'),
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const user = userEvent.setup();
    await renderApp('/');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getAllByRole('link')).toHaveLength(4);
    await user.click(within(nav).getByRole('button', { name: 'More' }));
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toBeInTheDocument();
  });
});
