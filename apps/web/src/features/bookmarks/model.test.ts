import { compareBySortKey, sortKeyBetween } from '@webfront/shared';
import { describe, expect, it } from 'vitest';
import {
  buildBookmarklet,
  buildSections,
  displayOrder,
  filterSections,
  normaliseUrl,
  parseCaptureParams,
  rankBookmarks,
  sortKeyForAppend,
  sortKeyForMove,
  sortKeyForStep,
  type Bookmark,
  type Category,
} from './model';

let n = 0;
function cat(name: string, sortKey: string, parentId: string | null = null): Category {
  return { id: `c-${name}`, name, sortKey, parentId, colour: 'blue' } as unknown as Category;
}
function bm(title: string, over: Partial<Bookmark> = {}): Bookmark {
  n++;
  return {
    id: `b-${title}`,
    title,
    url: `https://${title.toLowerCase().replace(/\W/g, '')}.example.com/`,
    categoryId: null,
    tags: [],
    username: null,
    hint: null,
    notes: '',
    sortKey: `a${String(n).padStart(3, '0')}`,
    isService: false,
    serviceCheck: null,
    ...over,
  } as unknown as Bookmark;
}

describe('buildSections', () => {
  it('nests one level, orders by sortKey and puts orphans in Uncategorised last', () => {
    const cats = [
      cat('Dev', 'a1'),
      cat('Media', 'a0'),
      cat('Tools', 'a2', 'c-Dev'),
      cat('Deep', 'a3', 'c-Tools'),
    ];
    const items = [
      bm('GitHub', { categoryId: 'c-Dev', sortKey: 'a1' }),
      bm('Docs', { categoryId: 'c-Tools', sortKey: 'a0' }),
      bm('YouTube', { categoryId: 'c-Media' }),
      bm('Lost', { categoryId: 'c-gone' }),
      bm('Loose'),
    ];
    const sections = buildSections(cats, items);
    expect(sections.map((s) => s.category?.name ?? 'none')).toEqual([
      'Media',
      'Dev',
      'Deep',
      'none',
    ]);
    const dev = sections.find((s) => s.category?.name === 'Dev')!;
    expect(dev.children.map((c) => c.category?.name)).toEqual(['Tools']);
    expect(displayOrder(sections).map((b) => b.title)).toEqual([
      'YouTube',
      'GitHub',
      'Docs',
      'Lost',
      'Loose',
    ]);
  });

  it('omits an empty Uncategorised bucket', () => {
    expect(buildSections([cat('A', 'a0')], [])).toHaveLength(1);
  });
});

describe('rankBookmarks', () => {
  const cats = [cat('Homelab', 'a0'), cat('Reading', 'a1')];
  const items = [
    bm('Proxmox', {
      categoryId: 'c-Homelab',
      tags: ['virtualisation'],
      notes: 'runs the lxc containers',
    }),
    bm('Grafana', { categoryId: 'c-Homelab', tags: ['metrics'], username: 'admin' }),
    bm('Hacker News', { categoryId: 'c-Reading', tags: ['news'] }),
    bm('Newsboat docs', { categoryId: 'c-Reading' }),
  ];
  const titles = (q: string) => rankBookmarks(items, cats, q).map((r) => r.bookmark.title);

  it('matches across title, tags, category, url and notes', () => {
    expect(titles('lxc')).toEqual(['Proxmox']); // notes
    expect(titles('metrics')).toEqual(['Grafana']); // tag
    expect(titles('homelab')).toEqual(['Proxmox', 'Grafana']); // category
    expect(titles('grafana.example')).toEqual(['Grafana']); // url
  });

  it('ranks title prefix above tag above notes, and needs every token', () => {
    expect(titles('news')).toEqual(['Newsboat docs', 'Hacker News']);
    expect(titles('hacker reading')).toEqual(['Hacker News']);
    expect(titles('hacker homelab')).toEqual([]);
    expect(titles('')).toHaveLength(4);
    expect(titles('zzz')).toEqual([]);
  });

  it('filterSections hides empty sections', () => {
    const sections = buildSections(cats, items);
    const keep = new Set(rankBookmarks(items, cats, 'metrics').map((r) => r.bookmark.id));
    const out = filterSections(sections, keep);
    expect(out.map((s) => s.category?.name)).toEqual(['Homelab']);
    expect(out[0]!.bookmarks.map((b) => b.title)).toEqual(['Grafana']);
  });
});

