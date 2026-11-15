import { Plus, ShoppingCart } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  colourStyle,
  cx,
  EmptyState,
  IconButton,
  PageHeader,
  Skeleton,
  useIsPhone,
  useToast,
  Button,
} from '@/ui';
import { useActiveList, useItemHistory, useShoppingLists, useWakeLock } from './hooks';
import { ListPanel, useListItems } from './ListPanel';
import { ListSettingsModal, NewListModal } from './ListSettings';
import { deleteList, moveList, restoreList, type ShoppingList } from './store';

/** Open-item count for the switcher chips. */
function ListChip({
  list,
  active,
  onSelect,
}: {
  list: ShoppingList;
  active: boolean;
  onSelect: () => void;
}) {
  const items = useListItems(list.id);
  const open = items?.filter((i) => !i.checked).length ?? 0;
  return (
    <button
      type="button"
      aria-current={active ? 'true' : undefined}
      onClick={onSelect}
      style={colourStyle(list.colour)}
      className={cx(
        'flex h-10 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-medium',
        active
          ? 'border-[color:var(--c)] bg-[var(--c-soft)] text-fg'
          : 'border-line bg-surface text-fg-2',
      )}
    >
      <span aria-hidden className="size-2.5 rounded-full bg-[var(--c)]" />
      {list.name}
      {open > 0 && <span className="text-xs tabular-nums text-fg-3">{open}</span>}
    </button>
  );
}

export function ShoppingPage() {
  const lists = useShoppingLists();
  const [active, select] = useActiveList(lists);
  const history = useItemHistory();
  const phone = useIsPhone();
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const [newOpen, setNewOpen] = useState(false);
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [shopping, setShopping] = useState(false);
  const [focusToken, setFocusToken] = useState(0);
  const [staplesToken, setStaplesToken] = useState(0);

  useWakeLock(shopping && phone);

  // Deep links: ?list=<id> (search), ?add=1 and ?new=1 (commands). Consumed once.
  const listParam = params.get('list');
  const addParam = params.get('add');
  const newParam = params.get('new');
  const staplesParam = params.get('staples');
  useEffect(() => {
    if (!listParam && !addParam && !newParam && !staplesParam) return;
    if (listParam) select(listParam);
    if (addParam) setFocusToken((n) => n + 1);
    if (newParam) setNewOpen(true);
    if (staplesParam) setStaplesToken((n) => n + 1);
    setParams({}, { replace: true });
  }, [listParam, addParam, newParam, staplesParam, select, setParams]);

  const settingsList = lists?.find((l) => l.id === settingsId) ?? null;
  const settingsIndex = settingsList ? lists!.findIndex((l) => l.id === settingsList.id) : -1;

  const archive = useCallback(
    async (list: ShoppingList) => {
      await deleteList(list.id);
      toast({
        title: `Archived ${list.name}`,
        action: { label: 'Undo', onClick: () => void restoreList(list.id) },
      });
    },
    [toast],
  );

  const inShopping = shopping && phone && active !== null;

  return (
    <div className="flex min-h-full flex-col">
      {!inShopping && (
        <PageHeader
          title="Shopping"
          icon={<ShoppingCart />}
          actions={
            <Button size="sm" onClick={() => setNewOpen(true)}>
              <Plus aria-hidden className="size-3.5" /> New list
            </Button>
          }
        />
      )}

      {lists === undefined ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : lists.length === 0 ? (
        <EmptyState
          title="No shopping lists yet"
          icon={<ShoppingCart />}
          action={
            <Button variant="primary" onClick={() => setNewOpen(true)}>
              Create your first list
            </Button>
          }
        >
          Make one per shop: Groceries, Hardware, Pharmacy.
        </EmptyState>
      ) : phone ? (
        <>
          {!inShopping && (
            <nav
              aria-label="Shopping lists"
              className="scroll-thin -mx-2.5 mb-2 flex gap-1.5 overflow-x-auto px-2.5 pb-1"
            >
              {lists.map((l) => (
                <ListChip
                  key={l.id}
                  list={l}
                  active={l.id === active?.id}
                  onSelect={() => select(l.id)}
                />
              ))}
              <IconButton
                label="New list"
                icon={<Plus />}
                variant="subtle"
                className="size-10 rounded-full"
                tooltip={false}
                onClick={() => setNewOpen(true)}
              />
            </nav>
          )}
          {active && (
            <ListPanel
              key={active.id}
              list={active}
              history={history}
              phone
              shopping={inShopping}
              onShoppingChange={setShopping}
              onSettings={(l) => setSettingsId(l.id)}
              focusToken={focusToken}
              staplesToken={staplesToken}
            />
          )}
        </>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] items-start gap-3">
          {lists.map((l) => (
            <div key={l.id} onFocusCapture={() => select(l.id)} onPointerDown={() => select(l.id)}>
              <ListPanel
                list={l}
                history={history}
                phone={false}
                onSettings={(x) => setSettingsId(x.id)}
                {...(l.id === active?.id ? { focusToken, staplesToken } : {})}
              />
            </div>
          ))}
        </div>
      )}

      <NewListModal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={(l) => select(l.id)}
      />
      <ListSettingsModal
        list={settingsList}
        onClose={() => setSettingsId(null)}
        onArchive={(l) => void archive(l)}
        onMove={(l, d) => {
          if (lists) void moveList(lists, l.id, settingsIndex + d);
        }}
        canMoveLeft={settingsIndex > 0}
        canMoveRight={lists ? settingsIndex >= 0 && settingsIndex < lists.length - 1 : false}
      />
    </div>
  );
}
