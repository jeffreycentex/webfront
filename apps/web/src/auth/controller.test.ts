import type { SessionInfo } from '@webfront/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, NetworkError } from '../lib/api';
import { createAuthController, type AuthDeps } from './controller';

const session = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  username: 'jeff',
  sessionId: 's1',
  deviceName: 'Test',
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-04-01T00:00:00.000Z',
  csrfToken: 'csrf-1',
  ...over,
});

function setup(over: { stored?: boolean } = {}) {
  let stored: { username: string; session: Omit<SessionInfo, 'csrfToken'> } | null = over.stored
    ? { username: 'jeff', session: (({ csrfToken: _c, ...rest }) => rest)(session()) }
    : null;
  const calls: string[] = [];
  const deps = {
    api: {
      status: vi.fn<AuthDeps['api']['status']>(),
      setup: vi.fn<AuthDeps['api']['setup']>(),
      login: vi.fn<AuthDeps['api']['login']>(),
      logout: vi.fn<AuthDeps['api']['logout']>(async () => {}),
      passkeyLogin: vi.fn<AuthDeps['api']['passkeyLogin']>(),
    },
    data: {
      startSync: vi.fn(() => void calls.push('start')),
      stopSync: vi.fn(() => void calls.push('stop')),
      clearLocalData: vi.fn(() => void calls.push('clear')),
    },
    setCsrfToken: vi.fn(),
    storage: {
      load: () => stored,
      save: vi.fn((v) => void (stored = v)),
      clear: vi.fn(() => void (stored = null)),
    },
    verifier: {
      set: vi.fn(async () => {}),
      check: vi.fn<AuthDeps['verifier']['check']>(async () => null),
      clear: vi.fn(),
    },
    retryMs: 1000,
    deviceName: () => 'Test device',
  } satisfies AuthDeps;
  const controller = createAuthController(deps);
  return { deps, controller, calls, getStored: () => stored };
}

const ok = (s: SessionInfo | null, extra = {}) => ({
  setupRequired: false,
  session: s,
  passkeysAvailable: false,
  ...extra,
});

