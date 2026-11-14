import {
  sessionInfoSchema,
  type LoginRequest,
  type SessionInfo,
  type SetupRequest,
} from '@webfront/shared';
import { z } from 'zod';
import { ApiRequestError } from '../lib/api';
import { defaultDeviceName } from '../lib/platform';

/**
 * The auth state machine, free of React so it can be tested with fakes.
 *
 *   loading ──status──▶ setup-required            (no account on the server yet)
 *                    ├▶ signed-in                 (session cookie valid)
 *                    ├▶ signed-out                (no/expired session: 401 or session null)
 *                    └▶ offline                   (server unreachable AND this device signed in
 *                                                  before: open straight into the local data)
 *   signed-in / offline ──lock──▶ locked ──unlock──▶ signed-in / offline
 *   any ──logout──▶ signed-out (local data cleared; explicit logout only)
 *
 * Rules (PLAN.md "Offline access"):
 * - Server unreachable + previously signed in => `offline`, never the login screen.
 * - A 401 / "no session" from a reachable server => `signed-out`: show login, KEEP local data.
 * - Only an explicit `logout()` clears local data (the data layer's clear function).
 * - Sync runs while signed-in, offline or locked, and stops when signed out.
 */

export type AuthStatus =
  /** Checking /api/auth/status. */
  | 'loading'
  /** No account exists yet: show the create-account screen. */
  | 'setup-required'
  | 'signed-out'
  | 'signed-in'
  /** Server unreachable but this device signed in before: open the local copy. */
  | 'offline'
  /** Idle convenience lock is showing. */
  | 'locked';

export interface AuthSnapshot {
  status: AuthStatus;
  session: SessionInfo | null;
  /** Whether any passkey is registered (offer passkey sign-in). */
  passkeysAvailable: boolean;
  /** False when the last status check could not reach the server. */
  serverReachable: boolean;
}

const storedSchema = z.object({
  username: z.string(),
  session: sessionInfoSchema.omit({ csrfToken: true }),
});
type Stored = z.infer<typeof storedSchema>;

export interface AuthDeps {
  api: {
    status(): Promise<{
      setupRequired: boolean;
      session: SessionInfo | null;
      passkeysAvailable: boolean;
    }>;
    setup(request: SetupRequest): Promise<SessionInfo>;
    login(request: LoginRequest): Promise<SessionInfo>;
    logout(): Promise<void>;
    passkeyLogin(deviceName: string): Promise<SessionInfo>;
  };
  data: {
    startSync(): Promise<void> | void;
    stopSync(): Promise<void> | void;
    /** Wipe local data; absent until the data layer provides one. */
    clearLocalData?: (() => Promise<void> | void) | undefined;
  };
  setCsrfToken(token: string | null): void;
  /** "Has this device signed in before" marker. */
  storage: { load(): Stored | null; save(value: Stored): void; clear(): void };
  verifier: {
    set(password: string): Promise<void>;
    check(password: string): Promise<boolean | null>;
    clear(): void;
  };
  /** Milliseconds between silent re-checks while offline. 0 disables. */
  retryMs?: number;
  deviceName?: () => string;
}

export interface AuthController {
  subscribe(listener: () => void): () => void;
  getSnapshot(): AuthSnapshot;
  /** Begin: first status check, offline retry timer, `online` listener. */
  start(): void;
  dispose(): void;
  refresh(): Promise<void>;
  setup(request: SetupRequest): Promise<void>;
  login(request: LoginRequest): Promise<void>;
  loginWithPasskey(): Promise<void>;
  logout(): Promise<void>;
  lock(): void;
  unlock(): void;
  /** Verify the password locally (or via the server if no local verifier). */
  unlockWithPassword(password: string): Promise<boolean>;
}

