import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Check, Pencil, Star, X } from 'lucide-react';
import { useRef, useState, type ComponentProps, type CSSProperties, type Ref } from 'react';
import type { ColourKey } from '@webfront/shared';
import { colourStyle, cx, DragHandle, IconButton } from '@/ui';
import type { ShoppingItem } from './store';

export interface ItemRowProps {
  item: ShoppingItem;
  colour: ColourKey;
  /** Larger type, no editing chrome. */
  shopping?: boolean;
  /** Briefly highlight (a duplicate add landed here). */
  flash?: boolean;
  onToggle: (item: ShoppingItem) => void;
  onEdit?: (item: ShoppingItem) => void;
  onRemove?: (item: ShoppingItem) => void;
  /** Staple state and toggle (omit the toggle to hide the star). */
  staple?: boolean;
  onToggleStaple?: (item: ShoppingItem, on: boolean) => void;
  /** Alt+Arrow keyboard reorder: -1 up, +1 down. */
  onMove?: (item: ShoppingItem, delta: -1 | 1) => void;
  /** Sortable wiring (only for unchecked rows). */
  drag?: {
    setNodeRef: Ref<HTMLLIElement>;
    style: CSSProperties;
    handle: ComponentProps<typeof DragHandle>;
    dragging: boolean;
  };
}

const SWIPE_DISTANCE = 96;

/** One shopping row: tap to check, edit button, drag handle, swipe left to remove. */
export function ItemRow({
  item,
  colour,
  shopping,
  flash,
  onToggle,
  onEdit,
  onRemove,
  staple,
  onToggleStaple,
  onMove,
  drag,
}: ItemRowProps) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const [dx, setDx] = useState(0);
  const canSwipe = Boolean(onRemove) && !shopping && !item.checked;

  return (
    <li
      ref={drag?.setNodeRef}
      style={{ ...colourStyle(colour), ...drag?.style }}
      data-flash={flash || undefined}
      className={cx(
        'group/row relative overflow-hidden bg-surface',
        drag?.dragging && 'z-10 shadow-pop',
        flash && 'animate-[wf-pop-in_300ms_ease-out] bg-accent-soft',
      )}
    >
      {canSwipe && dx < -8 && (
        <span
          aria-hidden
          className="absolute inset-y-0 right-0 flex items-center bg-bad-soft px-4 text-sm font-medium text-bad-text"
        >
          Remove
        </span>
      )}
      <div
        onTouchStart={(e) => {
          if (!canSwipe) return;
          const t = e.touches[0]!;
          start.current = { x: t.clientX, y: t.clientY };
        }}
        onTouchMove={(e) => {
          if (!start.current) return;
          const t = e.touches[0]!;
          const ddx = t.clientX - start.current.x;
          const ddy = Math.abs(t.clientY - start.current.y);
          if (ddy > 24) {
            start.current = null;
            setDx(0);
          } else setDx(Math.min(0, ddx));
        }}
        onTouchEnd={() => {
          if (start.current && dx <= -SWIPE_DISTANCE) onRemove?.(item);
          start.current = null;
          setDx(0);
        }}
        style={dx ? { transform: `translateX(${dx}px)` } : undefined}
        className={cx(
          'relative flex items-center gap-1.5 bg-surface px-2 max-sm:px-3',
          shopping ? 'min-h-14' : 'min-h-(--row-h)',
          item.checked && 'text-fg-3',
        )}
      >
        <button
          type="button"
          role="checkbox"
          aria-checked={item.checked}
          onClick={() => onToggle(item)}
          onKeyDown={(e) => {
            if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && onMove) {
              e.preventDefault();
              onMove(item, e.key === 'ArrowUp' ? -1 : 1);
            }
          }}
          className={cx(
            'flex min-h-[inherit] min-w-0 flex-1 items-center gap-2 text-left',
            shopping ? 'py-2' : 'py-0.5',
          )}
        >
          <span
            aria-hidden
            className={cx(
              'inline-flex shrink-0 items-center justify-center rounded-full border-2 border-[color:var(--c)]',
              shopping ? 'size-7' : 'size-4 max-sm:size-6',
              item.checked ? 'bg-[var(--c-soft)] text-fg' : 'bg-surface',
            )}
          >
            {item.checked && <Check className="size-3/4" strokeWidth={3} />}
          </span>
          <span className="min-w-0 flex-1">
            <span
              className={cx(
                'block truncate',
                shopping ? 'text-lg font-medium' : 'text-sm max-sm:text-base',
                item.checked && 'line-through',
              )}
            >
              {item.name}
            </span>
            {item.note && (
              <span className={cx('block truncate text-fg-3', shopping ? 'text-sm' : 'text-xs')}>
                {item.note}
              </span>
            )}
          </span>
          {item.quantity && (
            <span
              className={cx(
                'shrink-0 rounded-full bg-[var(--c-soft)] px-1.5 font-medium tabular-nums text-[color:var(--c)]',
                shopping ? 'py-0.5 text-base' : 'text-xs max-sm:py-0.5 max-sm:text-sm',
                item.checked && 'opacity-60',
              )}
            >
              {item.quantity}
            </span>
          )}
        </button>
        {!shopping && (
          <span className="flex shrink-0 items-center gap-0.5">
            {onToggleStaple && (
              <IconButton
                label={staple ? `Remove ${item.name} from staples` : `Add ${item.name} to staples`}
                icon={<Star className={staple ? 'fill-current' : undefined} />}
                size="sm"
                tooltip={false}
                aria-pressed={staple ?? false}
                className={cx(
                  'max-sm:h-[44px] max-sm:w-[44px]',
                  staple
                    ? 'text-accent-text'
                    : 'sm:opacity-0 sm:group-focus-within/row:opacity-100 sm:group-hover/row:opacity-100',
                )}
                onClick={() => onToggleStaple(item, !staple)}
              />
            )}
            {onEdit && (
              <IconButton
                label={`Edit ${item.name}`}
                icon={<Pencil />}
                size="sm"
                tooltip={false}
                onClick={() => onEdit(item)}
              />
            )}
            {onRemove && (
              <IconButton
                label={`Remove ${item.name}`}
                icon={<X />}
                size="sm"
                tooltip={false}
                className="max-sm:hidden sm:opacity-0 sm:group-focus-within/row:opacity-100 sm:group-hover/row:opacity-100"
                onClick={() => onRemove(item)}
              />
            )}
            {drag && <DragHandle {...drag.handle} aria-label={`Reorder ${item.name}`} />}
          </span>
        )}
      </div>
    </li>
  );
}

/** Wraps `ItemRow` with dnd-kit sortable wiring. Must be inside a `SortableContext`. */
export function SortableItemRow(props: Omit<ItemRowProps, 'drag'>) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.item.id });
  return (
    <ItemRow
      {...props}
      drag={{
        setNodeRef,
        style: { transform: CSS.Transform.toString(transform), transition },
        handle: { ref: setActivatorNodeRef, ...attributes, ...listeners },
        dragging: isDragging,
      }}
    />
  );
}
