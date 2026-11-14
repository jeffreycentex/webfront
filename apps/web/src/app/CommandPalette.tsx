import { colourForLabel, safeHttpUrl } from '@webfront/shared';
import { CornerDownLeft, Search } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type ComponentType } from 'react';
import { useNavigate } from 'react-router';
import { useFeatures } from '../features/context';
import type { Command, IconProps, SearchResult } from '../features/types';
import { cx } from '../lib/cx';
import { Portal, Shortcut, colourStyle, useFocusTrap, useHotkeys } from '../ui';
import { scoreCommand } from './fuzzy';

export interface PaletteEntry {
  key: string;
  title: string;
  subtitle?: string | undefined;
  /** Right-aligned type label ("Command", "Go to", a provider label). */
  kind: string;
  shortcut?: string | undefined;
  icon?: ComponentType<IconProps> | undefined;
  colour?: SearchResult['colour'];
  score: number;
  run: () => void;
}

export interface PaletteProps {
  open: boolean;
  onClose: () => void;
  initialQuery?: string;
  /** Extra shell commands (theme, lock, sign out...) merged with every feature's `commands`. */
  extraCommands?: Command[];
}

const RESULT_LIMIT = 24;

/**
 * Global command palette (Ctrl/Cmd+K). Fed by every feature's `commands` and `searchProvider`,
 * plus "Go to" entries for the nav. Flat list ranked by score: type to filter, ArrowUp/Down,
 * Enter runs, Escape closes.
 */
export function CommandPalette({
  open,
  onClose,
  initialQuery = '',
  extraCommands = [],
}: PaletteProps) {
  if (!open) return null;
  return (
    <PaletteBody onClose={onClose} initialQuery={initialQuery} extraCommands={extraCommands} />
  );
}

