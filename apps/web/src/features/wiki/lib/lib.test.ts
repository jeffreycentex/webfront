import { describe, expect, it } from 'vitest';
import {
  backlinkContext,
  codeRanges,
  findBacklinks,
  linksTo,
  parseWikiLinks,
  renameLinks,
} from './links';
import {
  DEFAULT_RETENTION,
  revisionsToPrune,
  shouldSnapshot,
  SNAPSHOT_INTERVAL_MS,
} from './revisions';
import { hashText, isValidSlug, slugify, titleKey, uniqueSlug } from './text';
import { ancestorsOf, buildTree, descendantIds, flattenTree, sectionColour } from './tree';

describe('slugs', () => {
  it('slugifies titles', () => {
    expect(slugify('Hello World')).toBe('hello-world');
    expect(slugify('  Crème brûlée & Co.  ')).toBe('creme-brulee-co');
    expect(slugify("Jeff's notes")).toBe('jeffs-notes');
    expect(slugify('***')).toBe('page');
    expect(slugify('日本語')).toBe('page');
    expect(slugify('a'.repeat(200)).length).toBeLessThanOrEqual(80);
    for (const t of ['Hello World', '  -x- ', 'A--B', 'x'.repeat(100) + ' y'])
      expect(isValidSlug(slugify(t))).toBe(true);
  });

  it('makes slugs unique', () => {
    const taken = new Set(['home', 'home-2', 'notes']);
    expect(uniqueSlug('Home', taken)).toBe('home-3');
    expect(uniqueSlug('Notes', taken)).toBe('notes-2');
    expect(uniqueSlug('New', taken)).toBe('new');
    expect(uniqueSlug('Home', taken, 'home')).toBe('home'); // a page keeps its own slug
  });

  it('title keys ignore case and spacing', () => {
    expect(titleKey('  My   Page ')).toBe(titleKey('my page'));
  });

  it('hashes text stably and distinguishes versions', () => {
    expect(hashText('abc')).toBe(hashText('abc'));
    expect(hashText('abc')).not.toBe(hashText('abd'));
    expect(hashText('')).not.toBe(hashText(' '));
    expect(hashText('x'.repeat(10000)).length).toBeLessThanOrEqual(64);
  });
});

describe('wiki links', () => {
  it('parses plain and labelled links', () => {
    const links = parseWikiLinks(
      'See [[Home]] and [[Recipes|the recipes]], not [[ ]] or [single].',
    );
    expect(links.map((l) => [l.target, l.label])).toEqual([
      ['Home', 'Home'],
      ['Recipes', 'the recipes'],
    ]);
    expect(links[0]).toMatchObject({ start: 4, end: 12 });
  });

  it('ignores links in code', () => {
    const text = 'Real [[A]]\n```\n[[B]]\n```\nInline `[[C]]` and [[D]]\n~~~\n[[E]]';
    expect(parseWikiLinks(text).map((l) => l.target)).toEqual(['A', 'D']);
    expect(codeRanges('no code')).toEqual([]);
  });

  it('renames links, keeping labels', () => {
    const text = 'a [[Old Page]] b [[old page|label]] c [[Other]] `[[Old Page]]`';
    const r = renameLinks(text, 'Old Page', 'New Page');
    expect(r.count).toBe(2);
    expect(r.text).toBe('a [[New Page]] b [[New Page|label]] c [[Other]] `[[Old Page]]`');
    expect(renameLinks('none', 'x', 'y')).toEqual({ text: 'none', count: 0 });
  });

  it('finds backlinks case-insensitively, excluding the page itself', () => {
    const pages = [
      { id: '1', title: 'Home', body: 'links to [[Garden]]' },
      { id: '2', title: 'Garden', body: 'self [[Garden]]' },
      { id: '3', title: 'Other', body: 'see [[garden|the garden]]' },
      { id: '4', title: 'Code', body: '`[[Garden]]`' },
    ];
    expect(findBacklinks(pages, { id: '2', title: 'Garden' }).map((p) => p.id)).toEqual(['1', '3']);
    expect(linksTo(pages[0]!.body, 'garden')).toBe(true);
    expect(backlinkContext('lots of text before the link [[Garden]] and after', 'Garden', 10)).toBe(
      '…the link [[Garden]] and after',
    );
  });
});

