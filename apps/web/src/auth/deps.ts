import {
  API,
  authStatusResponseSchema,
  passkeyLoginOptionsResponseSchema,
  sessionInfoSchema,
  type LoginRequest,
  type SetupRequest,
} from '@webfront/shared';
import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { z } from 'zod';
import * as data from '../data';
import { apiFetch, setCsrfToken } from '../lib/api';
import { safeStorage } from '../lib/platform';
import type { AuthDeps } from './controller';
import { localVerifier } from './localVerifier';

const STORAGE_KEY = 'wf.auth.v1';

const storedSchema = z.object({
  username: z.string(),
  session: sessionInfoSchema.omit({ csrfToken: true }),
});

/** Names the data layer may export for "wipe the local database" (Task 3 decides). */
const CLEAR_NAMES = [
  'clearLocalData',
  'clearAllData',
  'clearData',
  'resetLocalData',
  'clearDatabase',
];

function findClearFunction(): (() => Promise<void> | void) | undefined {
  const ns = data as unknown as Record<string, unknown>;
  for (const name of CLEAR_NAMES) {
    const fn = ns[name];
    if (typeof fn === 'function') return fn as () => Promise<void> | void;
  }
  return undefined;
}

export function passkeysSupported(): boolean {
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

/** Real dependencies: server API, data layer, localStorage. */
export function createDefaultDeps(): AuthDeps {
  return {
    api: {
      status: () => apiFetch(API.auth.status, { schema: authStatusResponseSchema }),
      setup: (request: SetupRequest) =>
        apiFetch(API.auth.setup, { method: 'POST', body: request, schema: sessionInfoSchema }),
      login: (request: LoginRequest) =>
        apiFetch(API.auth.login, { method: 'POST', body: request, schema: sessionInfoSchema }),
      logout: async () => {
        await apiFetch(API.auth.logout, { method: 'POST', body: {} });
      },
      passkeyLogin: async (deviceName: string) => {
        const { options } = await apiFetch(API.auth.passkeyLoginOptions, {
          method: 'POST',
          body: {},
          schema: passkeyLoginOptionsResponseSchema,
        });
        let response;
        try {
          response = await startAuthentication({
            optionsJSON: options as unknown as PublicKeyCredentialRequestOptionsJSON,
          });
        } catch (err) {
          const name = (err as Error)?.name;
          if (name === 'NotAllowedError' || name === 'AbortError') {
            throw new Error('Passkey sign-in was cancelled or timed out.');
          }
          throw new Error('Passkey sign-in failed on this device.', { cause: err });
        }
        return apiFetch(API.auth.passkeyLoginVerify, {
          method: 'POST',
          body: { response, deviceName },
          schema: sessionInfoSchema,
        });
      },
    },
    data: {
      startSync: () => data.startSync(),
      stopSync: () => data.stopSync(),
      // Resolved at call time so a data layer that adds the function later is picked up.
      clearLocalData: () => findClearFunction()?.(),
    },
    setCsrfToken,
    storage: {
      load() {
        const raw = safeStorage.get(STORAGE_KEY);
        if (!raw) return null;
        try {
          const parsed = storedSchema.safeParse(JSON.parse(raw));
          return parsed.success ? parsed.data : null;
        } catch {
          return null;
        }
      },
      save: (value) => safeStorage.set(STORAGE_KEY, JSON.stringify(value)),
      clear: () => safeStorage.remove(STORAGE_KEY),
    },
    verifier: localVerifier,
  };
}
