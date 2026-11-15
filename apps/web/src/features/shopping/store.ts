import {
  DEFAULT_SHOPPING_SECTIONS,
  compareBySortKey,
  sortKeyAfter,
  sortKeyForIndex,
  type ColourKey,
  type RecordOf,
} from '@webfront/shared';
import { patch, put, reader, remove, restore, transaction } from '@/data';
import {
  bumpQuantity,
  buildHistory,
  findDuplicate,
  nameKey,
  parseQuantity,
  planAddStaples,
  type Staple,
  tidyName,
} from './logic';

/** Write actions for the shopping feature. Everything goes through `@/data` (offline safe). */

export type ShoppingList = RecordOf<'shoppingLists'>;
export type ShoppingItem = RecordOf<'shoppingItems'>;

export type AddOutcome =
  | { kind: 'empty' }
  | { kind: 'added'; item: ShoppingItem }
  | { kind: 'bumped'; item: ShoppingItem }
  | { kind: 'flashed'; item: ShoppingItem }
  | { kind: 'unchecked'; item: ShoppingItem };

/** Add "2 milk" to a list, handling duplicates and the remembered store section. */
export async function addItem(listId: string, text: string): Promise<AddOutcome> {
  const { name: baseName, quantity } = parseQuantity(text);
  if (!baseName) return { kind: 'empty' };

  const [items, all, list] = await Promise.all([
    reader.list('shoppingItems', { where: { listId } }),
    reader.list('shoppingItems', { includeDeleted: true }),
    reader.get('shoppingLists', listId),
  ]);
  const key = nameKey(baseName);
  const known = buildHistory(all).find((h) => h.key === key);
  const name = known?.name ?? tidyName(baseName);

  const dup = findDuplicate(items, name);
  if (dup) {
    if (dup.checked) {
      const changes: Partial<ShoppingItem> = { checked: false };
      if (quantity) changes.quantity = quantity;
      return { kind: 'unchecked', item: await patch('shoppingItems', dup.id, changes) };
    }
    const next = bumpQuantity(dup.quantity, quantity ?? null);
    if (next === null) return { kind: 'flashed', item: dup };
    return { kind: 'bumped', item: await patch('shoppingItems', dup.id, { quantity: next }) };
  }

  const sections = list?.sections ?? [...DEFAULT_SHOPPING_SECTIONS];
  const section = known?.section && sections.includes(known.section) ? known.section : null;
  const last = items.reduce<string | null>(
    (m, i) => (m === null || i.sortKey > m ? i.sortKey : m),
    null,
  );
  const item = await put('shoppingItems', {
    listId,
    name,
    quantity,
    section,
    checked: false,
    sortKey: sortKeyAfter(last),
    note: '',
    staple: false,
  });
  return { kind: 'added', item };
}

export function setChecked(id: string, checked: boolean) {
  return patch('shoppingItems', id, { checked });
}

export async function removeItems(ids: readonly string[]): Promise<void> {
  await transaction(async () => {
    for (const id of ids) await remove('shoppingItems', id);
  });
}

export async function restoreItems(ids: readonly string[]): Promise<void> {
  await transaction(async () => {
    for (const id of ids) await restore('shoppingItems', id);
  });
}

/** Soft-delete every checked item on the list. Returns their ids (for undo). */
export async function clearChecked(listId: string): Promise<string[]> {
  const items = await reader.list('shoppingItems', { where: { listId } });
  const ids = items.filter((i) => i.checked).map((i) => i.id);
  await removeItems(ids);
  return ids;
}

/** Uncheck every checked item. Returns their ids (for undo, re-check them). */
export async function uncheckAll(listId: string): Promise<string[]> {
  const items = await reader.list('shoppingItems', { where: { listId } });
  const ids = items.filter((i) => i.checked).map((i) => i.id);
  await transaction(async () => {
    for (const id of ids) await patch('shoppingItems', id, { checked: false });
  });
  return ids;
}

export async function checkItems(ids: readonly string[]): Promise<void> {
  await transaction(async () => {
    for (const id of ids) await patch('shoppingItems', id, { checked: true });
  });
}

/**
 * Move `itemId` to `toIndex` among `siblings` (the other items of its section, in display
 * order). Only the moved item's `sortKey` changes.
 */
export async function moveWithin(
  siblings: readonly ShoppingItem[],
  itemId: string,
  toIndex: number,
): Promise<void> {
  const others = siblings.filter((i) => i.id !== itemId).sort(compareBySortKey);
  await patch('shoppingItems', itemId, { sortKey: sortKeyForIndex(others, toIndex) });
}

// ---- lists ---------------------------------------------------------------------------------