describe('page tree', () => {
  const p = (
    id: string,
    parentId: string | null,
    sortKey: string,
    colour: 'red' | 'blue' | null = null,
  ) => ({
    id,
    title: id,
    parentId,
    sortKey,
    colour,
  });

  it('nests, sorts and tints by section', () => {
    const pages = [
      p('b', null, 'a2', 'blue'),
      p('a', null, 'a1', 'red'),
      p('a1', 'a', 'a0'),
      p('a1x', 'a1', 'a0'),
    ];
    const tree = buildTree(pages);
    expect(tree.map((n) => n.page.id)).toEqual(['a', 'b']);
    expect(tree[0]!.children[0]!.children[0]).toMatchObject({ depth: 2, colour: 'red' });
    expect(flattenTree(tree).map((n) => n.page.id)).toEqual(['a', 'a1', 'a1x', 'b']);
    expect(flattenTree(tree, new Set(['a'])).map((n) => n.page.id)).toEqual(['a', 'b']);
    expect([...descendantIds(pages, 'a')].sort()).toEqual(['a1', 'a1x']);
    expect(ancestorsOf(pages, 'a1x').map((x) => x.id)).toEqual(['a', 'a1']);
    expect(sectionColour(pages, 'a1x')).toBe('red');
  });

  it('shows orphans and cycles at the top level', () => {
    const pages = [p('x', 'missing', 'a0'), p('c1', 'c2', 'a1'), p('c2', 'c1', 'a2')];
    const tree = buildTree(pages);
    const ids = flattenTree(tree)
      .map((n) => n.page.id)
      .sort();
    expect(ids).toEqual(['c1', 'c2', 'x']);
    expect(tree.map((n) => n.page.id)).toContain('x');
  });
});

describe('revision policy', () => {
  const now = Date.parse('2026-11-14T12:00:00Z');
  const rev = (id: string, msAgo: number, body = id) => ({
    id,
    createdAt: new Date(now - msAgo).toISOString(),
    body,
  });

  it('throttles edit snapshots, forces the others, skips duplicates', () => {
    const latest = rev('r1', 60_000, 'old');
    expect(shouldSnapshot(latest, 'new', 'edit', now)).toBe(false);
    expect(shouldSnapshot(rev('r1', SNAPSHOT_INTERVAL_MS, 'old'), 'new', 'edit', now)).toBe(true);
    expect(shouldSnapshot(latest, 'new', 'leave', now)).toBe(true);
    expect(shouldSnapshot(latest, 'new', 'merge', now)).toBe(true);
    expect(shouldSnapshot(latest, 'old', 'merge', now)).toBe(false);
    expect(shouldSnapshot(undefined, 'first text', 'edit', now)).toBe(true);
    expect(shouldSnapshot(undefined, '   ', 'edit', now)).toBe(false);
  });

  it('keeps recent revisions and thins old ones', () => {
    const H = 3_600_000;
    const D = 24 * H;
    const revs = [
      ...Array.from({ length: 30 }, (_, i) => rev(`recent${i}`, i * 60_000)),
      rev('day5a', 5 * D),
      rev('day5b', 5 * D + H),
      rev('day6', 6 * D),
      rev('m100a', 100 * D),
      rev('m100b', 101 * D),
      rev('ancient', 800 * D),
      rev('ancient2', 900 * D),
    ];
    const pruned = new Set(revisionsToPrune(revs, now));
    for (let i = 0; i < DEFAULT_RETENTION.keepRecent; i++)
      expect(pruned.has(`recent${i}`)).toBe(false);
    // recent20..29 are all within the same day bucket as recent19? They share today's bucket.
    expect(pruned.has('recent29')).toBe(true);
    expect(pruned.has('day5a')).toBe(false);
    expect(pruned.has('day5b')).toBe(true);
    expect(pruned.has('day6')).toBe(false);
    expect(pruned.has('m100a')).toBe(false);
    expect(pruned.has('ancient')).toBe(true);
    expect(pruned.has('ancient2')).toBe(false); // the oldest revision is kept as the origin
  });

  it('respects protected ids and the hard cap', () => {
    const D = 86_400_000;
    const revs = Array.from({ length: 200 }, (_, i) => rev(`r${i}`, i * D));
    const pruned = new Set(
      revisionsToPrune(revs, now, { ...DEFAULT_RETENTION, max: 40 }, new Set(['r150'])),
    );
    expect(revs.length - pruned.size).toBeLessThanOrEqual(42);
    expect(pruned.has('r150')).toBe(false);
    expect(pruned.has('r199')).toBe(false);
  });
});