describe('reorder sort keys', () => {
  const mk = (keys: string[]) => keys.map((k) => ({ id: k, sortKey: k }));

  it('places an item between neighbours, excluding itself', () => {
    const list = mk(['a0', 'a1', 'a2', 'a3']);
    const k = sortKeyForMove(list, 'a0', 2); // after a2 in the list without a0: [a1,a2,a3] -> index 2 = before a3
    const result = [...list.filter((x) => x.id !== 'a0'), { id: 'a0', sortKey: k }].sort(
      compareBySortKey,
    );
    expect(result.map((x) => x.id)).toEqual(['a1', 'a2', 'a0', 'a3']);
  });

  it('moves to the start and to the end', () => {
    const list = mk(['a0', 'a1', 'a2']);
    const first = sortKeyForMove(list, 'a2', 0);
    expect(first < 'a0').toBe(true);
    const last = sortKeyForMove(list, 'a0', 99);
    expect(last > 'a2').toBe(true);
  });

  it('moves into another (possibly empty) category', () => {
    expect(sortKeyForMove([], 'x', 0)).toBeTruthy();
    const key = sortKeyForAppend(mk(['a0', 'a5']));
    expect(key > 'a5').toBe(true);
    expect(sortKeyForAppend([])).toBeTruthy();
  });

  it('steps up and down by one, stopping at the edges', () => {
    const list = mk(['a0', 'a1', 'a2']);
    expect(sortKeyForStep(list, 'a0', -1)).toBeNull();
    expect(sortKeyForStep(list, 'a2', 1)).toBeNull();
    const down = sortKeyForStep(list, 'a0', 1)!;
    expect(down > 'a1' && down < 'a2').toBe(true);
    const up = sortKeyForStep(list, 'a2', -1)!;
    expect(up > 'a0' && up < 'a1').toBe(true);
  });

  it('copes with equal neighbouring keys from concurrent inserts', () => {
    const list = [
      { id: 'x', sortKey: 'a1' },
      { id: 'y', sortKey: 'a1' },
    ];
    const k = sortKeyForMove(list, 'z', 1);
    expect(k).toBeTruthy();
    expect(sortKeyBetween('a1', 'a1')).toBeTruthy();
  });
});

describe('urls and bookmarklet', () => {
  it('normalises typed addresses and rejects unsafe schemes', () => {
    expect(normaliseUrl('example.com/a')).toBe('https://example.com/a');
    expect(normaliseUrl(' http://nas.lan:8080 ')).toBe('http://nas.lan:8080/');
    expect(normaliseUrl('javascript:alert(1)')).toBeNull();
    expect(normaliseUrl('two words')).toBeNull();
    expect(normaliseUrl('')).toBeNull();
  });

  it('parses capture params safely', () => {
    expect(parseCaptureParams('?url=https%3A%2F%2Fa.test%2Fx&title=Hello')).toEqual({
      url: 'https://a.test/x',
      title: 'Hello',
    });
    expect(parseCaptureParams('?url=javascript%3Aalert(1)').url).toBe('');
  });

  it('builds a javascript: bookmarklet bound to the origin', () => {
    const b = buildBookmarklet('https://webfront.tail.ts.net');
    expect(b.startsWith('javascript:')).toBe(true);
    expect(b).toContain('https://webfront.tail.ts.net/capture');
    expect(() => new Function(b.slice('javascript:'.length))).not.toThrow();
  });
});