export function createAuthController(deps: AuthDeps): AuthController {
  let snap: AuthSnapshot = {
    status: 'loading',
    session: null,
    passkeysAvailable: false,
    serverReachable: true,
  };
  const listeners = new Set<() => void>();
  let inflight: Promise<void> | null = null;
  let syncing = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let onOnline: (() => void) | null = null;

  const set = (patch: Partial<AuthSnapshot>) => {
    snap = { ...snap, ...patch };
    for (const l of listeners) l();
    scheduleRetry();
  };

  const deviceName = () => (deps.deviceName ?? defaultDeviceName)();

  function startSync() {
    if (syncing) return;
    syncing = true;
    void Promise.resolve(deps.data.startSync()).catch(() => {
      syncing = false;
    });
  }
  function stopSync() {
    if (!syncing) return;
    syncing = false;
    void Promise.resolve(deps.data.stopSync()).catch(() => {});
  }

  function scheduleRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    const ms = deps.retryMs ?? 30_000;
    if (disposed || !ms || snap.serverReachable) return;
    if (snap.status === 'loading') return;
    retryTimer = setTimeout(() => void refresh(), ms);
  }

  /** Server confirmed this session. Keeps `locked` if the screen is locked. */
  function applySession(session: SessionInfo, patch: Partial<AuthSnapshot> = {}) {
    deps.setCsrfToken(session.csrfToken);
    const { csrfToken: _omit, ...rest } = session;
    deps.storage.save({ username: session.username, session: rest });
    set({
      session,
      serverReachable: true,
      status: snap.status === 'locked' ? 'locked' : 'signed-in',
      ...patch,
    });
    startSync();
  }

  function signedOut(patch: Partial<AuthSnapshot> = {}) {
    deps.setCsrfToken(null);
    stopSync();
    set({ status: 'signed-out', session: null, ...patch });
  }

  function goOffline(stored: Stored) {
    deps.setCsrfToken(null);
    set({
      status: snap.status === 'locked' ? 'locked' : 'offline',
      session: { ...stored.session, csrfToken: '' },
      serverReachable: false,
    });
    startSync();
  }

  async function check(): Promise<void> {
    try {
      const s = await deps.api.status();
      if (disposed) return;
      if (s.setupRequired) {
        deps.setCsrfToken(null);
        stopSync();
        set({
          status: 'setup-required',
          session: null,
          passkeysAvailable: false,
          serverReachable: true,
        });
      } else if (s.session) {
        applySession(s.session, { passkeysAvailable: s.passkeysAvailable });
      } else {
        signedOut({ passkeysAvailable: s.passkeysAvailable, serverReachable: true });
      }
    } catch (err) {
      if (disposed) return;
      if (err instanceof ApiRequestError && err.status === 401) {
        signedOut({ serverReachable: true });
      } else {
        // Unreachable, or the server is erroring (5xx): treat as offline.
        const stored = deps.storage.load();
        if (stored) goOffline(stored);
        else if (snap.status !== 'signed-in' && snap.status !== 'locked') {
          // Never signed in on this device and nothing to open: login screen with a notice.
          signedOut({ serverReachable: false });
        } else {
          set({ serverReachable: false });
        }
      }
    }
  }

  function refresh(): Promise<void> {
    if (!inflight) {
      inflight = check().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  const controller: AuthController = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snap,
    start() {
      disposed = false;
      if (typeof window !== 'undefined') {
        onOnline = () => {
          if (!snap.serverReachable) void refresh();
        };
        window.addEventListener('online', onOnline);
      }
      void refresh();
    },
    dispose() {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (onOnline && typeof window !== 'undefined') window.removeEventListener('online', onOnline);
    },
    refresh,
    async setup(request) {
      const session = await deps.api.setup({
        ...request,
        deviceName: request.deviceName ?? deviceName(),
      });
      applySession(session, { passkeysAvailable: false });
      void deps.verifier.set(request.password);
    },
    async login(request) {
      const session = await deps.api.login({
        ...request,
        deviceName: request.deviceName ?? deviceName(),
      });
      applySession(session);
      void deps.verifier.set(request.password);
    },
    async loginWithPasskey() {
      const session = await deps.api.passkeyLogin(deviceName());
      applySession(session);
      if (snap.status === 'locked') controller.unlock();
    },
    async logout() {
      try {
        await deps.api.logout();
      } catch {
        // Offline or already expired: still sign out locally.
      }
      stopSync();
      try {
        await deps.data.clearLocalData?.();
      } catch {
        // Keep going: the session is gone either way.
      }
      deps.storage.clear();
      deps.verifier.clear();
      signedOut({ passkeysAvailable: snap.passkeysAvailable });
    },
    lock() {
      if (snap.status === 'signed-in' || snap.status === 'offline') set({ status: 'locked' });
    },
    unlock() {
      if (snap.status !== 'locked') return;
      set({ status: snap.serverReachable ? 'signed-in' : 'offline' });
      void refresh();
    },
    async unlockWithPassword(password) {
      const local = await deps.verifier.check(password);
      if (local === true) {
        controller.unlock();
        return true;
      }
      if (local === false) return false;
      // No local verifier (passkey-only sign-in, cleared storage): ask the server.
      const username = snap.session?.username;
      if (!username) return false;
      try {
        const session = await deps.api.login({ username, password, deviceName: deviceName() });
        applySession(session);
        void deps.verifier.set(password);
        controller.unlock();
        return true;
      } catch (err) {
        if (err instanceof ApiRequestError) return false;
        throw err;
      }
    },
  };
  return controller;
}
