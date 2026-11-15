// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearLocalData, onDataReset, reader } from '@/data';
import { createPage } from '../features/wiki/data';
import { bodyStore, registerWikiResolver } from '../features/wiki/runtime';
import { AUTOSAVE_MS, recoverBackup, useBodyEditor } from '../features/wiki/useBodyEditor';
import { getLocal } from './runtime';

/**
 * A server restore resets the data layer; the wiki (subscribed through `onDataReset`) must drop
 * its per-device merge state and draft backups, and an open editor must not write its stale
 * text onto the restored page. Uses the real `@/data` singletons on fake IndexedDB.
 */

const EPOCH = 'ab'.repeat(16);
const DRAFT_KEY = (id: string) => `webfront.wiki.draft.${id}`;

beforeEach(async () => {
  registerWikiResolver();
  await clearLocalData();
});
afterEach(() => cleanup());

describe('wiki after a server restore', () => {
  it('clears wiki device state and drops the open editor’s pending save', async () => {
    const page = await createPage({ title: 'Notes', body: 'restored text' });
    expect(bodyStore.keys()).toContain(page.id); // merge state from the save
    localStorage.setItem(
      DRAFT_KEY(page.id),
      JSON.stringify({ text: 'stale draft', from: 'restored text', at: Date.now() }),
    );
    localStorage.setItem('webfront.wiki.editMode', 'edit'); // a preference: survives

    const resets: number[] = [];
    const off = onDataReset((e) => resets.push(e.generation));
    const { result, unmount } = renderHook(() => useBodyEditor(page));
    act(() => result.current.setDraft('stale typed text')); // autosave pending

    // Restore: local data replaced, then the restored page is pulled back.
    const local = getLocal();
    await local.resetForRestore({ serverId: 'restored', epoch: EPOCH });
    expect(resets).toHaveLength(1);
    await local.applyPull({
      serverId: 'restored',
      epoch: EPOCH,
      records: [{ collection: 'wikiPages', seq: 1, record: { ...page } }],
      cursor: 1,
      hasMore: false,
    });

    expect(localStorage.getItem(DRAFT_KEY(page.id))).toBeNull();
    expect(localStorage.getItem('webfront.wiki.editMode')).toBe('edit');
    expect(bodyStore.keys()).toEqual([]);

    // The autosave would have fired by now; a flush (blur, tab hidden) and unmount do nothing.
    await act(() => new Promise((r) => setTimeout(r, AUTOSAVE_MS + 150)));
    await act(() => result.current.flush());
    unmount();
    await new Promise((r) => setTimeout(r, 20));

    expect((await reader.get('wikiPages', page.id))?.body).toBe('restored text');
    expect(await local.pendingCount()).toBe(0);
    expect(await recoverBackup(page.id)).toBe(false);
    off();
  });

  it('a newly mounted editor after the reset saves normally', async () => {
    const page = await createPage({ title: 'Fresh', body: 'one' });
    await getLocal().resetForRestore({ serverId: 'restored', epoch: EPOCH });
    await getLocal().applyPull({
      serverId: 'restored',
      epoch: EPOCH,
      records: [{ collection: 'wikiPages', seq: 1, record: { ...page } }],
      cursor: 1,
      hasMore: false,
    });
    const restored = (await reader.get('wikiPages', page.id))!;
    const { result, unmount } = renderHook(() => useBodyEditor(restored));
    act(() => result.current.setDraft('two'));
    await act(() => result.current.flush());
    unmount();
    expect((await reader.get('wikiPages', page.id))?.body).toBe('two');
  });
});
