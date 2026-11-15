// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearLocalData, patch, reader } from '@/data';
import { ToastProvider } from '@/ui';
import {
  deriveStaples,
  groupStaples,
  missingStaples,
  planAddStaples,
  stapleState,
  type StapleRecord,
} from './logic';
import { ShoppingPage } from './ShoppingPage';
import { addItem, addStapleByName, addStaples, clearChecked, createList, setStaple } from './store';

let n = 0;
function rec(name: string, over: Partial<StapleRecord> = {}): StapleRecord {
  n += 1;
  return {
    id: `r${n}`,
    name,
    checked: false,
    quantity: null,
    section: null,
    sortKey: String(n).padStart(4, '0'),
    note: '',
    staple: false,
    deleted: false,
    updatedAt: new Date(1_700_000_000_000 + n * 1000).toISOString(),
    ...over,
  };
}

describe('staples logic', () => {
  it('derives one staple per name, keeping soft-deleted records, newest wins', () => {
    const old = rec('Milk', { staple: true, deleted: true, quantity: '1' });
    const again = rec('milk ', { staple: true, quantity: '2' });
    const other = rec('Eggs', { staple: false });
    const s = deriveStaples([old, again, other, rec('Butter', { staple: true, deleted: true })]);
    expect(s.map((x) => x.key)).toEqual(['butter', 'milk']);
    expect(s.find((x) => x.key === 'milk')).toMatchObject({ recordId: again.id, quantity: '2' });
  });

  it('plans add-all-missing against the duplicate rules', () => {
    const staples = deriveStaples([
      rec('Milk', { staple: true, deleted: true }),
      rec('Eggs', { staple: true, deleted: true }),
      rec('Tea', { staple: true, deleted: true }),
      rec('Jam', { staple: true, deleted: true }),
    ]);
    const live = [
      rec('milk'),
      rec('Eggs', { checked: true }),
      rec('Jam', { checked: true }),
      rec('Jam'),
    ];
    const plan = planAddStaples(staples, live);
    expect(plan.map((p) => [p.staple.key, p.kind])).toEqual([
      ['eggs', 'uncheck'],
      ['tea', 'add'],
    ]);
    expect(stapleState(staples[0]!, live)).toBe('in-trolley');
    expect(missingStaples(staples, live).map((s) => s.key)).toEqual(['tea']);
  });

  it('groups by section in list order, alphabetical inside', () => {
    const staples = deriveStaples([
      rec('Yoghurt', { staple: true, section: 'Dairy' }),
      rec('Apples', { staple: true, section: 'Produce' }),
      rec('Butter', { staple: true, section: 'Dairy' }),
      rec('Salt', { staple: true }),
    ]);
    const g = groupStaples(staples, ['Produce', 'Dairy', 'Other']);
    expect(g.map((x) => [x.section, x.items.map((i) => i.name)])).toEqual([
      ['Produce', ['Apples']],
      ['Dairy', ['Butter', 'Yoghurt']],
      ['Other', ['Salt']],
    ]);
  });
});

beforeEach(async () => {
  localStorage.clear();
  await clearLocalData();
});
afterEach(cleanup);

const all = (listId: string) =>
  reader.list('shoppingItems', { where: { listId }, includeDeleted: true });
const live = (listId: string) => reader.list('shoppingItems', { where: { listId } });

describe('staples store', () => {
  it('survives clear checked and is restored by addStaples', async () => {
    const list = await createList('Groceries');
    const a = await addItem(list.id, '2 milk');
    if (a.kind !== 'added') throw new Error('expected add');
    await patch('shoppingItems', a.item.id, { section: 'Dairy', checked: true });
    await setStaple(a.item, true);
    await clearChecked(list.id);
    expect(await live(list.id)).toHaveLength(0);

    const staples = deriveStaples(await all(list.id));
    expect(staples).toHaveLength(1);
    expect(staples[0]).toMatchObject({ name: 'Milk', quantity: '2', section: 'Dairy' });

    await addStaples(list.id, staples);
    const now = await live(list.id);
    expect(now).toHaveLength(1);
    expect(now[0]).toMatchObject({ id: a.item.id, checked: false, quantity: '2', staple: true });
    // already on the list unchecked: left alone
    expect(await addStaples(list.id, staples)).toBe(0);
  });

  it('unflagging clears every record of that name, cleared copies included', async () => {
    const list = await createList('Groceries');
    const a = await addItem(list.id, 'tea');
    if (a.kind !== 'added') throw new Error();
    await setStaple(a.item, true);
    await clearChecked(list.id);
    const { remove } = await import('@/data');
    await remove('shoppingItems', a.item.id);
    const b = await addItem(list.id, 'Tea');
    if (b.kind !== 'added') throw new Error();
    await setStaple(b.item, true);
    await setStaple(b.item, false);
    expect(deriveStaples(await all(list.id))).toEqual([]);
  });

  it('addStapleByName makes a hidden staple without touching the list', async () => {
    const list = await createList('Groceries');
    await addStapleByName(list.id, { name: 'Flour', section: 'Pantry' });
    expect(await live(list.id)).toHaveLength(0);
    expect(deriveStaples(await all(list.id)).map((s) => s.name)).toEqual(['Flour']);
  });

  it('sync shape: flagging writes only the item staple field, never the list', async () => {
    const list = await createList('Groceries');
    const a = await addItem(list.id, 'milk');
    const b = await addItem(list.id, 'eggs');
    if (a.kind !== 'added' || b.kind !== 'added') throw new Error();
    const listBefore = await reader.get('shoppingLists', list.id);
    const before = await reader.get('shoppingItems', a.item.id);
    await setStaple(a.item, true);
    const after = await reader.get('shoppingItems', a.item.id);
    const clocks = (r: unknown) => (r as { clocks: Record<string, string> }).clocks;
    const changed = Object.keys(clocks(after)).filter(
      (k) => clocks(after)[k] !== clocks(before)[k],
    );
    expect(changed).toEqual(['staple']);
    expect(await reader.get('shoppingLists', list.id)).toEqual(listBefore);
    // different items flagged "on two devices" both survive (separate records)
    await setStaple(b.item, true);
    expect(deriveStaples(await all(list.id))).toHaveLength(2);
  });
});

describe('Staples UI', () => {
  it('marks a staple, clears checked items, then restores them from the sheet', async () => {
    const user = userEvent.setup();
    const list = await createList('Groceries');
    await addItem(list.id, 'milk');
    await addItem(list.id, 'bread');
    render(
      <MemoryRouter initialEntries={['/shopping']}>
        <ToastProvider>
          <ShoppingPage />
        </ToastProvider>
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Add Milk to staples' }));
    await screen.findByRole('button', { name: 'Remove Milk from staples' });

    await user.click(await screen.findByRole('checkbox', { name: /Milk/ }));
    await user.click(await screen.findByRole('checkbox', { name: /Bread/ }));
    await user.click(await screen.findByRole('button', { name: 'Clear checked' }));
    await waitFor(() => expect(screen.queryByRole('checkbox')).toBeNull());

    await user.click(screen.getByRole('button', { name: /Staples/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Staples' });
    // The sheet's rows come from a live query, so wait for them rather than reading at once.
    expect(await within(dialog).findByText('Not on the list')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /Add all missing \(1\)/ }));
    await waitFor(async () => expect(await live(list.id)).toHaveLength(1));
    await within(dialog).findByText('On the list');
    expect((await live(list.id))[0]!.name).toBe('Milk');
  });
});
