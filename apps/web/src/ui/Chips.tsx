import { colourForLabel, COLOUR_KEYS, type ColourKey } from '@webfront/shared';
import { X } from 'lucide-react';
import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from '../lib/cx';
import { colourStyle } from './colour';

/** Small round colour swatch. */
export function ColourDot({
  colour,
  className,
  label,
}: {
  colour: ColourKey;
  className?: string;
  /** Provide when the colour itself carries meaning (otherwise decorative). */
  label?: string;
}) {
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cx('inline-block size-2 shrink-0 rounded-full bg-[var(--c)]', className)}
      style={colourStyle(colour)}
    />
  );
}

export interface TagChipProps {
  label: string;
  /** Defaults to the label's deterministic palette colour. */
  colour?: ColourKey;
  onClick?: () => void;
  onRemove?: () => void;
  className?: string;
}

/** Coloured tag chip. Clickable (filter) and/or removable. */
export function TagChip({ label, colour, onClick, onRemove, className }: TagChipProps) {
  const style = colourStyle(colour ?? colourForLabel(label));
  const cls = cx(
    'inline-flex h-4 max-w-full items-center gap-0.5 rounded-sm border border-[color:color-mix(in_oklab,var(--c)_35%,transparent)] bg-[var(--c-soft)] px-1.5 text-2xs font-medium leading-none text-fg max-sm:h-6',
    className,
  );
  const text = <span className="truncate">{label}</span>;
  return (
    <span className={cls} style={style}>
      {onClick ? (
        <button type="button" onClick={onClick} className="max-w-full truncate hover:underline">
          {text}
        </button>
      ) : (
        text
      )}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove tag ${label}`}
          onClick={onRemove}
          className="-mr-0.5 inline-flex size-3 items-center justify-center rounded-sm text-fg-2 hover:bg-[var(--c)] hover:text-white"
        >
          <X aria-hidden className="size-2.5" strokeWidth={3} />
        </button>
      )}
    </span>
  );
}

export interface TagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  /** Known tags offered while typing. */
  suggestions?: string[];
  /** Explicit tag colours (the `tags.colours` setting). */
  colours?: Record<string, ColourKey>;
  placeholder?: string;
  'aria-label'?: string;
  id?: string;
  className?: string;
}

export function normaliseTag(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').slice(0, 40);
}

/**
 * Tag editor: type and press Enter or comma to add, Backspace on empty input removes the last,
 * ArrowDown/Up + Enter pick a suggestion. Duplicates (case-insensitive) are ignored.
 */
export function TagInput({
  value,
  onChange,
  suggestions = [],
  colours,
  placeholder = 'Add tag',
  className,
  id,
  ...rest
}: TagInputProps) {
  const [text, setText] = useState('');
  const [active, setActive] = useState(-1);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const matches = useMemo(() => {
    const q = text.trim().toLowerCase();
    const have = new Set(value.map((t) => t.toLowerCase()));
    return suggestions
      .filter((s) => !have.has(s.toLowerCase()) && (!q || s.toLowerCase().includes(q)))
      .slice(0, 8);
  }, [suggestions, text, value]);

  const add = (raw: string) => {
    const tag = normaliseTag(raw);
    setText('');
    setActive(-1);
    if (!tag || value.some((t) => t.toLowerCase() === tag.toLowerCase())) return;
    onChange([...value, tag]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      if (e.key === 'Enter' && active >= 0 && matches[active]) {
        e.preventDefault();
        add(matches[active]!);
      } else if (text.trim()) {
        e.preventDefault();
        add(text);
      } else if (e.key === ',') {
        e.preventDefault();
      }
    } else if (e.key === 'Backspace' && !text && value.length) {
      onChange(value.slice(0, -1));
    } else if (e.key === 'ArrowDown' && matches.length) {
      e.preventDefault();
      setActive((a) => (a + 1) % matches.length);
    } else if (e.key === 'ArrowUp' && matches.length) {
      e.preventDefault();
      setActive((a) => (a <= 0 ? matches.length - 1 : a - 1));
    } else if (e.key === 'Escape' && (active >= 0 || text)) {
      e.stopPropagation();
      setActive(-1);
      setText('');
    }
  };

  const showList = focused && matches.length > 0 && text.length > 0;
  return (
    <div className={cx('relative', className)}>
      <div
        className="flex min-h-(--control-h) flex-wrap items-center gap-1 rounded-md border border-line-strong bg-surface px-1.5 py-1 shadow-sm focus-within:border-accent focus-within:outline-2 focus-within:outline-accent/30 hover:border-fg-3"
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((t) => (
          <TagChip
            key={t}
            label={t}
            {...(colours?.[t] ? { colour: colours[t] } : {})}
            onRemove={() => onChange(value.filter((x) => x !== t))}
          />
        ))}
        <input
          ref={inputRef}
          id={id}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setActive(-1);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            if (text.trim()) add(text);
          }}
          placeholder={value.length ? '' : placeholder}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label={rest['aria-label'] ?? 'Tags'}
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          className="min-w-16 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-3"
        />
      </div>
      {showList && (
        <ul
          id={listId}
          role="listbox"
          className="absolute left-0 top-full z-30 mt-1 max-h-48 min-w-40 overflow-auto rounded-md border border-line-strong bg-surface p-0.5 shadow-pop"
        >
          {matches.map((s, i) => (
            <li
              key={s}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                add(s);
              }}
              className={cx(
                'flex h-(--row-h) cursor-pointer items-center gap-1.5 rounded-sm px-2 text-sm',
                i === active ? 'bg-accent-soft' : 'hover:bg-surface-2',
              )}
            >
              <TagChip label={s} {...(colours?.[s] ? { colour: colours[s] } : {})} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface ColourPickerProps {
  value: ColourKey | null | undefined;
  onChange: (colour: ColourKey | null) => void;
  /** Offer a "none" swatch. */
  allowNone?: boolean;
  label?: string;
  className?: string;
}

/** The 12 palette colours as a radiogroup. Arrow keys move, Home/End jump. */
export function ColourPicker({
  value,
  onChange,
  allowNone,
  label = 'Colour',
  className,
}: ColourPickerProps) {
  const options: Array<ColourKey | null> = allowNone ? [null, ...COLOUR_KEYS] : [...COLOUR_KEYS];
  const current = options.indexOf(value ?? null);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (to: number) => {
    const i = (to + options.length) % options.length;
    onChange(options[i] ?? null);
    refs.current[i]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className={cx('flex flex-wrap gap-1', className)}>
      {options.map((c, i) => {
        const selected = i === current;
        return (
          <button
            key={c ?? 'none'}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={c ?? 'No colour'}
            title={c ?? 'No colour'}
            tabIndex={selected || (current < 0 && i === 0) ? 0 : -1}
            onClick={() => onChange(c)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown')
                (e.preventDefault(), move(i + 1));
              else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
                (e.preventDefault(), move(i - 1));
              else if (e.key === 'Home') (e.preventDefault(), move(0));
              else if (e.key === 'End') (e.preventDefault(), move(options.length - 1));
            }}
            style={c ? colourStyle(c) : undefined}
            className={cx(
              'inline-flex size-[18px] items-center justify-center rounded-full border-2 transition-transform hover:scale-110 max-sm:size-8',
              c ? 'bg-[var(--c)]' : 'bg-surface',
              selected ? 'border-fg' : 'border-transparent',
              !c && 'border-dashed !border-line-strong',
              !c && selected && '!border-solid !border-fg',
            )}
          >
            {selected && (
              <span aria-hidden className={cx('size-1.5 rounded-full', c ? 'bg-white' : 'bg-fg')} />
            )}
          </button>
        );
      })}
    </div>
  );
}

export type Status = 'ok' | 'warn' | 'bad' | 'idle';

/** Status dot (green / amber / red / grey) with an accessible label. */
export function StatusDot({
  status,
  label,
  pulse,
  className,
}: {
  status: Status;
  label?: string;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cx(
        'relative inline-block size-2 shrink-0 rounded-full',
        status === 'ok' && 'bg-ok',
        status === 'warn' && 'bg-warn',
        status === 'bad' && 'bg-bad',
        status === 'idle' && 'bg-fg-3/50',
        className,
      )}
    >
      {pulse && (
        <span
          className={cx(
            'absolute inset-0 animate-ping rounded-full opacity-60',
            status === 'ok' && 'bg-ok',
            status === 'warn' && 'bg-warn',
            status === 'bad' && 'bg-bad',
            status === 'idle' && 'bg-fg-3',
          )}
        />
      )}
    </span>
  );
}

/** Pill with status colours, for counts and states ("3 overdue"). */
export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'bad';
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        'inline-flex h-4 items-center rounded-full px-1.5 font-mono text-2xs font-medium leading-none tabular-nums',
        tone === 'neutral' && 'bg-surface-3 text-fg-2',
        tone === 'accent' && 'bg-accent-soft text-accent-text',
        tone === 'ok' && 'bg-ok-soft text-ok-text',
        tone === 'warn' && 'bg-warn-soft text-warn-text',
        tone === 'bad' && 'bg-bad-soft text-bad-text',
        className,
      )}
    >
      {children}
    </span>
  );
}
