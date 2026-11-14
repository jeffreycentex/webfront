import { colourForLabel } from '@webfront/shared';
import { Link } from 'react-router';
import { colourStyle, EmptyState, Select, Skeleton } from '@/ui';
import { useActiveList, useItemHistory, useShoppingLists } from './hooks';
import { useListItems } from './ListPanel';
import { ItemRow } from './ItemRow';
import { effectiveSection, groupBySection, splitChecked } from './logic';
import { QuickAdd } from './QuickAdd';
import { setChecked } from './store';

const LIMIT = 12;

/** Dashboard widget: the active list, compact, with quick add and check-off. */
export default function ShoppingWidget() {
  const lists = useShoppingLists();
  const [active, select] = useActiveList(lists);
  const items = useListItems(active?.id);
  const history = useItemHistory();

  if (lists === undefined) return <Skeleton className="m-2 h-16" />;
  if (!active) {
    return (
      <EmptyState title="No shopping list yet">
        <Link to="/shopping?new=1" className="text-accent-text underline">
          Create one
        </Link>
      </EmptyState>
    );
  }

  const { open, checked } = splitChecked(items ?? []);
  // Flatten in section order so the compact view still reads like the shop.
  const ordered = groupBySection(open, active.sections).flatMap((g) => g.items);
  const shown = ordered.slice(0, LIMIT);
  const hidden = ordered.length - shown.length;
  const total = (items ?? []).length;

  return (
    <div style={colourStyle(active.colour)} className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-line bg-[var(--c-soft)] px-2 py-1 max-sm:px-3">
        {lists.length > 1 ? (
          <Select
            aria-label="Shopping list"
            value={active.id}
            onChange={(e) => select(e.target.value)}
            className="h-6 max-w-44 text-xs"
          >
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        ) : (
          <span className="truncate text-xs font-semibold">{active.name}</span>
        )}
        <span className="ml-auto text-xs tabular-nums text-fg-2">
          {checked.length} of {total}
        </span>
        <Link to={`/shopping?list=${active.id}`} className="text-xs text-accent-text underline">
          Open
        </Link>
      </div>
      <div className="p-2">
        <QuickAdd listId={active.id} history={history} />
      </div>
      {items === undefined ? (
        <Skeleton className="m-2 h-12" />
      ) : shown.length === 0 ? (
        <p className="px-3 pb-3 text-xs text-fg-3">
          {total ? 'Everything is in the trolley.' : 'Nothing on the list.'}
        </p>
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {shown.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              colour={colourForLabel(effectiveSection(item, active.sections))}
              onToggle={(i) => void setChecked(i.id, true)}
            />
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <Link
          to={`/shopping?list=${active.id}`}
          className="border-t border-line px-3 py-1.5 text-xs text-accent-text"
        >
          +{hidden} more
        </Link>
      )}
    </div>
  );
}
