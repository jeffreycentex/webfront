import { describe, expect, it } from 'vitest';
import {
  buildHistory,
  bumpQuantity,
  findDuplicate,
  groupBySection,
  parseQuantity,
  suggest,
  type ItemLike,
} from './logic';

describe('parseQuantity', () => {
  it.each([
    ['2 milk', 'milk', '2'],
    ['2x milk', 'milk', '2'],
    ['2 x milk', 'milk', '2'],
    ['milk x2', 'milk', '2'],
    ['milk x 2', 'milk', '2'],
    ['milk 2x', 'milk', '2'],
    ['500g flour', 'flour', '500g'],
    ['500 g flour', 'flour', '500g'],
    ['1,5 kg rice', 'rice', '1.5kg'],
    ['flour 500g', 'flour', '500g'],
    ['2 packs of pasta', 'pasta', '2 packs'],
    ['3 large eggs', 'large eggs', '3'],
  ])('%s', (input, name, quantity) => {
    expect(parseQuantity(input)).toEqual({ name, quantity });
  });

  it('leaves plain and ambiguous input alone', () => {
    expect(parseQuantity('milk')).toEqual({ name: 'milk', quantity: null });
    expect(parseQuantity('7up')).toEqual({ name: '7up', quantity: null });
    expect(parseQuantity('2% milk')).toEqual({ name: '2% milk', quantity: null });
    expect(parseQuantity('5')).toEqual({ name: '5', quantity: null });
    expect(parseQuantity('  ')).toEqual({ name: '', quantity: null });
  });
});

describe('bumpQuantity', () => {
  it('adds counts, treating no quantity as one', () => {
    expect(bumpQuantity(null, null)).toBe('2');
    expect(bumpQuantity('2', null)).toBe('3');
    expect(bumpQuantity('2', '3')).toBe('5');
  });
  it('adds matching units and refuses mismatches', () => {
    expect(bumpQuantity('500g', '500g')).toBe('1000g');
    expect(bumpQuantity('500g', '2')).toBeNull();
    expect(bumpQuantity('a few', '2')).toBeNull();
  });
});

function item(over: Partial<ItemLike> & { id: string; name: string }): ItemLike {
  return { checked: false, quantity: null, section: null, sortKey: 'a0', ...over };
}

describe('findDuplicate', () => {
  it('matches ignoring case and spacing, preferring unchecked', () => {
    const items = [
      item({ id: '1', name: 'Milk', checked: true }),
      item({ id: '2', name: ' milk ' }),
    ];
    expect(findDuplicate(items, 'MILK')?.id).toBe('2');
    expect(findDuplicate([items[0]!], 'milk')?.id).toBe('1');
    expect(findDuplicate(items, 'bread')).toBeUndefined();
  });
});

describe('history and suggestions', () => {
  const day = 86_400_000;
  const now = Date.parse('2026-06-01T00:00:00Z');
  const at = (d: number) => new Date(now - d * day).toISOString();
  const history = buildHistory([
    { name: 'Milk', updatedAt: at(60), section: 'Dairy' },
    { name: 'milk', updatedAt: at(30), section: null },
    { name: 'Milk', updatedAt: at(10), section: 'Dairy' },
    { name: 'Milkshake mix', updatedAt: at(1), section: 'Pantry' },
    { name: 'Almond milk', updatedAt: at(2), section: 'Drinks' },
    { name: 'Bread', updatedAt: at(3), section: 'Bakery' },
  ]);

  it('merges names case-insensitively and remembers the section', () => {
    const milk = history.find((h) => h.key === 'milk')!;
    expect(milk.count).toBe(3);
    expect(milk.section).toBe('Dairy');
    expect(milk.name).toBe('Milk');
  });

  it('ranks prefix matches first, then by frequency and recency', () => {
    const names = suggest(history, 'mi', 6, now).map((h) => h.name);
    expect(names).toEqual(['Milk', 'Milkshake mix', 'Almond milk']);
  });

  it('matches word starts and substrings after prefixes', () => {
    expect(suggest(history, 'mil', 6, now).map((h) => h.name)[2]).toBe('Almond milk');
    expect(suggest(history, 'zzz', 6, now)).toEqual([]);
  });

  it('empty query gives favourites', () => {
    expect(suggest(history, '', 1, now)[0]?.name).toBe('Milk');
  });

  it('recency can beat a small frequency lead', () => {
    const h = buildHistory([
      { name: 'Old', updatedAt: at(400), section: null },
      { name: 'Old', updatedAt: at(401), section: null },
      { name: 'New', updatedAt: at(0), section: null },
    ]);
    expect(suggest(h, '', 2, now).map((x) => x.name)).toEqual(['New', 'Old']);
  });
});

describe('groupBySection', () => {
  const sections = ['Produce', 'Dairy', 'Other'];
  it('orders by section, then sortKey, and drops empty sections', () => {
    const groups = groupBySection(
      [
        item({ id: '1', name: 'Milk', section: 'Dairy', sortKey: 'a1' }),
        item({ id: '2', name: 'Apple', section: 'Produce', sortKey: 'a2' }),
        item({ id: '3', name: 'Cheese', section: 'Dairy', sortKey: 'a0' }),
      ],
      sections,
    );
    expect(groups.map((g) => [g.section, g.items.map((i) => i.name)])).toEqual([
      ['Produce', ['Apple']],
      ['Dairy', ['Cheese', 'Milk']],
    ]);
  });

  it('puts unsectioned and unknown-section items under Other', () => {
    const groups = groupBySection(
      [
        item({ id: '1', name: 'A', section: null, sortKey: 'a0' }),
        item({ id: '2', name: 'B', section: 'Gone', sortKey: 'a1' }),
        item({ id: '3', name: 'C', section: 'Produce', sortKey: 'a2' }),
      ],
      sections,
    );
    expect(groups.map((g) => g.section)).toEqual(['Produce', 'Other']);
    expect(groups[1]!.items.map((i) => i.name)).toEqual(['A', 'B']);
  });

  it('appends Other at the end when the list has no Other section', () => {
    const groups = groupBySection([item({ id: '1', name: 'A' })], ['Produce']);
    expect(groups.map((g) => g.section)).toEqual(['Other']);
  });
});
