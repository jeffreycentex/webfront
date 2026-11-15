// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { put, reader } from '@/data';
import { applyImport, undoImport } from './apply';
import { parseBookmarksHtml } from './parseNetscape';
import { DEFAULT_OPTIONS, buildSelection, existingUrlKeys, groupKeys } from './plan';

const HTML = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<H1>Bookmarks</H1>
<DL><p>
  <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
  <DL><p>
    <DT><A HREF="https://loose.example.com/">Loose</A>
    <DT><H3>Dev</H3>
    <DL><p>
      <DT><A HREF="https://github.com/">GitHub</A>
      <DT><A HREF="https://GitHub.com/#readme">GitHub again</A>
      <DT><H3>Tools</H3>
      <DL><p>
        <DT><A HREF="https://tool.example.com/">Tool</A>
      </DL><p>
    </DL><p>
    <DT><H3>Media</H3>
    <DL><p>
      <DT><A HREF="https://media.example.com/">Media</A>
    </DL><p>
  </DL><p>
</DL><p>`;

async function live() {
  return {
    categories: await reader.list('bookmarkCategories'),
    bookmarks: await reader.list('bookmarks'),
  };
}
function parsed() {
  const r = parseBookmarksHtml(HTML);
  if (!r.ok) throw new Error(r.error);
  return r.parsed;
}

let n = 0;
beforeEach(async () => {
  // Each test starts with a clean slate by tombstoning leftovers.
  const { categories, bookmarks } = await live();
  const { remove } = await import('@/data');
  for (const b of bookmarks) await remove('bookmarks', b.id);
  for (const c of categories) await remove('bookmarkCategories', c.id);
  n++;
});

describe('import through @/data', () => {
  it('creates categories, sub-categories and ordered bookmarks, then Undo removes exactly those', async () => {
    const keep = await put('bookmarks', {
      url: 'https://keep.example.com/',
      title: 'Keep',
      categoryId: null,
      sortKey: 'a0',
    });
    const before = await live();
    const sel = buildSelection(
      parsed(),
      new Set(),
      DEFAULT_OPTIONS,
      existingUrlKeys(before.bookmarks),
    );
    // In-file duplicate (fragment + case) is skipped by default.
    expect(sel.totals).toMatchObject({
      categories: 3,
      subcategories: 1,
      links: 4,
      duplicatesInFile: 1,
    });

    const progress: number[] = [];
    const res = await applyImport({
      selection: sel,
      merge: true,
      ...before,
      batchSize: 2,
      onProgress: (p) => progress.push(p.done),
    });
    expect(res.links).toBe(4);
    expect(progress.at(-1)).toBe(progress.length > 0 ? 8 : 0); // 4 categories + 4 links
    const after = await live();
    const dev = after.categories.find((c) => c.name === 'Dev')!;
    const tools = after.categories.find((c) => c.name === 'Tools')!;
    expect(tools.parentId).toBe(dev.id);
    const names = after.categories
      .filter((c) => !c.parentId)
      .sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1))
      .map((c) => c.name);
    expect(names).toEqual(['Dev', 'Media', 'Imported']);
    const colours = after.categories.filter((c) => !c.parentId).map((c) => c.colour);
    expect(new Set(colours).size).toBe(colours.length);
    expect(tools.colour).toBe(dev.colour);
    expect(after.bookmarks.find((b) => b.title === 'GitHub')!.categoryId).toBe(dev.id);
    expect(after.bookmarks.find((b) => b.title === 'Tool')!.categoryId).toBe(tools.id);

    await undoImport(res, 2);
    const undone = await live();
    expect(undone.categories).toHaveLength(0);
    expect(undone.bookmarks.map((b) => b.id)).toEqual([keep.id]);
  });

  it('merges into an existing category with the same name and skips URLs already saved', async () => {
    const dev = await put('bookmarkCategories', {
      name: 'dev',
      colour: 'red',
      parentId: null,
      sortKey: 'a0',
    });
    const existingMark = await put('bookmarks', {
      url: 'https://github.com',
      title: 'Already',
      categoryId: dev.id,
      sortKey: 'a5',
    });
    const before = await live();
    const sel = buildSelection(
      parsed(),
      new Set(),
      DEFAULT_OPTIONS,
      existingUrlKeys(before.bookmarks),
    );
    expect(sel.totals.duplicatesExisting).toBe(2); // GitHub and "GitHub again"
    const res = await applyImport({ selection: sel, merge: true, ...before });
    expect(res.mergedCategories).toBe(1);
    expect(res.categoryIds).toHaveLength(3); // Tools (under existing Dev), Media, Imported
    const after = await live();
    expect(after.categories.filter((c) => c.name.toLowerCase() === 'dev')).toHaveLength(1);
    const tools = after.categories.find((c) => c.name === 'Tools')!;
    expect(tools.parentId).toBe(dev.id);
    expect(after.bookmarks.filter((b) => b.url.includes('github'))).toHaveLength(1);
    // Appended after existing links in the merged category, never before.
    const media = after.bookmarks.find((b) => b.title === 'Media')!;
    expect(media.categoryId).not.toBe(dev.id);
    // Undo leaves the merged category and the existing bookmark alone.
    await undoImport(res);
    const undone = await live();
    expect(undone.categories.map((c) => c.id)).toEqual([dev.id]);
    expect(undone.bookmarks.map((b) => b.id)).toEqual([existingMark.id]);
  });

  it('creates a new category when merge is off, imports duplicates when asked, honours excluded folders', async () => {
    await put('bookmarkCategories', { name: 'Dev', colour: 'red', parentId: null, sortKey: 'a0' });
    const before = await live();
    const p = parsed();
    const media = p.categories.find((c) => c.name === 'Media')!;
    const off = new Set(groupKeys(media));
    const sel = buildSelection(p, off, { duplicates: 'import', merge: false }, existingUrlKeys([]));
    expect(sel.categories.map((c) => c.folder.name)).toEqual(['Dev', 'Imported']);
    expect(sel.totals.links).toBe(4); // GitHub twice kept, Tool, Loose; Media excluded
    const res = await applyImport({ selection: sel, merge: false, ...before });
    const after = await live();
    expect(after.categories.filter((c) => c.name === 'Dev')).toHaveLength(2);
    expect(after.bookmarks.some((b) => b.title === 'Media')).toBe(false);
    expect(res.links).toBe(4);
    expect(n).toBeGreaterThan(0);
  });
});
