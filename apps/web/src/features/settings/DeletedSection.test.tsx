// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { patch, put, reader, remove } from '@/data';
import { ToastProvider } from '@/ui';
import { getLocal } from '../../data/runtime';
import DeletedSection from './DeletedSection';
import { deletedAtOf, loadDeleted } from './deleted';

const k = (n: number) => `a${n}`;

beforeEach(async () => {
  await getLocal().clear();
});
afterEach(cleanup);

function renderSection() {
  return render(
    <ToastProvider>
      <DeletedSection />
    </ToastProvider>,
  );
}

async function live<N extends 'bookmarks' | 'bookmarkCategories' | 'wikiPages' | 'tasks'>(
  c: N,
  id: string,
) {
  return reader.get(c, id);
}

describe('Recently deleted', () => {
  it('lists the user-facing types and leaves out shopping items and wiki revisions', async () => {
    const list = await put('shoppingLists', { name: 'Weekly', sortKey: k(1) } as never);
    const item = await put('shoppingItems', {
      listId: list.id,
      name: 'Milk',
      sortKey: k(1),
    } as never);
    const rev = await put('wikiRevisions', { pageId: list.id, title: 'Old', body: 'x' } as never);
    const bm = await put('bookmarks', {
      url: 'https://www.nas.lan/x',
      title: 'NAS',
      sortKey: k(1),
    } as never);
    const post = await put('postits', { text: '\n  first line\nsecond', sortKey: k(1) } as never);
    const feed = await put('calendarFeeds', {
      name: 'Work',
      url: 'https://cal.example.com/a.ics',
    } as never);
    await put('tasks', { title: 'Alive', sortKey: k(1) });
    for (const [c, id] of [
      ['shoppingLists', list.id],
      ['shoppingItems', item.id],
      ['wikiRevisions', rev.id],
      ['bookmarks', bm.id],
      ['postits', post.id],
      ['calendarFeeds', feed.id],
    ] as const)
      await remove(c, id);

    renderSection();
    expect(await screen.findByText('NAS')).toBeTruthy();
    expect(screen.getByText('nas.lan')).toBeTruthy();
    expect(screen.getByText('first line')).toBeTruthy();
    expect(screen.getByText('Weekly')).toBeTruthy();
    expect(screen.getByText('Work')).toBeTruthy();
    expect(screen.queryByText('Milk')).toBeNull();
    expect(screen.queryByText('Old')).toBeNull();
    expect(screen.queryByText('Alive')).toBeNull();
    expect(screen.getByText(/Cleared shopping items come back/)).toBeTruthy();
  });

  it('shows the empty state', async () => {
    renderSection();
    expect(await screen.findByText('Nothing deleted')).toBeTruthy();
  });

  it('filters by text and by type', async () => {
    const a = await put('tasks', { title: 'Pay rent', sortKey: k(1) });
    const b = await put('tasks', { title: 'Call mum', sortKey: k(2) });
    const c = await put('bookmarks', {
      url: 'https://a.test/',
      title: 'Rent guide',
      sortKey: k(1),
    } as never);
    await remove('tasks', a.id);
    await remove('tasks', b.id);
    await remove('bookmarks', c.id);
    renderSection();
    await screen.findByText('Call mum');
    fireEvent.change(screen.getByLabelText('Filter deleted items'), { target: { value: 'rent' } });
    expect(screen.queryByText('Call mum')).toBeNull();
    expect(screen.getByText('Pay rent')).toBeTruthy();
    expect(screen.getByText('Rent guide')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'tasks' } });
    expect(screen.queryByText('Rent guide')).toBeNull();
    fireEvent.change(screen.getByLabelText('Filter deleted items'), { target: { value: 'zzz' } });
    expect(screen.getByText('No matches')).toBeTruthy();
  });

  it('restoring a bookmark whose category is deleted restores both, and Undo re-deletes both', async () => {
    const cat = await put('bookmarkCategories', {
      name: 'Home',
      parentId: null,
      sortKey: k(1),
    } as never);
    const bm = await put('bookmarks', {
      url: 'https://nas.lan/',
      title: 'NAS',
      categoryId: cat.id,
      sortKey: k(1),
    } as never);
    await remove('bookmarks', bm.id);
    await remove('bookmarkCategories', cat.id);
    renderSection();
    await screen.findByText('NAS');
    fireEvent.click(screen.getByLabelText('Restore NAS'));
    await waitFor(async () => expect(await live('bookmarks', bm.id)).toBeTruthy());
    expect(await live('bookmarkCategories', cat.id)).toBeTruthy();
    expect(await screen.findByText(/its category “Home”/)).toBeTruthy();

    fireEvent.click(screen.getByText('Undo'));
    await waitFor(async () => expect(await live('bookmarks', bm.id)).toBeUndefined());
    expect(await live('bookmarkCategories', cat.id)).toBeUndefined();
  });

  it('restores a sub-category with its parent', async () => {
    const parent = await put('bookmarkCategories', {
      name: 'Top',
      parentId: null,
      sortKey: k(1),
    } as never);
    const sub = await put('bookmarkCategories', {
      name: 'Sub',
      parentId: parent.id,
      sortKey: k(1),
    } as never);
    await remove('bookmarkCategories', sub.id);
    await remove('bookmarkCategories', parent.id);
    renderSection();
    await screen.findByText('Sub');
    fireEvent.click(screen.getByLabelText('Restore Sub'));
    await waitFor(async () => expect(await live('bookmarkCategories', sub.id)).toBeTruthy());
    expect(await live('bookmarkCategories', parent.id)).toBeTruthy();
  });

  it('restoring a category offers and restores the bookmarks deleted with it', async () => {
    const cat = await put('bookmarkCategories', {
      name: 'Media',
      parentId: null,
      sortKey: k(1),
    } as never);
    const a = await put('bookmarks', {
      url: 'https://a.test/',
      title: 'A',
      categoryId: cat.id,
      sortKey: k(1),
    } as never);
    const b = await put('bookmarks', {
      url: 'https://b.test/',
      title: 'B',
      categoryId: cat.id,
      sortKey: k(2),
    } as never);
    const old = await put('bookmarks', {
      url: 'https://c.test/',
      title: 'C',
      categoryId: cat.id,
      sortKey: k(3),
    } as never);
    await remove('bookmarks', old.id);
    await remove('bookmarks', a.id);
    await remove('bookmarks', b.id);
    await remove('bookmarkCategories', cat.id);
    // C was deleted long ago, so it is not part of the group.
    await getLocal()
      .db.table('bookmarks')
      .update(old.id, {
        clocks: {
          ...(await getLocal().db.table('bookmarks').get(old.id)).clocks,
          deleted: '2020-01-01T00:00:00.000Z-0000-0123456789abcdef',
        },
      });
    renderSection();
    const row = (await screen.findByLabelText('Restore Media')).closest('li')!;
    expect(within(row).getByLabelText(/and its 2 deleted bookmarks/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Restore Media'));
    await waitFor(async () => expect(await live('bookmarkCategories', cat.id)).toBeTruthy());
    expect(await live('bookmarks', a.id)).toBeTruthy();
    expect(await live('bookmarks', b.id)).toBeTruthy();
    expect(await live('bookmarks', old.id)).toBeUndefined();
  });

  it('restores a wiki page whose parent is deleted as a top-level page', async () => {
    const parent = await put('wikiPages', {
      title: 'Parent',
      slug: 'parent',
      sortKey: k(1),
    } as never);
    const child = await put('wikiPages', {
      title: 'Child',
      slug: 'child',
      parentId: parent.id,
      sortKey: k(1),
    } as never);
    await remove('wikiPages', child.id);
    await remove('wikiPages', parent.id);
    // A live page took the slug in the meantime.
    await put('wikiPages', { title: 'Other', slug: 'child', sortKey: k(2) } as never);
    renderSection();
    await screen.findByText('Child');
    fireEvent.click(screen.getByLabelText('Restore Child'));
    await waitFor(async () => expect(await live('wikiPages', child.id)).toBeTruthy());
    const restored = (await live('wikiPages', child.id))!;
    expect(restored.parentId).toBeNull();
    expect(restored.slug).toBe('child-2');
    expect(await live('wikiPages', parent.id)).toBeUndefined();

    fireEvent.click(screen.getByText('Undo'));
    await waitFor(async () => expect(await live('wikiPages', child.id)).toBeUndefined());
    const gone = (await getLocal().list('wikiPages', { includeDeleted: true })).find(
      (p) => p.id === child.id,
    )!;
    expect(gone.parentId).toBe(parent.id);
    expect(gone.slug).toBe('child');
  });

  it('multi-select restores several at once', async () => {
    const a = await put('tasks', { title: 'One', sortKey: k(1) });
    const b = await put('tasks', { title: 'Two', sortKey: k(2) });
    await remove('tasks', a.id);
    await remove('tasks', b.id);
    renderSection();
    await screen.findByText('One');
    fireEvent.click(screen.getByLabelText('Select One'));
    fireEvent.click(screen.getByLabelText('Select Two'));
    fireEvent.click(screen.getByText(/Restore selected/));
    await waitFor(async () => expect(await live('tasks', b.id)).toBeTruthy());
    expect(await live('tasks', a.id)).toBeTruthy();
  });
});

describe('deletedAtOf', () => {
  it('uses the deleted clock, else updatedAt', async () => {
    const t = await put('tasks', { title: 'x', sortKey: k(1) });
    await remove('tasks', t.id);
    await patch('tasks', t.id, { title: 'y' });
    const rec = (await loadDeleted(reader)).find((r) => r.id === t.id)!;
    const raw = (await getLocal().list('tasks', { includeDeleted: true })).find(
      (r) => r.id === t.id,
    )!;
    expect(rec.deletedAt).toBe(Date.parse(raw.clocks.deleted!.slice(0, 24)));
    expect(deletedAtOf({ ...raw, clocks: {} })).toBe(Date.parse(raw.updatedAt));
  });
});