function PaletteBody({
  onClose,
  initialQuery,
  extraCommands,
}: Omit<PaletteProps, 'open'> & { initialQuery: string; extraCommands: Command[] }) {
  const navigate = useNavigate();
  const { nav, commands, searchProviders } = useFeatures();
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<Array<SearchResult & { provider: string }>>([]);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  useFocusTrap(true, rootRef);
  useHotkeys({ escape: () => onClose() }, { allowInInput: true });

  // Provider search (debounced, ignores stale responses, never throws).
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      const settled = await Promise.allSettled(
        searchProviders.map(async (p) =>
          (await p.search(q, 8)).map((r) => ({ ...r, provider: p.label })),
        ),
      );
      if (cancelled) return;
      setResults(settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : [])));
    }, 60);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, searchProviders]);

  const entries = useMemo<PaletteEntry[]>(() => {
    const done = (fn: () => void) => () => {
      onClose();
      fn();
    };
    const all: PaletteEntry[] = [];
    for (const n of nav) {
      const score = scoreCommand(query, `Go to ${n.label}`, [n.label]);
      if (score > 0)
        all.push({
          key: `nav:${n.path}`,
          title: `Go to ${n.label}`,
          kind: 'Go to',
          shortcut: n.shortcut,
          icon: n.icon,
          colour: colourForLabel(n.label),
          score: score + 0.001,
          run: done(() => void navigate(n.path)),
        });
    }
    // The shell already generates "Go to <nav label>"; drop any command that duplicates one.
    const goTitles = new Set(nav.map((n) => `go to ${n.label}`.toLowerCase()));
    for (const c of [...extraCommands, ...commands]) {
      if (goTitles.has(c.title.trim().toLowerCase())) continue;
      const score = scoreCommand(query, c.title, c.keywords);
      if (score > 0)
        all.push({
          key: `cmd:${c.id}`,
          title: c.title,
          kind: 'Command',
          shortcut: c.shortcut,
          score,
          run: done(() => void c.run({ navigate })),
        });
    }
    for (const r of results) {
      all.push({
        key: `res:${r.provider}:${r.id}`,
        title: r.title,
        subtitle: r.subtitle,
        kind: r.provider,
        icon: r.icon,
        colour: r.colour,
        score: r.score,
        run: done(() => {
          if (r.external) {
            // Only http(s): a stored `javascript:` bookmark must never be opened.
            if (safeHttpUrl(r.href)) window.open(r.href, '_blank', 'noopener,noreferrer');
          } else void navigate(r.href);
        }),
      });
    }
    return all.sort((a, b) => b.score - a.score).slice(0, RESULT_LIMIT);
  }, [nav, commands, extraCommands, results, query, navigate, onClose]);

  useEffect(() => setActive(0), [query, results.length]);
  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (entries.length ? (a + 1) % entries.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (entries.length ? (a - 1 + entries.length) % entries.length : 0));
    } else if (e.key === 'Home' && e.ctrlKey) {
      setActive(0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      entries[active]?.run();
    }
  };

  return (
    <Portal>
      <div className="fixed inset-0 z-50 flex items-start justify-center px-3 pt-[10vh] max-sm:pt-[6vh]">
        <div
          aria-hidden
          onMouseDown={onClose}
          className="absolute inset-0 animate-[wf-fade-in_120ms_ease-out] bg-overlay"
        />
        <div
          ref={rootRef}
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
          onKeyDown={onKeyDown}
          className="relative flex max-h-[70dvh] w-full max-w-[640px] animate-[wf-pop-in_120ms_ease-out] flex-col overflow-hidden rounded-lg border border-line-strong bg-surface shadow-pop"
        >
          <div className="flex items-center gap-2 border-b border-line px-3">
            <Search aria-hidden className="size-4 shrink-0 text-fg-3" />
            <input
              data-autofocus
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={entries[active] ? `${listId}-${active}` : undefined}
              aria-autocomplete="list"
              aria-label="Search or run a command"
              placeholder="Search bookmarks, notes, tasks, pages, or run a command…"
              spellCheck={false}
              autoComplete="off"
              className="h-10 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-fg-3 max-sm:h-12"
            />
          </div>
          <ul
            id={listId}
            ref={listRef}
            role="listbox"
            className="scroll-thin min-h-0 flex-1 overflow-auto p-1"
          >
            {entries.map((e, i) => {
              const Icon = e.icon;
              return (
                <li
                  key={e.key}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseMove={() => i !== active && setActive(i)}
                  onClick={() => e.run()}
                  style={colourStyle(e.colour)}
                  className={cx(
                    'flex min-h-(--row-h) cursor-pointer items-center gap-2 rounded-md px-2 text-sm',
                    i === active && 'bg-accent-soft',
                  )}
                >
                  {Icon ? (
                    <Icon
                      className={cx(
                        'size-4 shrink-0',
                        e.colour ? 'text-[color:var(--c)]' : 'text-fg-3',
                      )}
                    />
                  ) : (
                    <span className="size-4 shrink-0" aria-hidden />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {e.title}
                    {e.subtitle && <span className="ml-2 text-xs text-fg-3">{e.subtitle}</span>}
                  </span>
                  {e.shortcut && <Shortcut spec={e.shortcut} />}
                  <span className="label-caps shrink-0 text-fg-3">{e.kind}</span>
                  {i === active && (
                    <CornerDownLeft aria-hidden className="size-3 shrink-0 text-fg-3" />
                  )}
                </li>
              );
            })}
            {entries.length === 0 && (
              <li className="px-3 py-6 text-center text-sm text-fg-3" role="presentation">
                {query.trim() ? `Nothing matches "${query.trim()}".` : 'Start typing…'}
              </li>
            )}
          </ul>
          <div className="flex items-center gap-3 border-t border-line bg-surface-2 px-3 py-1 text-xs text-fg-3 max-sm:hidden">
            <span>↑↓ select</span>
            <span>↵ open</span>
            <span>esc close</span>
          </div>
        </div>
      </div>
    </Portal>
  );
}
