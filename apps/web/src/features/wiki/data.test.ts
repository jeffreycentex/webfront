import 'fake-indexeddb/auto';
import { compareBySortKey } from '@webfront/shared';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearLocalData, patch, reader } from '@/data';
import { buildTree, flattenTree } from './lib/tree';
import { projectDrop } from './components/PageTree';
import {
  createPage,
  deletePage,
  findBySlug,
  listRevisions,
  nudgePage,
  renamePage,
  snapshotPage,
  type WikiPage,
} from './data';
import { _resetSearchIndex, search, searchWiki, snippet } from './search';

/** Page operations, revisions and search over the real local data layer (fake IndexedDB). */

beforeEach(async () => {
  await clearLocalData();
  _resetSearchIndex();
});
afterAll(() => {
  vi.useRealTimers();
});

const all = () => reader.list('wikiPages');

describe('pages', () => {
  it('creates pages with unique slugs and sibling order', async () => {
    const a = await createPage({ title: 'Home' });
    const b = await createPage({ title: 'home' });
    const c = await createPage({ title: 'Child', parentId: a.id, colour: 'red' });
    expect([a.slug, b.slug]).toEqual(['home', 'home-2']);
    expect(c.colour).toBeNull(); // only sections carry a colour
    expect(b.sortKey > a.sortKey).toBe(true);
  });

  it('renames with a new slug, keeps the old one as a redirect and updates links', async () => {
    const target = await createPage({ title: 'Garden' });
    const linker = await createPage({
      title: 'Plans',
      body: 'See [[Garden]] and [[garden|the plot]].',
    });
    await renamePage(target.id, 'Allotment', true);
    const pages = await all();
    const renamed = pages.find((p) => p.id === target.id)!;
    expect(renamed).toMatchObject({ title: 'Allotment', slug: 'allotment', oldSlugs: ['garden'] });
    expect(findBySlug(pages, 'garden').redirect?.id).toBe(target.id);
    expect(pages.find((p) => p.id === linker.id)!.body).toBe(
      'See [[Allotment]] and [[Allotment|the plot]].',
    );
  });

  it('deletes with children moved up, and undo restores everything', async () => {
    const root = await createPage({ title: 'Root' });
    const mid = await createPage({ title: 'Mid', parentId: root.id });
    const kid1 = await createPage({ title: 'Kid 1', parentId: mid.id });
    const kid2 = await createPage({ title: 'Kid 2', parentId: mid.id });
    const res = await deletePage(mid.id, 'reparent');
    let pages = await all();
    expect(pages.map((p) => p.id)).not.toContain(mid.id);
    expect(
      pages
        .filter((p) => p.parentId === root.id)
        .sort(compareBySortKey)
        .map((p) => p.id),
    ).toEqual([kid1.id, kid2.id]);
    await res.undo();
    pages = await all();
    expect(pages.find((p) => p.id === kid1.id)?.parentId).toBe(mid.id);
    expect(pages.map((p) => p.id)).toContain(mid.id);

    const res2 = await deletePage(mid.id, 'all');
    expect(res2.count).toBe(3);
    expect((await all()).map((p) => p.id)).toEqual([root.id]);
  });

  it('moves pages with the keyboard alternative', async () => {
    const a = await createPage({ title: 'A' });
    const b = await createPage({ title: 'B' });
    await nudgePage(b.id, 'up');
    let order = (await all()).sort(compareBySortKey).map((p) => p.title);
    expect(order).toEqual(['B', 'A']);
    await nudgePage(a.id, 'indent'); // A becomes a child of B
    expect((await reader.get('wikiPages', a.id))?.parentId).toBe(b.id);
    await nudgePage(a.id, 'outdent');
    const pages = await all();
    expect(pages.find((p) => p.id === a.id)?.parentId).toBeNull();
    order = pages.sort(compareBySortKey).map((p) => p.title);
    expect(order).toEqual(['B', 'A']);
  });
});

