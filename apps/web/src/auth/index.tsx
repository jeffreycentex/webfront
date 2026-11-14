import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useSyncStatus } from '../data';
import { setUnauthorizedHandler } from '../lib/api';
import { AuthContext, useAuth, type AuthState } from './context';
import { createAuthController, type AuthController } from './controller';
import { createDefaultDeps } from './deps';
import { useIdleLock, useIdleLockMinutes } from './idleLock';
import { LockScreen, LoadingScreen, LoginScreen, SetupScreen } from './screens';

/**
 * `@/auth` — client session state and the sign-in screens.
 *
 *   const { status, session, logout, lock } = useAuth();
 *
 * `status`: loading | setup-required | signed-out | signed-in | offline | locked. `offline` means
 * the server is unreachable but this device signed in before, so the app runs on local data.
 * The state machine lives in `controller.ts`; `AuthGate` (used once by the app shell) shows the
 * right screen and only renders the app for signed-in / offline / locked.
 */
export type { AuthStatus } from './controller';
export {
  IDLE_LOCK_KEY,
  getIdleLockMinutes,
  setIdleLockMinutes,
  useIdleLockMinutes,
} from './idleLock';
export { createAuthController } from './controller';
export { useAuth, type AuthState } from './context';

export function AuthProvider({
  children,
  controller: injected,
}: {
  children: ReactNode;
  /** Tests inject a controller built with fakes. */
  controller?: AuthController;
}) {
  const [controller] = useState(() => injected ?? createAuthController(createDefaultDeps()));
  useEffect(() => {
    controller.start();
    const off = setUnauthorizedHandler(() => void controller.refresh());
    return () => {
      off();
      controller.dispose();
    };
  }, [controller]);

  const snap = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  // The sync engine saw a 401: re-check the session (moves us to the login screen if it expired).
  const syncState = useSyncStatus().state;
  const lastSyncState = useRef(syncState);
  useEffect(() => {
    if (syncState === 'unauthenticated' && lastSyncState.current !== 'unauthenticated') {
      void controller.refresh();
    }
    lastSyncState.current = syncState;
  }, [syncState, controller]);

  // Optional idle lock.
  const [minutes] = useIdleLockMinutes();
  const lock = useCallback(() => controller.lock(), [controller]);
  useIdleLock(snap.status === 'signed-in' || snap.status === 'offline', minutes, lock);

  const value = useMemo<AuthState>(
    () => ({
      ...snap,
      setup: (r) => controller.setup(r),
      login: (r) => controller.login(r),
      loginWithPasskey: () => controller.loginWithPasskey(),
      logout: () => controller.logout(),
      refresh: () => controller.refresh(),
      lock: () => controller.lock(),
      unlock: () => controller.unlock(),
      unlockWithPassword: (p) => controller.unlockWithPassword(p),
    }),
    [snap, controller],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Shows loading / setup / login / lock screens; renders the app when there is a session. */
export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth();
  switch (auth.status) {
    case 'loading':
      return <LoadingScreen />;
    case 'setup-required':
      return <SetupScreen />;
    case 'signed-out':
      return <LoginScreen />;
    case 'locked':
      return (
        <>
          {/* Keep the app mounted (unsaved edits survive) but hidden and inert. */}
          <div hidden inert>
            {children}
          </div>
          <LockScreen />
        </>
      );
    default:
      return <>{children}</>;
  }
}
