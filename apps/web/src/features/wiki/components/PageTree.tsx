import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { sortKeyBetween } from '@webfront/shared';
import { ChevronRight, FileText, Plus, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import { IconButton, colourStyle, cx, useIsPhone } from '@/ui';
import { movePage, nudgePage, type WikiPage } from '../data';
import { buildTree, flattenTree, type TreeNode } from '../lib/tree';
import { searchWiki, type WikiHit } from '../search';

const INDENT = 12;
const COLLAPSED_KEY = 'webfront.wiki.collapsed';

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

type Node = TreeNode<WikiPage>;

/** Where a dragged row would land: depth from the horizontal offset, parent and sort key. */
export function projectDrop(
  items: readonly Node[],
  activeId: string,
  overId: string,
  offsetX: number,
): { depth: number; parentId: string | null; sortKey: string } | null {
  const from = items.findIndex((n) => n.page.id === activeId);
  const to = items.findIndex((n) => n.page.id === overId);
  if (from < 0 || to < 0) return null;
  const moved = arrayMove([...items], from, to);
  const active = items[from]!;
  const prev = moved[to - 1];
  const next = moved[to + 1];
  const wanted = active.depth + Math.round(offsetX / INDENT);
  const maxDepth = prev ? prev.depth + 1 : 0;
  const minDepth = next ? next.depth : 0;
  const depth = Math.max(minDepth, Math.min(maxDepth, wanted, 12));
  let parentId: string | null = null;
  if (depth > 0 && prev) {
    if (depth === prev.depth + 1) parentId = prev.page.id;
    else {
      for (let i = to - 1; i >= 0; i--) {
        const n = moved[i]!;
        if (n.depth === depth) {
          parentId =
            n.page.parentId && items.some((x) => x.page.id === n.page.parentId)
              ? n.page.parentId
              : null;
          break;
        }
        if (n.depth < depth) {
          parentId = n.page.id;
          break;
        }
      }
    }
  }
  // Siblings in the new order around the drop position.
  let before: Node | undefined;
  for (let i = to - 1; i >= 0; i--) {
    const n = moved[i]!;
    if (n.depth < depth) break;
    if (n.depth === depth) {
      before = n;
      break;
    }
  }
  let after: Node | undefined;
  for (let i = to + 1; i < moved.length; i++) {
    const n = moved[i]!;
    if (n.depth < depth) break;
    if (n.depth === depth) {
      after = n;
      break;
    }
  }
  const lo = before?.page.sortKey ?? null;
  let hi = after?.page.sortKey ?? null;
  if (lo !== null && hi !== null && lo >= hi) hi = null;
  return { depth, parentId, sortKey: sortKeyBetween(lo, hi) };
}

export interface PageTreeProps {
  pages: readonly WikiPage[];
  activeId: string | null;
  onNavigate?: () => void;
  onNewChild: (parentId: string | null) => void;
  /** Focus the search box (e.g. from the "Search wiki" command). */
  focusSearch?: number;
}

export function PageTree({ pages, activeId, onNavigate, onNewChild, focusSearch }: PageTreeProps) {
  const navigate = useNavigate();
  const phone = useIsPhone();
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<WikiHit[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [offsetX, setOffsetX] = useState(0);
  const [overId, setOverId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(activeId);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focusSearch) searchRef.current?.focus();
  }, [focusSearch]);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
    } catch {
      // ignore
    }
  }, [collapsed]);

  const tree = useMemo(() => buildTree(pages), [pages]);
  // Keep the active page visible: expand its ancestors.
  useEffect(() => {
    if (!activeId) return;
    const byId = new Map(pages.map((p) => [p.id, p]));
    let cur = byId.get(activeId)?.parentId ?? null;
    const open: string[] = [];
    while (cur) {
      if (collapsed.has(cur)) open.push(cur);
      cur = byId.get(cur)?.parentId ?? null;
    }
    if (open.length) setCollapsed((c) => new Set([...c].filter((x) => !open.includes(x))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const visible = useMemo(() => {
    const hide = new Set(collapsed);
    if (dragId) hide.add(dragId); // a dragged page carries its subtree
    return flattenTree(tree, hide);
  }, [tree, collapsed, dragId]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void searchWiki(q, 30).then((h) => {
        if (!cancelled) setHits(h);
      });
    }, 80);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, pages]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
  );

  const go = (p: WikiPage) => {
    void navigate(`/wiki/${p.slug}`);
    onNavigate?.();
  };

  const toggle = (id: string) =>
    setCollapsed((c) => {
      const n = new Set(c);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const focusRow = (id: string) => {
    setFocusId(id);
    requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-row="${id}"]`)?.focus();
    });
  };

  const onRowKey = (e: KeyboardEvent<HTMLElement>, node: Node, index: number) => {
    const id = node.page.id;
    const hasKids = node.children.length > 0;
    if (e.altKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
      const dir = {
        ArrowUp: 'up',
        ArrowDown: 'down',
        ArrowLeft: 'outdent',
        ArrowRight: 'indent',
      } as const;
      void nudgePage(id, dir[e.key as keyof typeof dir]).then(() => focusRow(id));
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (visible[index + 1]) focusRow(visible[index + 1]!.page.id);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (visible[index - 1]) focusRow(visible[index - 1]!.page.id);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (hasKids && collapsed.has(id)) toggle(id);
        else if (hasKids) focusRow(node.children[0]!.page.id);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (hasKids && !collapsed.has(id)) toggle(id);
        else if (node.page.parentId && visible.some((n) => n.page.id === node.page.parentId))
          focusRow(node.page.parentId);
        break;
      case 'Home':
        e.preventDefault();
        if (visible[0]) focusRow(visible[0].page.id);
        break;
      case 'End':
        e.preventDefault();
        if (visible.length) focusRow(visible[visible.length - 1]!.page.id);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        go(node.page);
        break;
    }
  };

  const projection = dragId && overId ? projectDrop(visible, dragId, overId, offsetX) : null;

  const onDragStart = (e: DragStartEvent) => {
    setDragId(String(e.active.id));
    setOverId(String(e.active.id));
    setOffsetX(0);
  };
  const onDragMove = (e: DragMoveEvent) => {
    setOffsetX(e.delta.x);
    if (e.over) setOverId(String(e.over.id));
  };
  const reset = () => {
    setDragId(null);
    setOverId(null);
    setOffsetX(0);
  };
  const onDragEnd = (e: DragEndEvent) => {
    const id = String(e.active.id);
    const over = e.over ? String(e.over.id) : null;
    const p = over ? projectDrop(visible, id, over, e.delta.x) : null;
    reset();
    if (!p) return;
    const page = pages.find((x) => x.id === id);
    if (
      !page ||
      (page.parentId === p.parentId && over === id && Math.round(e.delta.x / INDENT) === 0)
    )
      return;
    void movePage(id, p.parentId, p.sortKey);
    if (p.parentId) setCollapsed((c) => new Set([...c].filter((x) => x !== p.parentId)));
  };

  const dragged = dragId ? pages.find((p) => p.id === dragId) : null;
  const tabStop =
    focusId && visible.some((n) => n.page.id === focusId)
      ? focusId
      : (activeId ?? visible[0]?.page.id);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-line p-1.5">
        <div className="relative flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-1.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-3"
          />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && hits?.[0]) go(hits[0].page);
              if (e.key === 'Escape') setQuery('');
            }}
            placeholder="Search wiki…"
            aria-label="Search wiki pages"
            className="h-[26px] w-full rounded-md border border-line bg-bg pl-6 pr-1.5 text-xs outline-none focus:border-accent max-sm:h-9"
          />
        </div>
        <IconButton
          label="New top-level page"
          size="sm"
          icon={<Plus />}
          onClick={() => onNewChild(null)}
        />
      </div>

      {hits ? (
        <div
          className="scroll-thin min-h-0 flex-1 overflow-auto p-1"
          role="list"
          aria-label="Search results"
        >
          {hits.length === 0 ? (
            <p className="px-2 py-2 text-xs text-fg-3">No pages match “{query}”.</p>
          ) : (
            hits.map((h) => (
              <button
                key={h.page.id}
                type="button"
                role="listitem"
                onClick={() => go(h.page)}
                className="block w-full rounded-md px-2 py-1 text-left hover:bg-surface-2"
              >
                <span className="block truncate text-sm font-medium">{h.page.title}</span>
                {h.snippet && <span className="block truncate text-xs text-fg-3">{h.snippet}</span>}
              </button>
            ))
          )}
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="mt-1 flex items-center gap-1 px-2 text-xs text-fg-3 hover:text-fg"
            >
              <X aria-hidden className="size-3" /> Clear search
            </button>
          )}
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={onDragStart}
          onDragMove={onDragMove}
          onDragOver={(e) => setOverId(e.over ? String(e.over.id) : null)}
          onDragEnd={onDragEnd}
          onDragCancel={reset}
        >
          <SortableContext
            items={visible.map((n) => n.page.id)}
            strategy={verticalListSortingStrategy}
          >
            <div
              ref={listRef}
              role="tree"
              aria-label="Wiki pages"
              className="scroll-thin min-h-0 flex-1 overflow-auto py-1"
            >
              {visible.length === 0 && <p className="px-3 py-2 text-xs text-fg-3">No pages yet.</p>}
              {visible.map((node, i) => (
                <TreeRow
                  key={node.page.id}
                  node={node}
                  index={i}
                  active={node.page.id === activeId}
                  collapsed={collapsed.has(node.page.id)}
                  tabbable={node.page.id === tabStop}
                  phone={phone}
                  depthOverride={node.page.id === dragId && projection ? projection.depth : null}
                  onToggle={() => toggle(node.page.id)}
                  onOpen={() => go(node.page)}
                  onFocus={() => setFocusId(node.page.id)}
                  onKeyDown={(e) => onRowKey(e, node, i)}
                  onNewChild={() => onNewChild(node.page.id)}
                />
              ))}
            </div>
          </SortableContext>
          <DragOverlay dropAnimation={null}>
            {dragged ? (
              <div className="flex h-6 items-center gap-1 rounded-md border border-line-strong bg-surface px-2 text-sm shadow-md">
                <FileText aria-hidden className="size-3.5 text-fg-3" />
                {dragged.title}
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}
      <p className="hidden border-t border-line px-2 py-1 text-[11px] text-fg-3 sm:block">
        Drag to move · Alt+arrows move the focused page
      </p>
    </div>
  );
}

function TreeRow({
  node,
  index,
  active,
  collapsed,
  tabbable,
  phone,
  depthOverride,
  onToggle,
  onOpen,
  onFocus,
  onKeyDown,
  onNewChild,
}: {
  node: Node;
  index: number;
  active: boolean;
  collapsed: boolean;
  tabbable: boolean;
  phone: boolean;
  depthOverride: number | null;
  onToggle: () => void;
  onOpen: () => void;
  onFocus: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  onNewChild: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: node.page.id,
  });
  const depth = depthOverride ?? node.depth;
  const hasKids = node.children.length > 0;
  const top = node.depth === 0;
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        ...colourStyle(node.colour),
      }}
      className={cx('group/row relative', isDragging && 'opacity-40')}
    >
      <div
        {...attributes}
        {...listeners}
        role="treeitem"
        aria-roledescription={undefined}
        aria-level={node.depth + 1}
        aria-selected={active}
        aria-expanded={hasKids ? !collapsed : undefined}
        aria-posinset={index + 1}
        data-row={node.page.id}
        tabIndex={tabbable ? 0 : -1}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        onClick={onOpen}
        className={cx(
          'mx-1 flex cursor-pointer select-none items-center gap-0.5 rounded-md pr-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent',
          phone ? 'min-h-10' : 'h-6',
          active
            ? 'bg-[var(--c-soft,var(--wf-accent-soft))] font-medium text-fg'
            : 'text-fg-2 hover:bg-surface-2 hover:text-fg',
          top && 'font-medium text-fg',
        )}
        style={{ paddingLeft: `${4 + depth * INDENT}px` }}
      >
        <span
          aria-hidden
          className={cx(
            'absolute inset-y-1 left-1 w-[3px] rounded-full',
            node.colour ? 'bg-[var(--c)]' : 'bg-transparent',
            !top && 'opacity-50',
          )}
        />
        {hasKids ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label={collapsed ? `Expand ${node.page.title}` : `Collapse ${node.page.title}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            onPointerDown={(e) => e.stopPropagation()}
            className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-fg-3 hover:bg-surface-3 hover:text-fg max-sm:size-8"
          >
            <ChevronRight
              aria-hidden
              className={cx('size-3.5 transition-transform', !collapsed && 'rotate-90')}
            />
          </button>
        ) : (
          <span
            aria-hidden
            className="inline-flex size-4 shrink-0 items-center justify-center max-sm:size-8"
          >
            <FileText
              className={cx('size-3', node.colour ? 'text-[color:var(--c)]' : 'text-fg-3')}
            />
          </span>
        )}
        <span
          className={cx('min-w-0 flex-1 truncate', top && node.colour && 'text-[color:var(--c)]')}
        >
          {node.page.title}
        </span>
        <button
          type="button"
          tabIndex={-1}
          aria-label={`New page inside ${node.page.title}`}
          title="New page inside"
          onClick={(e) => {
            e.stopPropagation();
            onNewChild();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-fg-3 opacity-0 hover:bg-surface-3 hover:text-fg group-hover/row:opacity-100 max-sm:hidden"
        >
          <Plus aria-hidden className="size-3" />
        </button>
      </div>
    </div>
  );
}
