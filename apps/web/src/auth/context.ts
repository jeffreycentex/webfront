import type { LoginRequest, SessionInfo, SetupRequest } from '@webfront/shared';
import { createContext, useContext } from 'react';
import type { AuthStatus } from './controller';

export interface AuthState {
  status: AuthStatus;
  session: SessionInfo | null;
  setup(request: SetupRequest): Promise<void>;
  login(request: LoginRequest): Promise<void>;
  loginWithPasskey(): Promise<void>;
  logout(): Promise<void>;
  /** Re-check the session (e.g. after a 401 from sync). */
  refresh(): Promise<void>;
  lock(): void;
  /** Unlock without a password check (use `unlockWithPassword` from UI). */
  unlock(): void;
  /** Whether any passkey is registered (offer passkey sign-in). */
  passkeysAvailable: boolean;
  /** False when the last check could not reach the server. */
  serverReachable: boolean;
  /** Check the password (locally, falling back to the server) and unlock. */
  unlockWithPassword(password: string): Promise<boolean>;
}

export const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}
