import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { patch, put, reader, remove } from '@/data';
import { getLocal } from '../../data/runtime';
import { applyImport, buildExport, exportFileName, planImport, planTotals } from './dataTransfer';

async function seed() {
  const cat = await put('bookmarkCategories', {
    name: 'Home',
    colour: 'teal',
    parentId: null,
    sortKey: 'a0',
  } as never);
  const bm = await put('bookmarks', {
    title: 'NAS',
    url: 'https://nas.lan/',
    categoryId: cat.id,
    sortKey: 'a0',
  } as never);
  const task = await put('tasks', { title: 'Buy milk', sortKey: 'a0' });
  const gone = await put('tasks', { title: 'Deleted', sortKey: 'a1' });
  await remove('tasks', gone.id);
  await put(
    'settings',
    { value: { name: 'Kagi', urlTemplate: 'https://kagi.com/search?q=%s' } },
    { id: 'search.engine' },
  );
  return { cat, bm, task, gone };
}

describe('export / import', () => {
  it('round-trips through @/data, skipping tombstones, and never wipes existing data', async () => {
    const { bm, task, gone } = await seed();
    const file = await buildExport(new Date('2026-11-14T10:00:00Z'));
    expect(file).toMatchObject({
      format: 'webfront-export',
      version: 1,
      exportedAt: '2026-11-14T10:00:00.000Z',
    });
    expect(exportFileName(new Date('2026-11-14T10:00:00Z'))).toBe(
      'webfront-export-2026-11-14.json',
    );
    expect(file.collections.calendarEvents).toBeUndefined();
    const text = JSON.stringify(file);

    // Unchanged data: nothing to do.
    const same = await planImport(text);
    expect(same.ok && planTotals(same.plan)).toMatchObject({ added: 0, updated: 0 });

    // Wipe the local store (as a fresh device would be), plus one extra record that must survive.
    await getLocal().clear();
    const extra = await put('tasks', { title: 'Keep me', sortKey: 'b0' });
    const planned = await planImport(text);
    if (!planned.ok) throw new Error(planned.error);
    const totals = planTotals(planned.plan);
    expect(totals).toMatchObject({ added: 4, updated: 0, invalid: 0 }); // category, bookmark, task, setting
    expect(planned.plan.items.some((i) => i.id === gone.id)).toBe(false);
    await applyImport(planned.plan);

    expect((await reader.get('bookmarks', bm.id))?.title).toBe('NAS');
    expect((await reader.get('tasks', task.id))?.title).toBe('Buy milk');
    expect((await reader.get('tasks', extra.id))?.title).toBe('Keep me');
    expect(await reader.get('tasks', gone.id)).toBeUndefined();
    expect((await reader.get('settings', 'search.engine'))?.value).toMatchObject({ name: 'Kagi' });
    // Imported records are queued for sync.
    expect(await getLocal().db.table('_outbox').count()).toBeGreaterThanOrEqual(4);
  });

  it('only overwrites local records that are older than the file', async () => {
    const t = await put('tasks', { title: 'Old title', sortKey: 'a0' });
    const file = await buildExport();
    await patch('tasks', t.id, { title: 'Newer local' });
    const stale = await planImport(JSON.stringify(file));
    if (!stale.ok) throw new Error('x');
    expect(stale.plan.items.some((i) => i.id === t.id)).toBe(false);
    await applyImport(stale.plan);
    expect((await reader.get('tasks', t.id))?.title).toBe('Newer local');
  });

  it('rejects bad files and skips invalid records', async () => {
    expect(await planImport('not json')).toMatchObject({ ok: false });
    expect(await planImport('{"hello":1}')).toMatchObject({
      ok: false,
      error: expect.stringContaining('not a Webfront'),
    });
    const newer = await planImport(
      JSON.stringify({ format: 'webfront-export', version: 99, exportedAt: 'x', collections: {} }),
    );
    expect(newer).toMatchObject({ ok: false, error: expect.stringContaining('newer') });
    const mixed = await planImport(
      JSON.stringify({
        format: 'webfront-export',
        version: 1,
        exportedAt: '2026-01-01T00:00:00Z',
        collections: { tasks: [{ id: 'nope', title: 5 }], calendarEvents: [{}], mystery: [] },
      }),
    );
    if (!mixed.ok) throw new Error('x');
    expect(planTotals(mixed.plan).invalid).toBe(1);
    expect(mixed.plan.ignoredCollections.sort()).toEqual(['calendarEvents', 'mystery']);
    expect(mixed.plan.items).toEqual([]);
  });

  it('treats the file as hostile: skips bookmarks whose URL is not http(s)', async () => {
    const good = await put('bookmarks', {
      title: 'Good',
      url: 'https://good.example/',
      sortKey: 'a0',
    } as never);
    const file = await buildExport();
    const rows = file.collections.bookmarks as Array<Record<string, unknown>>;
    const base = rows.find((r) => r.id === good.id)!;
    await getLocal().clear();
    const evil = (n: number, url: string, extra: Record<string, unknown> = {}) => ({
      ...base,
      id: `0190f0f0-0000-7000-8000-00000000000${n}`,
      title: `evil ${n}`,
      url,
      ...extra,
    });
    file.collections.bookmarks = [
      base,
      evil(1, 'javascript:alert(document.cookie)'),
      evil(2, 'data:text/html,<script>alert(1)</script>'),
      evil(3, 'https://ok.example/', {
        isService: true,
        serviceCheck: {
          type: 'http',
          url: 'file:///etc/passwd',
          method: 'GET',
          expectedStatus: null,
          allowInsecureTls: true,
          timeoutMs: 5000,
        },
      }),
    ];
    const plan = await planImport(JSON.stringify(file));
    if (!plan.ok) throw new Error(plan.error);
    const bookmarks = plan.plan.items.filter((i) => i.collection === 'bookmarks');
    expect(bookmarks.map((i) => i.id)).toEqual([good.id]);
    expect(plan.plan.summary.find((x) => x.collection === 'bookmarks')?.invalid).toBe(3);
  });
});
