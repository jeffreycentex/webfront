import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import {
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Settings2,
  ShoppingBasket,
  Undo2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { colourForLabel, compareBySortKey } from '@webfront/shared';
import { useCollection } from '@/data';
import {
  Badge,
  Button,
  colourStyle,
  cx,
  DropdownMenu,
  EmptyState,
  IconButton,
  Panel,
  Skeleton,
  useToast,
  type MenuItem,
} from '@/ui';
import { EditItemSheet } from './EditItemSheet';
import { ItemRow, SortableItemRow } from './ItemRow';
import { effectiveSection, groupBySection, splitChecked, type HistoryEntry } from './logic';
import { QuickAdd } from './QuickAdd';
import {
  checkItems,
  clearChecked,
  moveWithin,
  removeItems,
  restoreItems,
  setChecked,
  uncheckAll,
  type AddOutcome,
  type ShoppingItem,
  type ShoppingList,
} from './store';

/** Live items of one list, ordered. `undefined` while loading. */
export function useListItems(listId: string | undefined) {
  return useCollection(
    'shoppingItems',
    { where: { listId: listId ?? '' }, sort: compareBySortKey },
    [listId],
  );
}

export interface ListPanelProps {
  list: ShoppingList;
  history: readonly HistoryEntry[];
  phone: boolean;
  /** Shopping mode (phone): big type, no editing chrome, quick add hidden. */
  shopping?: boolean;
  onShoppingChange?: (on: boolean) => void;
  onSettings: (list: ShoppingList) => void;
  /** Increment to focus the quick-add field. */
  focusToken?: number;
  className?: string;
}

/** Hook: toast helpers shared by the panel actions. */
function useActions(listId: string) {
  const { toast } = useToast();
  const remove = useCallback(
    async (item: Pick<ShoppingItem, 'id' | 'name'>) => {
      await removeItems([item.id]);
      toast({
        title: `Removed ${item.name}`,
        action: { label: 'Undo', onClick: () => void restoreItems([item.id]) },
      });
    },
    [toast],
  );
  const clear = useCallback(async () => {
    const ids = await clearChecked(listId);
    if (!ids.length) return;
    toast({
      title: `Cleared ${ids.length} checked ${ids.length === 1 ? 'item' : 'items'}`,
      action: { label: 'Undo', onClick: () => void restoreItems(ids) },
    });
  }, [listId, toast]);
  const uncheck = useCallback(async () => {
    const ids = await uncheckAll(listId);
    if (!ids.length) return;
    toast({
      title: `Unchecked ${ids.length} ${ids.length === 1 ? 'item' : 'items'}`,
      action: { label: 'Undo', onClick: () => void checkItems(ids) },
    });
  }, [listId, toast]);
  return { remove, clear, uncheck };
}

export function ListPanel({
  list,
  history,
  phone,
  shopping = false,
  onShoppingChange,
  onSettings,
  focusToken,
  className,
}: ListPanelProps) {
  const items = useListItems(list.id);
  const { remove, clear, uncheck } = useActions(list.id);
  const [editId, setEditId] = useState<string | null>(null);
  const [trolleyOpen, setTrolleyOpen] = useState(false);
  const [flashId, setFlashId] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => () => clearTimeout(flashTimer.current), []);
  useEffect(() => {
    if (focusToken) inputRef.current?.focus();
  }, [focusToken]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const { groups, checked, total } = useMemo(() => {
    const all = items ?? [];
    const { open, checked } = splitChecked(all);
    return { groups: groupBySection(open, list.sections), checked, total: all.length };
  }, [items, list.sections]);

  const onResult = (o: AddOutcome) => {
    if (o.kind === 'empty' || o.kind === 'added') return;
    setFlashId(o.item.id);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashId(null), 1400);
  };

  const sectionOf = (item: ShoppingItem) => effectiveSection(item, list.sections);
  const colourOf = (item: ShoppingItem) => colourForLabel(sectionOf(item));

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const group = groups.find((g) => g.items.some((i) => i.id === active.id));
    if (!group) return;
    const to = group.items.findIndex((i) => i.id === over.id);
    if (to < 0) return;
    void moveWithin(group.items, String(active.id), to);
  };

  const onMove = (item: ShoppingItem, delta: -1 | 1) => {
    const group = groups.find((g) => g.items.some((i) => i.id === item.id));
    if (!group) return;
    const from = group.items.findIndex((i) => i.id === item.id);
    const to = Math.max(0, Math.min(group.items.length - 1, from + delta));
    if (to !== from) void moveWithin(group.items, item.id, to);
  };

  const done = checked.length;
  const pct = total ? Math.round((done / total) * 100) : 0;

  const menu: MenuItem[] = [
    { label: 'Uncheck all', icon: <Undo2 />, onSelect: () => void uncheck(), disabled: !done },
    { label: 'Clear checked', icon: <X />, onSelect: () => void clear(), disabled: !done },
    'separator',
    ...(phone && onShoppingChange
      ? [
          {
            label: 'Shopping mode',
            icon: <ShoppingBasket />,
            onSelect: () => onShoppingChange(true),
          } satisfies MenuItem,
        ]
      : []),
    { label: 'List settings', icon: <Settings2 />, onSelect: () => onSettings(list) },
  ];

  const quickAdd = (
    <QuickAdd
      listId={list.id}
      history={history}
      openUp={phone}
      onResult={onResult}
      inputRef={inputRef}
    />
  );

  const actions = shopping ? (
    <Button size="sm" variant="ghost" onClick={() => onShoppingChange?.(false)}>
      Exit shopping mode
    </Button>
  ) : (
    <>
      <DropdownMenu
        label={`${list.name} actions`}
        placement="bottom-end"
        items={menu}
        trigger={
          <IconButton
            label={`${list.name} actions`}
            icon={<MoreHorizontal />}
            size="sm"
            tooltip={false}
          />
        }
      />
    </>
  );

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <span className="truncate">{list.name}</span>
          <Badge>{total ? `${done} of ${total}` : '0'}</Badge>
        </span>
      }
      colour={list.colour}
      actions={actions}
      className={cx(phone && 'min-h-full flex-1', className)}
      aria-label={list.name}
    >
      <div className={cx('flex flex-col', phone && 'h-full min-h-[60dvh]')}>
        <div
          role="progressbar"
          aria-label={`${list.name} progress`}
          aria-valuemin={0}
          aria-valuemax={total || 1}
          aria-valuenow={done}
          className="h-1 bg-[var(--c-soft)]"
        >
          <div
            className="h-full bg-[var(--c)] transition-[width] duration-200"
            style={{ width: `${pct}%` }}
          />
        </div>
        {!phone && !shopping && <div className="border-b border-line p-2">{quickAdd}</div>}

        <div className="flex-1">
          {items === undefined ? (
            <div className="flex flex-col gap-2 p-3" aria-busy="true">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          ) : total === 0 ? (
            <EmptyState title="Nothing on this list" icon={<ShoppingBasket />}>
              Type an item below to add it. Everything you add is remembered for next time.
            </EmptyState>
          ) : (
            <>
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={onDragEnd}
              >
                {groups.map((g) => (
                  <section
                    key={g.section}
                    aria-label={g.section}
                    style={colourStyle(colourForLabel(g.section))}
                  >
                    <h3
                      className={cx(
                        'label-caps flex items-center gap-1.5 border-y border-line bg-[var(--c-soft)] px-2 py-0.5 text-[color:var(--c)] max-sm:px-3 max-sm:py-1',
                        shopping && 'text-sm',
                      )}
                    >
                      <span aria-hidden className="size-2 rounded-full bg-[var(--c)]" />
                      {g.section}
                      <span className="ml-auto font-normal tabular-nums text-fg-3">
                        {g.items.length}
                      </span>
                    </h3>
                    <SortableContext
                      items={g.items.map((i) => i.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      <ul className="divide-y divide-line">
                        {g.items.map((item) =>
                          shopping ? (
                            <ItemRow
                              key={item.id}
                              item={item}
                              colour={colourOf(item)}
                              shopping
                              flash={flashId === item.id}
                              onToggle={(i) => void setChecked(i.id, true)}
                            />
                          ) : (
                            <SortableItemRow
                              key={item.id}
                              item={item}
                              colour={colourOf(item)}
                              flash={flashId === item.id}
                              onToggle={(i) => void setChecked(i.id, true)}
                              onEdit={(i) => setEditId(i.id)}
                              onRemove={(i) => void remove(i)}
                              onMove={onMove}
                            />
                          ),
                        )}
                      </ul>
                    </SortableContext>
                  </section>
                ))}
              </DndContext>

              {done > 0 && (
                <section aria-label="In the trolley" className="border-t border-line">
                  <div className="flex items-center gap-1 bg-surface-2 pr-1">
                    <button
                      type="button"
                      aria-expanded={trolleyOpen}
                      onClick={() => setTrolleyOpen((o) => !o)}
                      className="label-caps flex min-h-(--row-h) flex-1 items-center gap-1.5 px-2 text-left text-fg-2 max-sm:px-3"
                    >
                      {trolleyOpen ? (
                        <ChevronDown aria-hidden className="size-3.5" />
                      ) : (
                        <ChevronRight aria-hidden className="size-3.5" />
                      )}
                      In the trolley
                      <span className="font-normal tabular-nums text-fg-3">{done}</span>
                    </button>
                    {!shopping && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => void uncheck()}>
                          Uncheck all
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => void clear()}>
                          Clear checked
                        </Button>
                      </>
                    )}
                  </div>
                  {trolleyOpen && (
                    <ul className="divide-y divide-line">
                      {checked.map((item) => (
                        <ItemRow
                          key={item.id}
                          item={item}
                          colour={colourOf(item)}
                          shopping={shopping}
                          flash={flashId === item.id}
                          onToggle={(i) => void setChecked(i.id, false)}
                          {...(shopping ? {} : { onEdit: (i: ShoppingItem) => setEditId(i.id) })}
                        />
                      ))}
                    </ul>
                  )}
                </section>
              )}
            </>
          )}
        </div>

        {phone && !shopping && (
          <div className="sticky bottom-0 z-20 border-t border-line-strong bg-surface p-2 pb-2.5">
            {quickAdd}
          </div>
        )}
      </div>

      <EditItemSheet
        itemId={editId}
        sections={list.sections}
        onClose={() => setEditId(null)}
        onRemove={(id) => {
          const item = items?.find((i) => i.id === id);
          if (item) void remove(item);
        }}
      />
    </Panel>
  );
}