describe('drag projection', () => {
  const page = (id: string, parentId: string | null, sortKey: string) =>
    ({ id, title: id, parentId, sortKey, colour: null }) as unknown as WikiPage;
  const pages = [
    page('a', null, 'a0'),
    page('a1', 'a', 'a0'),
    page('b', null, 'a1'),
    page('c', null, 'a2'),
  ];
  const items = flattenTree(buildTree(pages));

  it('drops between siblings at the same depth', () => {
    const p = projectDrop(items, 'c', 'b', 0)!;
    expect(p.parentId).toBeNull();
    expect(p.sortKey < 'a1' && p.sortKey > 'a0').toBe(true);
  });

  it('indents under the previous row with a rightward drag', () => {
    const p = projectDrop(items, 'c', 'c', 24)!;
    expect(p).toMatchObject({ depth: 1, parentId: 'b' });
  });

  it('cannot indent deeper than one level below the previous row', () => {
    const p = projectDrop(items, 'b', 'b', 200)!;
    expect(p.depth).toBe(2);
    expect(p.parentId).toBe('a1');
  });
});

describe('revisions', () => {
  it('snapshots meaningful saves at most every few minutes, forced on leave', async () => {
    // Only the snapshot policy's clock is faked; records keep the data layer's real clock.
    vi.useFakeTimers({ toFake: ['Date'] });
    const p = await createPage({ title: 'Notes', body: 'v1' });
    expect(await snapshotPage(p.id, 'edit')).not.toBeNull();
    await patch('wikiPages', p.id, { body: 'v2' });
    expect(await snapshotPage(p.id, 'edit')).toBeNull(); // throttled
    expect(await snapshotPage(p.id, 'leave')).not.toBeNull();
    expect(await snapshotPage(p.id, 'leave')).toBeNull(); // unchanged since the last one
    await patch('wikiPages', p.id, { body: 'v3' });
    vi.setSystemTime(Date.now() + 6 * 60_000);
    expect(await snapshotPage(p.id, 'edit')).not.toBeNull();
    expect((await listRevisions(p.id)).map((r) => r.body)).toEqual(['v3', 'v2', 'v1']);
    vi.useRealTimers();
  });

  it('prunes old revisions and empties their bodies', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const p = await createPage({ title: 'Busy' });
    const start = Date.parse('2026-01-01T00:00:00Z');
    for (let i = 0; i < 40; i++) {
      vi.setSystemTime(new Date(start + i * 86_400_000 * 3));
      await patch('wikiPages', p.id, { body: `version ${i}` });
      await snapshotPage(p.id, 'leave');
    }
    const live = await listRevisions(p.id);
    expect(live.length).toBeLessThan(40);
    expect(live[0]?.body).toBe('version 39');
    const pruned = (await reader.list('wikiRevisions', { includeDeleted: true })).filter(
      (r) => r.deleted,
    );
    expect(pruned.length).toBe(40 - live.length);
    for (const r of pruned) expect(r.body).toBe('');
    vi.useRealTimers();
  });
});

describe('search', () => {
  it('finds titles before bodies, with a snippet, and updates incrementally', async () => {
    const a = await createPage({
      title: 'Sourdough starter',
      body: 'Feed it flour and water daily.',
    });
    await createPage({ title: 'Bread notes', body: 'My sourdough loaf needs a longer proof.' });
    let hits = await searchWiki('sourdough');
    expect(hits.map((h) => h.page.title)).toEqual(['Sourdough starter', 'Bread notes']);
    expect(hits[1]!.snippet).toContain('sourdough loaf');

    await patch('wikiPages', a.id, { body: 'Now with rye and kombucha.' });
    await new Promise((r) => setTimeout(r, 1100)); // index refresh interval
    hits = await searchWiki('kombucha');
    expect(hits.map((h) => h.page.id)).toEqual([a.id]);

    const results = await search('kombucha', 5);
    expect(results[0]).toMatchObject({
      title: 'Sourdough starter',
      href: '/wiki/sourdough-starter',
    });
    expect(results[0]!.score).toBeGreaterThan(0);
    expect(results[0]!.score).toBeLessThanOrEqual(1);
    expect(await search('', 5)).toEqual([]);
  });

  it('builds readable snippets', () => {
    expect(snippet('# Title\n\nSome **bold** text about cats and dogs.', 'cats')).toContain(
      'text about cats',
    );
    expect(snippet('', 'x')).toBe('');
  });
});
