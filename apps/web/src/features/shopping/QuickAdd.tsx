import { Plus } from 'lucide-react';
import { useEffect, useId, useRef, useState, type Ref } from 'react';
import { cx, Input, useToast } from '@/ui';
import { suggest, parseQuantity, type HistoryEntry } from './logic';
import { addItem, type AddOutcome } from './store';

export interface QuickAddProps {
  listId: string;
  history: readonly HistoryEntry[];
  /** Phone: suggestions open upwards (the bar sits at the bottom). */
  openUp?: boolean;
  onResult?: (outcome: AddOutcome) => void;
  inputRef?: Ref<HTMLInputElement>;
  className?: string;
  autoFocus?: boolean;
}

/**
 * Type a name (optionally with a quantity: "2 milk", "milk x2", "500g flour") and press Enter.
 * The input keeps focus so several items can be added in a row. Suggestions come from history.
 */
export function QuickAdd({
  listId,
  history,
  openUp,
  onResult,
  inputRef,
  className,
  autoFocus,
}: QuickAddProps) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(-1);
  const listId_ = useId();
  const { toast } = useToast();
  const local = useRef<HTMLInputElement | null>(null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());

  const parsed = parseQuantity(text);
  const options = focused ? suggest(history, parsed.name || text, 6) : [];
  const open = focused && options.length > 0;

  useEffect(() => setActive(-1), [text]);

  const submit = (value: string) => {
    if (!value.trim()) return;
    setText('');
    // Serialise so two quick Enters see each other's writes (duplicate detection).
    chain.current = chain.current
      .then(() => addItem(listId, value))
      .then((o) => onResult?.(o))
      .catch(() =>
        toast({ title: 'Could not add item', tone: 'error', description: 'It was not saved.' }),
      );
  };

  const pick = (entry: HistoryEntry) => {
    submit(`${parsed.quantity ? parsed.quantity + ' ' : ''}${entry.name}`);
    local.current?.focus();
  };

  return (
    <div className={cx('relative', className)}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const chosen = active >= 0 ? options[active] : undefined;
          if (chosen) pick(chosen);
          else submit(text);
        }}
        className="flex items-center gap-1.5"
      >
        <Input
          ref={(el) => {
            local.current = el;
            if (typeof inputRef === 'function') inputRef(el);
            else if (inputRef) (inputRef as { current: HTMLInputElement | null }).current = el;
          }}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (!options.length) return;
            const dir = openUp ? -1 : 1;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const step = e.key === 'ArrowDown' ? dir : -dir;
              setActive((a) => Math.max(-1, Math.min(options.length - 1, a + step)));
            } else if (e.key === 'Escape' && active >= 0) {
              setActive(-1);
            }
          }}
          placeholder="Add item (2 milk, eggs x6, 500g flour)"
          aria-label="Add item"
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId_ : undefined}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listId_}-${active}` : undefined}
          autoComplete="off"
          autoCapitalize="sentences"
          enterKeyHint="enter"
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus={autoFocus}
          className="max-sm:h-[44px] max-sm:text-base"
        />
        <button
          type="submit"
          aria-label="Add"
          className="inline-flex h-(--control-h) w-(--control-h) shrink-0 items-center justify-center rounded-md bg-accent text-accent-fg hover:bg-accent-hover max-sm:h-[44px] max-sm:w-[44px]"
          // keep focus (and the phone keyboard) in the input
          onMouseDown={(e) => e.preventDefault()}
        >
          <Plus aria-hidden className="size-4" />
        </button>
      </form>
      {open && (
        <ul
          id={listId_}
          role="listbox"
          aria-label="Suggestions"
          className={cx(
            'absolute inset-x-0 z-30 overflow-hidden rounded-md border border-line-strong bg-surface shadow-pop',
            openUp ? 'bottom-full mb-1 flex flex-col-reverse' : 'top-full mt-1',
          )}
        >
          {options.map((o, i) => (
            <li
              key={o.key}
              id={`${listId_}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(o);
              }}
              className={cx(
                'flex min-h-(--row-h) cursor-pointer items-center justify-between gap-2 px-2.5 text-sm max-sm:px-3',
                i === active ? 'bg-accent-soft' : 'hover:bg-surface-2',
              )}
            >
              <span className="truncate">{o.name}</span>
              {o.section && <span className="shrink-0 text-xs text-fg-3">{o.section}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
