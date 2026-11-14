import { CSRF_HEADER, newId } from '@webfront/shared';
import { useSyncExternalStore } from 'react';
import { reader } from '@/data';
import { getCsrfToken } from '@/lib/api';
import { saveBody } from './lib/bodySync';
import { PENDING_IMAGE_PREFIX } from './lib/text';
import { bodyStore, wikiIO } from './runtime';

/**
 * Pasted / dropped images.
 *
 * Online: uploaded to `POST /api/attachments` and referenced as `/api/attachments/<sha256>`.
 * Offline (or when the upload fails for network reasons): the blob is kept in a small
 * IndexedDB database of its own (`webfront-wiki-attachments`, separate from the app's Dexie
 * schema), shown immediately through an object URL, and referenced by the placeholder
 * `/api/attachments/pending/<localId>`. The uploader retries when the browser comes back online
 * (and every minute) and then rewrites the placeholder in every page that uses it.
 */

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ACCEPTED = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'];

interface PendingAttachment {
  localId: string;
  blob: Blob;
  name: string;
  createdAt: string;
}

const DB_NAME = 'webfront-wiki-attachments';
const STORE = 'pending';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE))
        req.result.createObjectStore(STORE, { keyPath: 'localId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      let result: T;
      req.onsuccess = () => {
        result = req.result;
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------ object URLs (live) */

const urls = new Map<string, string>();
let version = 0;
const listeners = new Set<() => void>();
let loaded: Promise<void> | null = null;

function bump() {
  version++;
  for (const fn of listeners) fn();
}

/** Load object URLs for every pending attachment (once). */
export function loadPending(): Promise<void> {
  loaded ??= (async () => {
    try {
      const all = await withStore<PendingAttachment[]>(
        'readonly',
        (s) => s.getAll() as IDBRequest<PendingAttachment[]>,
      );
      for (const p of all)
        if (!urls.has(p.localId)) urls.set(p.localId, URL.createObjectURL(p.blob));
      if (all.length > 0) bump();
    } catch (err) {
      console.warn('wiki: could not read pending attachments', err);
    }
  })();
  return loaded;
}

export function pendingUrl(localId: string): string | undefined {
  return urls.get(localId);
}

/** Re-render when pending object URLs change. */
export function usePendingAttachmentsVersion(): number {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      void loadPending();
      return () => listeners.delete(fn);
    },
    () => version,
    () => 0,
  );
}

/* ------------------------------------------------------------------------ upload */

export class AttachmentError extends Error {}

class Unreachable extends Error {}

async function upload(blob: Blob): Promise<string> {
  const headers: Record<string, string> = {
    'content-type': blob.type || 'application/octet-stream',
  };
  const token = getCsrfToken();
  if (token) headers[CSRF_HEADER] = token;
  let res: Response;
  try {
    res = await fetch('/api/attachments', {
      method: 'POST',
      body: blob,
      headers,
      credentials: 'same-origin',
    });
  } catch {
    throw new Unreachable('offline');
  }
  if ([401, 502, 503, 504].includes(res.status)) throw new Unreachable(`HTTP ${res.status}`);
  const json = (await res.json().catch(() => null)) as {
    url?: string;
    error?: { message?: string };
  } | null;
  if (!res.ok || !json?.url)
    throw new AttachmentError(json?.error?.message ?? `Upload failed (HTTP ${res.status})`);
  return json.url;
}

function altText(name: string): string {
  return (
    name
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[[\]\n]/g, ' ')
      .trim() || 'image'
  );
}

/**
 * Turn a pasted/dropped file into Markdown image syntax: uploaded when possible, otherwise
 * kept locally under a placeholder URL. Throws AttachmentError for unsupported files.
 */
export async function addImage(file: Blob, name = 'image'): Promise<string> {
  if (!ACCEPTED.includes(file.type)) {
    throw new AttachmentError('Only PNG, JPEG, GIF, WebP and AVIF images can be attached.');
  }
  if (file.size > MAX_IMAGE_BYTES) throw new AttachmentError('Images are limited to 10 MB.');
  const alt = altText(name);
  if (typeof navigator === 'undefined' || navigator.onLine) {
    try {
      return `![${alt}](${await upload(file)})`;
    } catch (err) {
      if (!(err instanceof Unreachable)) throw err;
    }
  }
  const localId = newId().replace(/-/g, '');
  await withStore('readwrite', (s) =>
    s.put({
      localId,
      blob: file,
      name,
      createdAt: new Date().toISOString(),
    } satisfies PendingAttachment),
  );
  urls.set(localId, URL.createObjectURL(file));
  bump();
  scheduleUpload(5000);
  return `![${alt}](${PENDING_IMAGE_PREFIX}${localId})`;
}

let uploading: Promise<number> | null = null;

/** Upload every pending attachment and rewrite its placeholder in all pages. */
export function uploadPending(): Promise<number> {
  uploading ??= (async () => {
    let done = 0;
    try {
      const all = await withStore<PendingAttachment[]>(
        'readonly',
        (s) => s.getAll() as IDBRequest<PendingAttachment[]>,
      );
      for (const p of all) {
        let url: string;
        try {
          url = await upload(p.blob);
        } catch (err) {
          if (err instanceof Unreachable) break;
          console.warn('wiki: pending attachment rejected by the server', err);
          continue; // keep it locally; the page keeps showing it
        }
        const placeholder = `${PENDING_IMAGE_PREFIX}${p.localId}`;
        const pages = await reader.list('wikiPages', {
          filter: (pg) => pg.body.includes(placeholder),
        });
        for (const pg of pages) {
          await saveBody(wikiIO, bodyStore, pg.id, pg.body.split(placeholder).join(url), pg.body);
        }
        const still = await reader.list('wikiPages', {
          filter: (pg) => pg.body.includes(placeholder),
        });
        if (still.length === 0) {
          await withStore('readwrite', (s) => s.delete(p.localId));
          done++;
        }
      }
    } catch (err) {
      console.warn('wiki: uploading pending attachments failed', err);
    } finally {
      uploading = null;
    }
    return done;
  })();
  return uploading;
}

let timer: ReturnType<typeof setTimeout> | null = null;

function scheduleUpload(ms: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    if (navigator.onLine) void uploadPending();
    scheduleUpload(60_000);
  }, ms);
}

let started = false;

export function startUploader(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  window.addEventListener('online', () => void uploadPending());
  void loadPending();
  scheduleUpload(3000);
}