export async function createList(name: string, colour: ColourKey = 'green'): Promise<ShoppingList> {
  const lists = await reader.list('shoppingLists');
  const last = lists.reduce<string | null>(
    (m, l) => (m === null || l.sortKey > m ? l.sortKey : m),
    null,
  );
  return put('shoppingLists', {
    name: name.trim(),
    colour,
    sortKey: sortKeyAfter(last),
    sections: [...DEFAULT_SHOPPING_SECTIONS],
  });
}

export function deleteList(id: string) {
  return remove('shoppingLists', id);
}

export function restoreList(id: string) {
  return restore('shoppingLists', id);
}

export async function moveList(lists: readonly ShoppingList[], id: string, toIndex: number) {
  const others = lists.filter((l) => l.id !== id).sort(compareBySortKey);
  await patch('shoppingLists', id, { sortKey: sortKeyForIndex(others, toIndex) });
}

/** Save an edited section list; `renames` maps old names to new ones so items follow. */
export async function saveSections(
  listId: string,
  sections: string[],
  renames: ReadonlyMap<string, string> = new Map(),
): Promise<void> {
  await transaction(async () => {
    await patch('shoppingLists', listId, { sections });
    if (renames.size === 0) return;
    const items = await reader.list('shoppingItems', { where: { listId } });
    for (const it of items) {
      const to = it.section ? renames.get(it.section) : undefined;
      if (to && to !== it.section) await patch('shoppingItems', it.id, { section: to });
    }
  });
}

// ---- staples ---------------------------------------------------------------------------------

/**
 * Flag or unflag by name. Flagging marks one record; unflagging clears the flag on every record
 * of the list with that name (cleared copies included) so the staple really goes away.
 * Only the `staple` field of item records is written (never the list), so concurrent edits on
 * other devices merge field by field.
 */
export async function setStaple(item: Pick<ShoppingItem, 'id' | 'listId' | 'name'>, on: boolean) {
  if (on) {
    await patch('shoppingItems', item.id, { staple: true });
    return;
  }
  const key = nameKey(item.name);
  await transaction(async () => {
    const all = await reader.list('shoppingItems', {
      where: { listId: item.listId },
      includeDeleted: true,
    });
    for (const r of all) {
      if (r.staple && nameKey(r.name) === key)
        await patch('shoppingItems', r.id, { staple: false });
    }
  });
}

/** "Add to staples" for a name that may not be on the list (a suggestion). */
export async function addStapleByName(
  listId: string,
  entry: { name: string; section: string | null },
  quantity: string | null = null,
): Promise<void> {
  const key = nameKey(entry.name);
  await transaction(async () => {
    const all = await reader.list('shoppingItems', { where: { listId }, includeDeleted: true });
    const same = all
      .filter((r) => nameKey(r.name) === key)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const hit = same[0];
    if (hit) {
      if (!hit.staple) await patch('shoppingItems', hit.id, { staple: true });
      return;
    }
    const list = await reader.get('shoppingLists', listId);
    const sections = list?.sections ?? [...DEFAULT_SHOPPING_SECTIONS];
    // A flagged tombstone: the staple exists, but nothing is added to the list.
    const rec = await put('shoppingItems', {
      listId,
      name: entry.name,
      quantity,
      section: entry.section && sections.includes(entry.section) ? entry.section : null,
      checked: false,
      sortKey: sortKeyAfter(null),
      note: '',
      staple: true,
    });
    await remove('shoppingItems', rec.id);
  });
}

/** Edit what a staple remembers. Written to its representative record. */
export function updateStaple(
  staple: Pick<Staple, 'recordId'>,
  changes: { quantity: string | null; section: string | null; note: string },
) {
  return patch('shoppingItems', staple.recordId, changes);
}

/**
 * Put staples on the list following the duplicate rules (see `planAddStaples`). A cleared staple
 * record is restored (so the staple stays one record); returns how many things changed.
 */
export async function addStaples(listId: string, staples: readonly Staple[]): Promise<number> {
  return transaction(async () => {
    const live = await reader.list('shoppingItems', { where: { listId } });
    const plan = planAddStaples(staples, live);
    let last = live.reduce<string | null>(
      (m, i) => (m === null || i.sortKey > m ? i.sortKey : m),
      null,
    );
    for (const a of plan) {
      if (a.kind === 'uncheck') {
        await patch('shoppingItems', a.itemId!, { checked: false });
        continue;
      }
      last = sortKeyAfter(last);
      await patch('shoppingItems', a.staple.recordId, {
        checked: false,
        quantity: a.staple.quantity,
        sortKey: last,
      });
      await restore('shoppingItems', a.staple.recordId);
    }
    return plan.length;
  });
}
