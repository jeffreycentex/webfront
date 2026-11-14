// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearLocalData, reader } from '@/data';
import { ToastProvider } from '@/ui';
import { ShoppingPage } from './ShoppingPage';
import { addItem, createList } from './store';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/shopping']}>
      <ToastProvider>
        <ShoppingPage />
      </ToastProvider>
    </MemoryRouter>,
  );
}

const items = (listId: string) => reader.list('shoppingItems', { where: { listId } });

beforeEach(async () => {
  localStorage.clear();
  await clearLocalData();
});
afterEach(cleanup);

describe('addItem (store)', () => {
  it('parses quantity, fills the remembered section, and bumps duplicates', async () => {
    const list = await createList('Groceries');
    const a = await addItem(list.id, '2 milk');
    expect(a.kind).toBe('added');
    if (a.kind !== 'added') return;
    expect(a.item).toMatchObject({ name: 'Milk', quantity: '2', section: null, checked: false });

    const b = await addItem(list.id, 'MILK x3');
    expect(b.kind).toBe('bumped');
    expect((await items(list.id)).map((i) => [i.name, i.quantity])).toEqual([['Milk', '5']]);
  });

  it('unchecks a checked duplicate instead of adding another', async () => {
    const list = await createList('Groceries');
    const a = await addItem(list.id, 'eggs');
    if (a.kind !== 'added') throw new Error('expected add');
    const { patch } = await import('@/data');
    await patch('shoppingItems', a.item.id, { checked: true });
    const b = await addItem(list.id, 'Eggs');
    expect(b.kind).toBe('unchecked');
    const all = await items(list.id);
    expect(all).toHaveLength(1);
    expect(all[0]!.checked).toBe(false);
  });

  it('remembers an item usual section from history, even after it is cleared', async () => {
    const list = await createList('Groceries');
    const a = await addItem(list.id, 'butter');
    if (a.kind !== 'added') throw new Error('expected add');
    const { patch, remove } = await import('@/data');
    await patch('shoppingItems', a.item.id, { section: 'Dairy' });
    await remove('shoppingItems', a.item.id);
    const b = await addItem(list.id, 'Butter');
    expect(b.kind === 'added' && b.item.section).toBe('Dairy');
    expect(b.kind === 'added' && b.item.name).toBe('Butter');
  });
});

describe('ShoppingPage', () => {
  it('adds, checks off, clears checked, and undoes', async () => {
    const user = userEvent.setup();
    await createList('Groceries');
    renderPage();

    const input = await screen.findByRole('combobox', { name: 'Add item' });
    await user.type(input, '2 milk{Enter}');
    await user.type(input, 'bread{Enter}');
    expect(input).toHaveFocus();

    const milk = await screen.findByRole('checkbox', { name: /Milk/ });
    expect(milk).toHaveAttribute('aria-checked', 'false');
    expect(within(milk).getByText('2')).toBeInTheDocument();
    await screen.findByRole('checkbox', { name: /Bread/ });

    await user.click(milk);
    // moves to the collapsed trolley group
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: /Milk/ })).toBeNull());
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
    expect(screen.getByText('1 of 2')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /In the trolley/ }));
    expect(await screen.findByRole('checkbox', { name: /Milk/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    await user.click(screen.getByRole('button', { name: 'Clear checked' }));
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: /Milk/ })).toBeNull());
    expect(screen.getByRole('checkbox', { name: /Bread/ })).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    // the trolley group stayed expanded, so the restored item shows straight away
    expect(await screen.findByRole('checkbox', { name: /Milk/ })).toBeInTheDocument();
  });

  it('adding a duplicate bumps the quantity rather than adding a row', async () => {
    const user = userEvent.setup();
    await createList('Groceries');
    renderPage();
    const input = await screen.findByRole('combobox', { name: 'Add item' });
    await user.type(input, 'eggs{Enter}');
    await screen.findByRole('checkbox', { name: /Eggs/ });
    await user.type(input, 'eggs{Enter}');
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(1));
    expect(await screen.findByText('2')).toBeInTheDocument();
  });

  it('shows items that change underneath it', async () => {
    const list = await createList('Groceries');
    renderPage();
    await screen.findByText('Nothing on this list');
    await addItem(list.id, 'tea');
    expect(await screen.findByRole('checkbox', { name: /Tea/ })).toBeInTheDocument();
  });

  it('offers to create the first list', async () => {
    renderPage();
    expect(await screen.findByText('No shopping lists yet')).toBeInTheDocument();
  });
});
