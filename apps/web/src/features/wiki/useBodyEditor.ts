import { useCallback, useEffect, useRef, useState } from 'react';
import { onDataReset, reader } from '@/data';
import { saveBody, snapshotPage, type WikiPage } from './data';
import { bodyStore, wikiIO } from './runtime';

/**
 * Editing state of one page body: the draft, debounced autosave through `@/data` (via the
 * body-sync `saveBody`, which merges if the stored body moved on underneath the editor), and
 * a visible save state.
 *
 * No data loss: every keystroke also goes to a localStorage backup (`webfront.wiki.draft.<id>`),
 * cleared once the text is stored; the draft is flushed on blur, when the tab is hidden or
 * closed, and when the page component unmounts (route change). A backup left behind by a tab
 * that closed mid-edit is merged back in the next time the page is opened.
 *
 * After a data reset (server restore, `onDataReset`) the editor is dead: its pending save is
 * cancelled and later flushes do nothing, so text typed against the old page is never written
 * onto the restored one (the shell remounts the page with the restored data).
 */

export type SaveState = 'saved' | 'unsaved' | 'saving' | 'error';

export const AUTOSAVE_MS = 700;
const BACKUP_PREFIX = 'webfront.wiki.draft.';

interface Backup {
  text: string;
  from: string;
  at: number;
}

function readBackup(id: string): Backup | null {
  try {
    const raw = localStorage.getItem(BACKUP_PREFIX + id);
    const b = raw ? (JSON.parse(raw) as Backup) : null;
    return b && typeof b.text === 'string' && typeof b.from === 'string' ? b : null;
  } catch {
    return null;
  }
}

function writeBackup(id: string, b: Backup | null) {
  try {
    if (b) localStorage.setItem(BACKUP_PREFIX + id, JSON.stringify(b));
    else localStorage.removeItem(BACKUP_PREFIX + id);
  } catch {
    // Storage full: autosave still runs.
  }
}

/** Merge a draft left behind by a closed tab into the page. Returns true if anything was recovered. */
export async function recoverBackup(pageId: string): Promise<boolean> {
  const b = readBackup(pageId);
  if (!b) return false;
  const page = await reader.get('wikiPages', pageId);
  if (!page) return false;
  if (b.text === page.body || b.text === b.from) {
    writeBackup(pageId, null);
    return false;
  }
  await saveBody(wikiIO, bodyStore, pageId, b.text, b.from);
  writeBackup(pageId, null);
  return true;
}

export interface BodyEditor {
  draft: string;
  state: SaveState;
  error: string | null;
  /** Bumped when the editor document must be replaced (merge or remote change). */
  replace: { text: string; n: number };
  setDraft(text: string): void;
  flush(): Promise<void>;
}

export function useBodyEditor(page: WikiPage): BodyEditor {
  const id = page.id;
  const [draft, setDraftState] = useState(page.body);
  const [state, setState] = useState<SaveState>('saved');
  const [error, setError] = useState<string | null>(null);
  const [replace, setReplace] = useState({ text: page.body, n: 0 });

  const draftRef = useRef(page.body);
  /** Last text known to be stored. */
  const savedRef = useRef(page.body);
  /** Body the draft was derived from (merge base for saveBody). */
  const fromRef = useRef(page.body);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const edited = useRef(false);
  /** Set by a data reset: this editor's text belongs to data that no longer exists. */
  const dead = useRef(false);

  useEffect(
    () =>
      onDataReset(() => {
        dead.current = true;
        edited.current = false;
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
      }),
    [],
  );

  const pushReplace = useCallback((text: string) => {
    draftRef.current = text;
    setDraftState(text);
    setReplace((r) => ({ text, n: r.n + 1 }));
  }, []);

  const doFlush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (dead.current) return;
    const text = draftRef.current;
    if (text === savedRef.current) {
      writeBackup(id, null);
      setState('saved');
      return;
    }
    setState('saving');
    try {
      const res = await saveBody(wikiIO, bodyStore, id, text, fromRef.current);
      savedRef.current = res.body;
      if (res.body === text) {
        fromRef.current = text;
      } else if (draftRef.current === text) {
        // Merged with a change that arrived meanwhile: show the merged text.
        fromRef.current = res.body;
        pushReplace(res.body);
      } else {
        // The user kept typing: the next save merges against the text we just sent.
        fromRef.current = text;
      }
      if (draftRef.current === savedRef.current) writeBackup(id, null);
      setError(null);
      setState(draftRef.current === savedRef.current ? 'saved' : 'unsaved');
      void snapshotPage(id, 'edit').catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState('error');
    }
  }, [id, pushReplace]);

  const flush = useCallback(() => {
    chain.current = chain.current.then(doFlush, doFlush);
    return chain.current;
  }, [doFlush]);

  const setDraft = useCallback(
    (text: string) => {
      if (dead.current || text === draftRef.current) return;
      draftRef.current = text;
      edited.current = true;
      setDraftState(text);
      setState('unsaved');
      writeBackup(id, { text, from: fromRef.current, at: Date.now() });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), AUTOSAVE_MS);
    },
    [id, flush],
  );

  // A body that changed elsewhere (another device, the reconciler): adopt it when clean.
  useEffect(() => {
    if (dead.current || page.body === savedRef.current) return;
    if (draftRef.current === savedRef.current) {
      savedRef.current = page.body;
      fromRef.current = page.body;
      pushReplace(page.body);
    }
    // Dirty: the next save merges the draft into the new body (saveBody, against `from`).
  }, [page.body, pushReplace]);

  // Flush when the tab is hidden or closed, and on unmount (route change).
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') void flush();
    };
    const onPageHide = () => void flush();
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      void flush().then(() => {
        if (edited.current) void snapshotPage(id, 'leave').catch(() => undefined);
      });
    };
  }, [flush, id]);

  return { draft, state, error, replace, setDraft, flush };
}
