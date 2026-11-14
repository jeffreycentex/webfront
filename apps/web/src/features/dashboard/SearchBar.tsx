import { colourForLabel, safeHttpUrl } from '@webfront/shared';
import { CornerDownLeft, Globe, Search, X } from 'lucide-react';
import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Kbd, cx, colourStyle, useHotkeys, useIsPhone } from '@/ui';
import { useFeatures } from '../context';
import { buildOptions, pickOption, type ProviderResults, type SearchOption } from './searchLogic';

export interface SearchBarProps {
  query: string;
  onQueryChange: (query: string) => void;
  engine: { name: string; urlTemplate: string };
  /** Test seam: open an absolute URL (default: same tab, or a new tab with `newTab`). */
  openUrl?: (url: string, newTab: boolean) => void;
}

const DEBOUNCE_MS = 120;
const PER_PROVIDER = 5;

function defaultOpenUrl(url: string, newTab: boolean) {
  if (newTab) window.open(url, '_blank', 'noopener,noreferrer');
  else window.location.assign(url);
}

/** Only http(s) URLs leave the app: a stored `javascript:` bookmark must never run here. */
export function openExternal(
  url: string,
  newTab: boolean,
  open: (url: string, newTab: boolean) => void = defaultOpenUrl,
): boolean {
  if (!safeHttpUrl(url)) return false;
  open(url, newTab);
  return true;
}

/**
 * The dashboard search bar. Queries every feature's `searchProvider` (debounced), shows the
 * results grouped by feature, and acts on Enter:
 *   Enter            the active option (starts on the top one; a typed address comes first)
 *   Ctrl/Cmd+Enter   web search with the configured engine
 *   Alt+Enter        like Enter, in a new tab
 * With no results the web search is the only option, so Enter always does something.
 */
