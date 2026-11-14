// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { SessionInfo } from '@webfront/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '../lib/api';
import { AuthGate, AuthProvider, useAuth } from './index';
import { createAuthController, type AuthDeps } from './controller';
import { localVerifier } from './localVerifier';

afterEach(cleanup);

const session: SessionInfo = {
  username: 'jeff',
  sessionId: 's',
  deviceName: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-04-01T00:00:00.000Z',
  csrfToken: 'c',
};

function makeController(
  status: Awaited<ReturnType<AuthDeps['api']['status']>>,
  over: Partial<AuthDeps['api']> = {},
) {
  let stored: AuthDeps['storage'] extends { load(): infer T } ? T : never = null;
  return createAuthController({
    api: {
      status: async () => status,
      setup: async () => session,
      login: async () => session,
      logout: async () => {},
      passkeyLogin: async () => session,
      ...over,
    },
    data: { startSync: () => {}, stopSync: () => {} },
    setCsrfToken: () => {},
    storage: {
      load: () => stored,
      save: (v) => void (stored = v),
      clear: () => void (stored = null),
    },
    verifier: { set: async () => {}, check: async () => null, clear: () => {} },
    retryMs: 0,
  });
}

function Shell() {
  const { status, lock } = useAuth();
  return (
    <div>
      <p>app:{status}</p>
      <button onClick={lock}>lock</button>
    </div>
  );
}

function renderGate(controller: ReturnType<typeof makeController>) {
  return render(
    <AuthProvider controller={controller}>
      <AuthGate>
        <Shell />
      </AuthGate>
    </AuthProvider>,
  );
}

describe('AuthGate', () => {
  it('shows the setup screen on first run', async () => {
    renderGate(makeController({ setupRequired: true, session: null, passkeysAvailable: false }));
    expect(await screen.findByRole('heading', { name: 'Create your account' })).toBeInTheDocument();
  });

  it('shows login when signed out and surfaces a wrong-password error', async () => {
    const user = userEvent.setup();
    renderGate(
      makeController(
        { setupRequired: false, session: null, passkeysAvailable: false },
        { login: async () => Promise.reject(new ApiRequestError(401, 'unauthorized', 'nope')) },
      ),
    );
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Username'), 'jeff');
    await user.type(screen.getByLabelText('Password'), 'hunter2hunter2');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong username or password');
  });

  it('logs in and renders the app', async () => {
    const user = userEvent.setup();
    renderGate(makeController({ setupRequired: false, session: null, passkeysAvailable: false }));
    await user.type(await screen.findByLabelText('Username'), 'jeff');
    await user.type(screen.getByLabelText('Password'), 'hunter2hunter2');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('app:signed-in')).toBeInTheDocument();
  });

  it('offers a passkey button only when passkeys exist', async () => {
    vi.stubGlobal('PublicKeyCredential', class {});
    renderGate(makeController({ setupRequired: false, session: null, passkeysAvailable: true }));
    expect(await screen.findByRole('button', { name: /passkey/i })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('renders the app when signed in, and a lock screen that hides it when locked', async () => {
    const user = userEvent.setup();
    renderGate(makeController({ setupRequired: false, session, passkeysAvailable: false }));
    expect(await screen.findByText('app:signed-in')).toBeInTheDocument();
    await user.click(screen.getByText('lock'));
    expect(await screen.findByRole('heading', { name: 'Locked' })).toBeInTheDocument();
    // App stays mounted (unsaved state survives) but hidden and inert.
    expect(screen.queryByText('app:locked')).not.toBeVisible();
  });

  it('shows a loading state before the first status answer', () => {
    renderGate(
      makeController(
        { setupRequired: false, session, passkeysAvailable: false },
        { status: () => new Promise(() => {}) },
      ),
    );
    expect(screen.getByRole('status', { name: 'Loading Webfront' })).toBeInTheDocument();
  });

  it('opens straight into the app when the server is unreachable but this device signed in before', async () => {
    const controller = createAuthController({
      api: {
        status: async () => Promise.reject(new TypeError('x') as never),
        setup: async () => session,
        login: async () => session,
        logout: async () => {},
        passkeyLogin: async () => session,
      },
      data: { startSync: () => {}, stopSync: () => {} },
      setCsrfToken: () => {},
      storage: {
        load: () => ({ username: 'jeff', session: { ...session, csrfToken: undefined } as never }),
        save: () => {},
        clear: () => {},
      },
      verifier: { set: async () => {}, check: async () => null, clear: () => {} },
      retryMs: 0,
    });
    renderGate(controller as never);
    await waitFor(() => expect(screen.getByText('app:offline')).toBeInTheDocument());
  });
});

describe('localVerifier', () => {
  it('verifies the right password and rejects a wrong one; null when nothing stored', async () => {
    localStorage.clear();
    expect(await localVerifier.check('x')).toBeNull();
    await localVerifier.set('correct horse battery');
    expect(await localVerifier.check('correct horse battery')).toBe(true);
    expect(await localVerifier.check('wrong')).toBe(false);
    // Only a salted hash is stored, never the password.
    expect(JSON.stringify({ ...localStorage })).not.toContain('correct horse');
    localVerifier.clear();
    expect(await localVerifier.check('correct horse battery')).toBeNull();
  });
});
