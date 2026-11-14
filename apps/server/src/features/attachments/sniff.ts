/**
 * Image type detection from magic bytes. The declared Content-Type of an upload is ignored:
 * only these raster formats are accepted, and the stored/served type is the detected one.
 * SVG (and anything else that can carry script) is never accepted.
 */

export const ALLOWED_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
} as const;

export type AllowedType = keyof typeof ALLOWED_TYPES;

function startsWith(buf: Uint8Array, bytes: readonly number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[offset + i] !== bytes[i]) return false;
  return true;
}

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

export function sniffImageType(buf: Uint8Array): AllowedType | null {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(buf, ascii('GIF87a')) || startsWith(buf, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(buf, ascii('RIFF')) && startsWith(buf, ascii('WEBP'), 8)) return 'image/webp';
  // ISO-BMFF: size(4) 'ftyp' brand(4). AVIF brands: avif (still), avis (sequence).
  if (
    startsWith(buf, ascii('ftyp'), 4) &&
    (startsWith(buf, ascii('avif'), 8) || startsWith(buf, ascii('avis'), 8))
  ) {
    return 'image/avif';
  }
  return null;
}

export function isAllowedType(type: string): type is AllowedType {
  return Object.prototype.hasOwnProperty.call(ALLOWED_TYPES, type);
}