export function SearchBar({
  query,
  onQueryChange,
  engine,
  openUrl = defaultOpenUrl,
}: SearchBarProps) {
  const { searchProviders } = useFeatures();
  const navigate = useNavigate();
  const phone = useIsPhone();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const [groups, setGroups] = useState<ProviderResults[]>([]);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const seq = useRef(0);

  // Focus on load, but never on a phone: it would pop the keyboard over the dashboard.
  useEffect(() => {
    if (!phone) inputRef.current?.focus();
    // Only on first render: later phone/desktop flips must not steal focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useHotkeys({ '/': () => inputRef.current?.focus() });

  // Debounced provider search; late answers from an older query are ignored.
  useEffect(() => {
    const q = query.trim();
    const mine = ++seq.current;
    if (!q) {
      setGroups([]);
      return;
    }
    const timer = setTimeout(async () => {
      const settled = await Promise.allSettled(
        searchProviders.map(async (p): Promise<ProviderResults> => {
          const results = await p.search(q, PER_PROVIDER);
          return { providerId: p.id, label: p.label, colour: colourForLabel(p.label), results };
        }),
      );
      if (mine !== seq.current) return;
      setGroups(settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : [])));
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, searchProviders]);

  const options = useMemo(() => buildOptions(query, groups, engine), [query, groups, engine]);
  // Keep the cursor on the first option whenever the list changes under the user.
  useEffect(() => setActive(0), [options.length, query]);
  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const showList = open && options.length > 0;

  const activate = (option: SearchOption | undefined, newTab: boolean) => {
    if (!option) return;
    if (option.internal) {
      if (newTab) window.open(new URL(option.href, window.location.origin).href, '_blank');
      else void navigate(option.href);
    } else {
      openExternal(option.href, newTab, openUrl);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (options.length === 0) return;
      e.preventDefault();
      setOpen(true);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((a) => (a + step + options.length) % options.length);
    } else if (e.key === 'Enter') {
      if (e.nativeEvent.isComposing || !query.trim()) return;
      e.preventDefault();
      const mod = e.ctrlKey || e.metaKey;
      activate(pickOption(options, active, { mod }), e.altKey);
    } else if (e.key === 'Escape') {
      if (query) {
        e.preventDefault();
        e.stopPropagation();
        onQueryChange('');
      } else {
        inputRef.current?.blur();
      }
    }
  };

  const activeId = showList ? `${listId}-${active}` : undefined;
  // Group header rows are inserted before the first option of each group.
  let lastGroup: string | undefined;

  return (
    <div className="relative min-w-0 flex-1">
      <div
        className={cx(
          'flex h-[34px] items-center gap-2 rounded-lg border border-line-strong bg-surface px-2.5 shadow-sm transition-shadow',
          'focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--wf-accent-soft)]',
          'max-sm:h-[44px]',
        )}
      >
        <Search aria-hidden className="size-4 shrink-0 text-fg-3" />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label="Search your pages or the web"
          aria-expanded={showList}
          aria-controls={listId}
          aria-activedescendant={activeId}
          aria-autocomplete="list"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="search"
          placeholder="Search bookmarks, notes, tasks, wiki… or the web"
          value={query}
          onChange={(e) => {
            onQueryChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-fg-3 max-sm:text-[16px]"
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear search"
            // Keep the input focused.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onQueryChange('');
              inputRef.current?.focus();
            }}
            className="rounded-sm p-0.5 text-fg-3 hover:bg-surface-2 hover:text-fg"
          >
            <X aria-hidden className="size-3.5" />
          </button>
        ) : (
          !phone && <Kbd>/</Kbd>
        )}
      </div>

      <ul
        id={listId}
        ref={listRef}
        role="listbox"
        aria-label="Search results"
        hidden={!showList}
        // Clicking an option must not blur the input first (which would close the list).
        onMouseDown={(e) => e.preventDefault()}
        className="scroll-thin absolute inset-x-0 top-full z-30 mt-1 max-h-[min(70vh,28rem)] overflow-auto rounded-lg border border-line-strong bg-surface py-1 shadow-lg"
      >
        {options.map((o, i) => {
          const header = o.kind === 'result' && o.group !== lastGroup ? o.group : undefined;
          if (o.kind === 'result') lastGroup = o.group;
          const colour = o.colour ?? (o.group ? colourForLabel(o.group) : undefined);
          const Icon = o.icon;
          return (
            <Fragment key={o.key}>
              {header && (
                <li
                  role="presentation"
                  style={colourStyle(colourForLabel(header))}
                  className="label-caps mt-0.5 flex items-center gap-1.5 px-2.5 pb-0.5 pt-1 text-[color:var(--c)]"
                >
                  <span aria-hidden className="size-1.5 rounded-full bg-[var(--c)]" />
                  {header}
                </li>
              )}
              {o.kind === 'web' && options.length > 1 && (
                <li role="presentation" className="my-1 border-t border-line" />
              )}
              <li
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                style={colour ? colourStyle(colour) : undefined}
                onMouseMove={() => i !== active && setActive(i)}
                onClick={(e) => activate(o, e.altKey)}
                className={cx(
                  'mx-1 flex min-h-[26px] cursor-pointer items-center gap-2 rounded-md px-2 text-sm max-sm:min-h-[44px]',
                  i === active ? 'bg-accent-soft' : 'hover:bg-surface-2',
                )}
              >
                {o.kind === 'web' || o.kind === 'url' ? (
                  <Globe aria-hidden className="size-3.5 shrink-0 text-fg-3" />
                ) : Icon ? (
                  <Icon className="size-3.5 shrink-0 text-[color:var(--c)]" />
                ) : (
                  <span aria-hidden className="size-2 shrink-0 rounded-full bg-[var(--c)]" />
                )}
                <span className="min-w-0 flex-1 truncate">{o.title}</span>
                {o.subtitle && (
                  <span className="max-w-[45%] shrink-0 truncate text-xs text-fg-3">
                    {o.subtitle}
                  </span>
                )}
                {i === active && (
                  <CornerDownLeft aria-hidden className="size-3 shrink-0 text-fg-3" />
                )}
              </li>
            </Fragment>
          );
        })}
        <li
          role="presentation"
          className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 border-t border-line px-2.5 pt-1 text-2xs text-fg-3 max-sm:hidden"
        >
          <span>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> move
          </span>
          <span>
            <Kbd>Enter</Kbd> open
          </span>
          <span>
            <Kbd>Ctrl/⌘ Enter</Kbd> web search
          </span>
          <span>
            <Kbd>Alt Enter</Kbd> new tab
          </span>
        </li>
      </ul>
    </div>
  );
}