describe('auth state machine', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts in loading', () => {
    expect(setup().controller.getSnapshot().status).toBe('loading');
  });

  it('signed-in: sets CSRF, remembers the device, starts sync', async () => {
    const { controller, deps, calls, getStored } = setup();
    deps.api.status.mockResolvedValue(ok(session(), { passkeysAvailable: true }));
    await controller.refresh();
    const snap = controller.getSnapshot();
    expect(snap.status).toBe('signed-in');
    expect(snap.passkeysAvailable).toBe(true);
    expect(deps.setCsrfToken).toHaveBeenCalledWith('csrf-1');
    expect(calls).toEqual(['start']);
    expect(getStored()?.username).toBe('jeff');
    // The CSRF token is never persisted.
    expect(JSON.stringify(getStored())).not.toContain('csrf-1');
  });

  it('setup-required when the server has no account', async () => {
    const { controller, deps, calls } = setup();
    deps.api.status.mockResolvedValue({
      setupRequired: true,
      session: null,
      passkeysAvailable: false,
    });
    await controller.refresh();
    expect(controller.getSnapshot().status).toBe('setup-required');
    expect(calls).toEqual([]);
  });

  it('signed-out when the server says there is no session', async () => {
    const { controller, deps } = setup({ stored: true });
    deps.api.status.mockResolvedValue(ok(null));
    await controller.refresh();
    expect(controller.getSnapshot().status).toBe('signed-out');
  });

  it('a 401 means signed out: login screen, sync stopped, local data kept', async () => {
    const { controller, deps, calls, getStored } = setup({ stored: true });
    deps.api.status.mockResolvedValueOnce(ok(session()));
    await controller.refresh();
    deps.api.status.mockRejectedValueOnce(new ApiRequestError(401, 'unauthorized', 'no'));
    await controller.refresh();
    expect(controller.getSnapshot().status).toBe('signed-out');
    expect(controller.getSnapshot().serverReachable).toBe(true);
    expect(deps.setCsrfToken).toHaveBeenLastCalledWith(null);
    expect(calls).toEqual(['start', 'stop']);
    expect(deps.data.clearLocalData).not.toHaveBeenCalled();
    expect(getStored()).not.toBeNull();
  });

  it('offline path: unreachable server + signed in before opens the local data', async () => {
    const { controller, deps, calls } = setup({ stored: true });
    deps.api.status.mockRejectedValue(new NetworkError(new TypeError('fetch failed')));
    await controller.refresh();
    const snap = controller.getSnapshot();
    expect(snap.status).toBe('offline');
    expect(snap.serverReachable).toBe(false);
    expect(snap.session?.username).toBe('jeff');
    expect(calls).toEqual(['start']);
  });

  it('treats a 502 from the reverse proxy like an unreachable server', async () => {
    const { controller, deps } = setup({ stored: true });
    deps.api.status.mockRejectedValue(new ApiRequestError(502, 'http_error', 'HTTP 502'));
    await controller.refresh();
    expect(controller.getSnapshot().status).toBe('offline');
  });

  it('unreachable on a device that never signed in shows login with a notice', async () => {
    const { controller, deps, calls } = setup();
    deps.api.status.mockRejectedValue(new NetworkError(null));
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({
      status: 'signed-out',
      serverReachable: false,
    });
    expect(calls).toEqual([]);
  });

  it('retries while offline and recovers to signed-in', async () => {
    const { controller, deps, calls } = setup({ stored: true });
    deps.api.status.mockRejectedValueOnce(new NetworkError(null));
    await controller.refresh();
    expect(controller.getSnapshot().status).toBe('offline');
    deps.api.status.mockResolvedValue(ok(session()));
    await vi.advanceTimersByTimeAsync(1100);
    expect(controller.getSnapshot()).toMatchObject({ status: 'signed-in', serverReachable: true });
    expect(deps.setCsrfToken).toHaveBeenLastCalledWith('csrf-1');
    expect(calls).toEqual(['start']); // sync was already running; not restarted
  });

  it('offline then the server reports no session: signed out', async () => {
    const { controller, deps } = setup({ stored: true });
    deps.api.status.mockRejectedValueOnce(new NetworkError(null));
    await controller.refresh();
    deps.api.status.mockResolvedValue(ok(null));
    await vi.advanceTimersByTimeAsync(1100);
    expect(controller.getSnapshot().status).toBe('signed-out');
  });

  it('login failure keeps the user signed out and propagates the error', async () => {
    const { controller, deps } = setup();
    deps.api.status.mockResolvedValue(ok(null));
    await controller.refresh();
    deps.api.login.mockRejectedValue(new ApiRequestError(401, 'unauthorized', 'bad'));
    await expect(controller.login({ username: 'a', password: 'b' })).rejects.toBeInstanceOf(
      ApiRequestError,
    );
    expect(controller.getSnapshot().status).toBe('signed-out');
  });

  it('login success: session, sync, device name default, local verifier', async () => {
    const { controller, deps, calls } = setup();
    deps.api.status.mockResolvedValue(ok(null));
    await controller.refresh();
    deps.api.login.mockResolvedValue(session());
    await controller.login({ username: 'jeff', password: 'correct horse' });
    expect(deps.api.login).toHaveBeenCalledWith({
      username: 'jeff',
      password: 'correct horse',
      deviceName: 'Test device',
    });
    expect(controller.getSnapshot().status).toBe('signed-in');
    expect(deps.verifier.set).toHaveBeenCalledWith('correct horse');
    expect(calls).toEqual(['start']);
  });

  it('setup creates the account and signs in', async () => {
    const { controller, deps } = setup();
    deps.api.status.mockResolvedValue({
      setupRequired: true,
      session: null,
      passkeysAvailable: false,
    });
    await controller.refresh();
    deps.api.setup.mockResolvedValue(session());
    await controller.setup({ username: 'jeff', password: 'a long password' });
    expect(controller.getSnapshot().status).toBe('signed-in');
  });

  it('passkey login signs in', async () => {
    const { controller, deps } = setup();
    deps.api.status.mockResolvedValue(ok(null, { passkeysAvailable: true }));
    await controller.refresh();
    deps.api.passkeyLogin.mockResolvedValue(session());
    await controller.loginWithPasskey();
    expect(deps.api.passkeyLogin).toHaveBeenCalledWith('Test device');
    expect(controller.getSnapshot().status).toBe('signed-in');
  });

  it('explicit logout: server logout, stop sync, clear local data, forget the device', async () => {
    const { controller, deps, calls, getStored } = setup();
    deps.api.status.mockResolvedValue(ok(session()));
    await controller.refresh();
    await controller.logout();
    expect(controller.getSnapshot()).toMatchObject({ status: 'signed-out', session: null });
    expect(calls).toEqual(['start', 'stop', 'clear']);
    expect(getStored()).toBeNull();
    expect(deps.verifier.clear).toHaveBeenCalled();
  });

  it('logout still works when the server is unreachable', async () => {
    const { controller, deps, calls } = setup({ stored: true });
    deps.api.status.mockRejectedValue(new NetworkError(null));
    await controller.refresh();
    deps.api.logout.mockRejectedValue(new NetworkError(null));
    await controller.logout();
    expect(controller.getSnapshot().status).toBe('signed-out');
    expect(calls).toContain('clear');
  });

  it('logout works if the data layer has no clear function yet', async () => {
    const { controller, deps } = setup();
    deps.data.clearLocalData = undefined as never;
    deps.api.status.mockResolvedValue(ok(session()));
    await controller.refresh();
    await expect(controller.logout()).resolves.toBeUndefined();
    expect(controller.getSnapshot().status).toBe('signed-out');
  });

  describe('lock', () => {
    async function signedIn() {
      const s = setup();
      s.deps.api.status.mockResolvedValue(ok(session()));
      await s.controller.refresh();
      return s;
    }

    it('lock and unlock return to the previous state; sync keeps running', async () => {
      const { controller, calls } = await signedIn();
      controller.lock();
      expect(controller.getSnapshot().status).toBe('locked');
      controller.unlock();
      expect(controller.getSnapshot().status).toBe('signed-in');
      expect(calls).toEqual(['start']);
    });

    it('lock is ignored when signed out', async () => {
      const { controller, deps } = setup();
      deps.api.status.mockResolvedValue(ok(null));
      await controller.refresh();
      controller.lock();
      expect(controller.getSnapshot().status).toBe('signed-out');
    });

    it('unlockWithPassword uses the local verifier', async () => {
      const { controller, deps } = await signedIn();
      controller.lock();
      deps.verifier.check.mockResolvedValue(false);
      expect(await controller.unlockWithPassword('nope')).toBe(false);
      expect(controller.getSnapshot().status).toBe('locked');
      deps.verifier.check.mockResolvedValue(true);
      expect(await controller.unlockWithPassword('right')).toBe(true);
      expect(controller.getSnapshot().status).toBe('signed-in');
      expect(deps.api.login).not.toHaveBeenCalled();
    });

    it('unlockWithPassword falls back to the server when no verifier is stored', async () => {
      const { controller, deps } = await signedIn();
      controller.lock();
      deps.verifier.check.mockResolvedValue(null);
      deps.api.login.mockRejectedValueOnce(new ApiRequestError(401, 'unauthorized', 'bad'));
      expect(await controller.unlockWithPassword('wrong')).toBe(false);
      deps.api.login.mockResolvedValueOnce(session());
      expect(await controller.unlockWithPassword('right')).toBe(true);
      expect(controller.getSnapshot().status).toBe('signed-in');
    });

    it('a session that expires while locked ends at signed-out, not unlocked', async () => {
      const { controller, deps } = await signedIn();
      controller.lock();
      deps.api.status.mockResolvedValue(ok(null));
      await controller.refresh();
      expect(controller.getSnapshot().status).toBe('signed-out');
    });

    it('offline + locked + unlock goes back to offline', async () => {
      const s = setup({ stored: true });
      s.deps.api.status.mockRejectedValue(new NetworkError(null));
      await s.controller.refresh();
      s.controller.lock();
      s.deps.verifier.check.mockResolvedValue(true);
      await s.controller.unlockWithPassword('pw');
      expect(s.controller.getSnapshot().status).toBe('offline');
    });
  });

  it('notifies subscribers', async () => {
    const { controller, deps } = setup();
    const fn = vi.fn();
    controller.subscribe(fn);
    deps.api.status.mockResolvedValue(ok(null));
    await controller.refresh();
    expect(fn).toHaveBeenCalled();
  });
});
