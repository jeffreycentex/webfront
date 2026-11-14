import { z } from 'zod';

/**
 * Identifiers.
 *
 * - Record ids are UUIDs. Clients always create UUIDv7 (time-ordered) via `newId()`.
 *   The server may use deterministic UUIDs for server-owned records (e.g. calendar
 *   occurrences), and `serviceStatuses` reuse the bookmark id. Settings use their key
 *   as id (see `settings.ts`).
 * - A client id identifies one browser profile / device install. It doubles as the
 *   HLC node id, so it is a fixed-width 16-char lowercase hex string (sortable, compact).
 */

export const uuidSchema = z.uuid();

export const CLIENT_ID_PATTERN = /^[0-9a-f]{16}$/;
export const clientIdSchema = z
  .string()
  .regex(CLIENT_ID_PATTERN, 'clientId must be 16 lowercase hex chars');
export type ClientId = z.infer<typeof clientIdSchema>;

function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** New random client / HLC node id (16 hex chars, 64 bits of entropy). */
export function newClientId(): ClientId {
  return toHex(randomBytes(8));
}

/**
 * New UUIDv7 (RFC 9562): 48-bit unix ms timestamp, version 7, 74 random bits.
 * Ids created later sort after earlier ones (at millisecond resolution).
 */
export function newId(nowMs: number = Date.now()): string {
  const bytes = randomBytes(16);
  const ts = Math.max(0, Math.floor(nowMs));
  // 48-bit big-endian timestamp. Use division rather than bit ops (JS bit ops are 32-bit).
  bytes[0] = Math.floor(ts / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ts / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ts / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ts / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Extract the millisecond timestamp from a UUIDv7 (undefined for other versions). */
export function uuidv7Timestamp(id: string): number | undefined {
  const hex = id.replace(/-/g, '');
  if (hex.length !== 32 || hex[12] !== '7') return undefined;
  return parseInt(hex.slice(0, 12), 16);
}
