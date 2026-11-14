import { safeStorage } from '../lib/platform';

/**
 * Convenience-lock password check that works offline. After a successful sign-in we keep a
 * salted PBKDF2 hash of the password in localStorage so the idle lock screen can verify it
 * without the server. This is NOT a security boundary (local data is not encrypted, see
 * PLAN.md); it only stops someone casually walking up to an unlocked screen.
 */
const KEY = 'wf.lock.verifier';
const ITERATIONS = 150_000;

interface Stored {
  salt: string;
  hash: string;
  iterations: number;
}

export interface LocalVerifier {
  set(password: string): Promise<void>;
  /** true/false when a verifier exists, null when none is stored. */
  check(password: string): Promise<boolean | null>;
  clear(): void;
}

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function derive(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('WebCrypto unavailable');
  const key = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256,
  );
  return b64(new Uint8Array(bits));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const localVerifier: LocalVerifier = {
  async set(password) {
    try {
      const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
      const hash = await derive(password, salt, ITERATIONS);
      const value: Stored = { salt: b64(salt), hash, iterations: ITERATIONS };
      safeStorage.set(KEY, JSON.stringify(value));
    } catch {
      // No WebCrypto (insecure context): the lock falls back to server verification.
    }
  },
  async check(password) {
    const raw = safeStorage.get(KEY);
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as Stored;
      const hash = await derive(password, unb64(v.salt), v.iterations);
      return constantTimeEqual(hash, v.hash);
    } catch {
      return null;
    }
  },
  clear() {
    safeStorage.remove(KEY);
  },
};
