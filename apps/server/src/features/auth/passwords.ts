import { hash, parseOptions, verify, type Algorithm, type Options } from '@node-rs/argon2';
import { AppError } from '../../http/errors.js';

/**
 * Argon2id password hashing.
 *
 * Default parameters: 46 MiB, 2 passes, 1 lane (above the OWASP minimum of 19 MiB/t=2, and
 * small enough for a 512 MB container). At most `maxConcurrent` hashes run at once so a burst
 * of login requests cannot exhaust memory; excess requests wait in a short bounded queue.
 */

export interface PasswordHashParams {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

export const DEFAULT_HASH_PARAMS: PasswordHashParams = {
  memoryCost: 47_104,
  timeCost: 2,
  parallelism: 1,
};

const ARGON2ID = 2 as Algorithm;

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  /** Verify; with `stored === null` it verifies against a dummy hash (same cost) and returns false. */
  verify(stored: string | null, password: string): Promise<boolean>;
  /** True when `stored` was made with different parameters and should be re-hashed. */
  needsRehash(stored: string): boolean;
}

/** Passwords are NFC-normalised so the same password typed on different devices matches. */
const normalise = (password: string) => password.normalize('NFC');

function createLimiter(maxConcurrent: number, maxQueued: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= maxConcurrent) {
      if (queue.length >= maxQueued) {
        throw new AppError(429, 'rate_limited', 'Too many sign-in attempts in progress', {
          retryAfterSeconds: 1,
        });
      }
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

export function createPasswordHasher(
  params: PasswordHashParams = DEFAULT_HASH_PARAMS,
  options: { maxConcurrent?: number; maxQueued?: number } = {},
): PasswordHasher {
  const argonOptions: Options = { ...params, algorithm: ARGON2ID };
  const limit = createLimiter(options.maxConcurrent ?? 2, options.maxQueued ?? 16);
  let dummy: Promise<string> | null = null;
  const dummyHash = () =>
    (dummy ??= hash(`dummy-${crypto.randomUUID()}`, argonOptions).catch((err: unknown) => {
      dummy = null;
      throw err;
    }));

  return {
    hash: (password) => limit(() => hash(normalise(password), argonOptions)),
    verify: async (stored, password) => {
      const target = stored ?? (await dummyHash());
      const ok = await limit(async () => {
        try {
          return await verify(target, normalise(password));
        } catch {
          return false;
        }
      });
      return stored !== null && ok;
    },
    needsRehash: (stored) => {
      try {
        const p = parseOptions(stored);
        return (
          p.algorithm !== ARGON2ID ||
          p.memoryCost !== params.memoryCost ||
          p.timeCost !== params.timeCost ||
          p.parallelism !== params.parallelism
        );
      } catch {
        return true;
      }
    },
  };
}
