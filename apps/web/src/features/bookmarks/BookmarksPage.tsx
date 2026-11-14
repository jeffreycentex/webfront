import type { LinkCheckResult } from '@webfront/shared';
import { safeHttpUrl } from '@webfront/shared';
import { Bookmark as BookmarkIcon, FolderPlus, Link2Off, Plus, Search, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  IconButton,
  Input,
  isEditableTarget,
  PageHeader,
  Skeleton,
  Spinner,
  Tooltip,
  useOnline,
  useToast,
} from '@/ui';
import { useBookmarkActions } from './actions';
import { checkLinks } from './api';
import { BookmarkColumns } from './BookmarkColumns';
import { BookmarkDetails } from './BookmarkDetails';
import { BookmarkForm } from './BookmarkForm';
import { CategoryForm } from './CategoryForm';
import { useBookmarks, useCategories, useStatuses, useTagColours } from './data';
import { MoveDialog } from './MoveDialog';
import {
  buildSections,
  displayOrder,
  filterSections,
  normaliseUrl,
  rankBookmarks,
  type Bookmark,
  type Category,
} from './model';
import { loadCollapsed, saveCollapsed } from './storage';

type BookmarkFormState = {
  bookmark: Bookmark | null;
  defaults?: { url?: string; categoryId?: string | null };
};
type CategoryFormState = { category: Category | null; parentId?: string | null };

function openUrl(url: string) {
  // Only http(s): a stored `javascript:` or `data:` URL must never be opened.
  if (safeHttpUrl(url)) window.open(url, '_blank', 'noopener,noreferrer');
}

export function BookmarksPage() {
  const categories = useCategories();
  const bookmarks = useBookmarks();
  const statuses = useStatuses();
  const tagColours = useTagColours();
  const online = useOnline();
  const { toast } = useToast();
  const actions = useBookmarkActions();
  const [params, setParams] = useSearchParams();

  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [bookmarkForm, setBookmarkForm] = useState<BookmarkFormState | null>(null);
  const [categoryForm, setCategoryForm] = useState<CategoryFormState | null>(null);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [moving, setMoving] = useState<Bookmark | null>(null);
  const [deletingCategory, setDeletingCategory] = useState<Category | null>(null);
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [linkResults, setLinkResults] = useState<Map<string, LinkCheckResult>>(new Map());
  const [checking, setChecking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const cats = categories ?? [];
  const items = bookmarks ?? [];
  const allSections = useMemo(() => buildSections(cats, items), [cats, items]);
  const ranked = useMemo(
    () => (query.trim() ? rankBookmarks(displayOrder(allSections), cats, query) : null),
    [query, allSections, cats],
  );
  const sections = useMemo(
    () =>
      ranked ? filterSections(allSections, new Set(ranked.map((r) => r.bookmark.id))) : allSections,
    [ranked, allSections],
  );
  const order = useMemo(() => displayOrder(sections), [sections]);
  const activeId =
    cursor && order.some((b) => b.id === cursor) ? cursor : (ranked?.[0]?.bookmark.id ?? null);

  useEffect(() => setCursor(null), [query]);
  useEffect(() => {
    if (!activeId) return;
    document
      .querySelector(`[data-bookmark-id="${CSS.escape(activeId)}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId, cursor]);

  const overlayOpen = Boolean(
    bookmarkForm || categoryForm || detailsId || moving || deletingCategory,
  );

  const step = useCallback(
    (delta: 1 | -1) => {
      if (order.length === 0) return;
      const i = activeId ? order.findIndex((b) => b.id === activeId) : -1;
      const next =
        i < 0
          ? delta === 1
            ? 0
            : order.length - 1
          : Math.min(order.length - 1, Math.max(0, i + delta));
      setCursor(order[next]?.id ?? null);
    },
    [order, activeId],
  );

  const openActive = useCallback(() => {
    const b = order.find((x) => x.id === activeId);
    if (b) openUrl(b.url);
  }, [order, activeId]);

  // Type anywhere to filter; arrows and Enter work when nothing is focused.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || overlayOpen || e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      if (isEditableTarget(e.target)) return;
      const onBody = e.target === document.body || e.target === document.documentElement;
      if (e.key === 'ArrowDown' && onBody) (e.preventDefault(), step(1));
      else if (e.key === 'ArrowUp' && onBody) (e.preventDefault(), step(-1));
      else if (e.key === 'Enter' && onBody && activeId) (e.preventDefault(), openActive());
      else if (e.key === 'Escape' && query) setQuery('');
      else if (e.key === '/') {
        e.preventDefault();
        inputRef.current?.focus();
      } else if (
        e.key.length === 1 &&
        e.key !== ' ' &&
        e.key !== '?' &&
        !(e.key === 'g' && !query)
      ) {
        // Focus the filter; the keystroke then lands in it.
        inputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [overlayOpen, step, openActive, activeId, query]);

  // Paste a URL anywhere: start a new bookmark with it.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (overlayOpen || isEditableTarget(e.target)) return;
      const url = normaliseUrl(e.clipboardData?.getData('text') ?? '');
      if (url) {
        e.preventDefault();
        setBookmarkForm({ bookmark: null, defaults: { url } });
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [overlayOpen]);

  // `?new=bookmark|category` and `?check=1` come from the command palette.
  useEffect(() => {
    const what = params.get('new');
    const check = params.get('check');
    if (!what && !check) return;
    if (what === 'bookmark') setBookmarkForm({ bookmark: null });
    else if (what === 'category') setCategoryForm({ category: null });
    if (check) void runCheck();
    setParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const onFilterKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      openActive();
    } else if (e.key === 'ArrowDown') (e.preventDefault(), step(1));
    else if (e.key === 'ArrowUp') (e.preventDefault(), step(-1));
    else if (e.key === 'Escape') {
      e.stopPropagation();
      setQuery('');
      inputRef.current?.blur();
    }
  };

  const toggleCollapsed = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      saveCollapsed(next);
      return next;
    });

  async function runCheck() {
    setChecking(true);
    try {
      const res = await checkLinks();
      setLinkResults(new Map(res.results.map((r) => [r.id, r])));
      const dead = res.results.filter((r) => r.state === 'dead').length;
      const moved = res.results.filter((r) => r.state === 'redirected').length;
      toast({
        title: dead + moved === 0 ? 'All links look fine' : `${dead} dead, ${moved} moved`,
        tone: dead > 0 ? 'warning' : 'success',
      });
    } catch {
      toast({ title: 'Link check failed', description: 'Is the server reachable?', tone: 'error' });
    } finally {
      setChecking(false);
    }
  }

  const problems = [...linkResults.values()].filter((r) => r.state !== 'ok');
  const details = items.find((b) => b.id === detailsId) ?? null;
  const detailsCategory = details?.categoryId
    ? cats.find((c) => c.id === details.categoryId)?.name
    : undefined;
  const loading = categories === undefined || bookmarks === undefined;
  const empty = !loading && cats.length === 0 && items.length === 0;

  return (
    <div>
      <PageHeader
        title="Bookmarks"
        icon={<BookmarkIcon />}
        actions={
          <>
            <Tooltip label={online ? 'Ask the server to test every link' : 'Needs a connection'}>
              <span>
                <Button
                  size="sm"
                  disabled={!online || checking || items.length === 0}
                  onClick={() => void runCheck()}
                >
                  {checking ? (
                    <Spinner label="Checking links" className="size-3" />
                  ) : (
                    <Link2Off aria-hidden className="size-3.5" />
                  )}
                  Check links
                </Button>
              </span>
            </Tooltip>
            <Button size="sm" onClick={() => setCategoryForm({ category: null })}>
              <FolderPlus aria-hidden className="size-3.5" /> Category
            </Button>
            <Button size="sm" variant="primary" onClick={() => setBookmarkForm({ bookmark: null })}>
              <Plus aria-hidden className="size-3.5" /> Bookmark
            </Button>
          </>
        }
      >
        <div className="relative max-w-sm flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-fg-3"
          />
          <Input
            ref={inputRef}
            type="search"
            aria-label="Filter bookmarks"
            placeholder="Type to filter…  (/ to focus)"
            autoComplete="off"
            spellCheck={false}
            className="pl-7 pr-7"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onFilterKey}
          />
          {query && (
            <IconButton
              size="sm"
              label="Clear filter"
              shortcut="escape"
              icon={<X />}
              className="absolute right-0.5 top-1/2 -translate-y-1/2"
              onClick={() => setQuery('')}
            />
          )}
        </div>
      </PageHeader>

      {problems.length > 0 && (
        <p
          role="status"
          className="mb-2 flex items-center gap-2 rounded-md bg-warn-soft px-2 py-1 text-sm text-warn-text"
        >
          {problems.filter((r) => r.state === 'dead').length} dead and{' '}
          {problems.filter((r) => r.state === 'redirected').length} moved links are marked with a
          warning triangle.
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => setLinkResults(new Map())}
          >
            Dismiss
          </Button>
        </p>
      )}

      {loading ? (
        <div className="[column-gap:0.5rem] [column-width:18rem]">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="mb-2 h-40 w-full break-inside-avoid" />
          ))}
        </div>
      ) : empty ? (
        <EmptyState
          icon={<BookmarkIcon />}
          title="No bookmarks yet"
          action={
            <span className="flex gap-2">
              <Button variant="primary" onClick={() => setCategoryForm({ category: null })}>
                <FolderPlus aria-hidden className="size-3.5" /> Add your first category
              </Button>
              <Button onClick={() => setBookmarkForm({ bookmark: null })}>Add a bookmark</Button>
            </span>
          }
        >
          Group links into coloured categories, or paste a link anywhere on this page to save it.
        </EmptyState>
      ) : sections.length === 0 ? (
        <EmptyState icon={<Search />} title="No matches">
          Nothing matches “{query}”. Press Escape to clear the filter.
        </EmptyState>
      ) : (
        <BookmarkColumns
          sections={sections}
          allSections={allSections}
          statuses={statuses}
          tagColours={tagColours}
          activeId={activeId}
          linkResults={linkResults}
          dragEnabled={!query.trim()}
          collapsed={collapsed}
          onToggleCollapsed={toggleCollapsed}
          onDetails={(b) => setDetailsId(b.id)}
          onEditBookmark={(b) => setBookmarkForm({ bookmark: b })}
          onDeleteBookmark={(b) => void actions.deleteBookmark(b)}
          onMoveBookmark={setMoving}
          onAddBookmark={(categoryId) =>
            setBookmarkForm({ bookmark: null, defaults: { categoryId } })
          }
          onEditCategory={(c) => setCategoryForm({ category: c })}
          onAddSubcategory={(c) => setCategoryForm({ category: null, parentId: c.id })}
          onDeleteCategory={setDeletingCategory}
        />
      )}

      <BookmarkForm
        open={bookmarkForm !== null}
        onClose={() => setBookmarkForm(null)}
        bookmark={bookmarkForm?.bookmark ?? null}
        defaults={bookmarkForm?.defaults ?? {}}
        categories={cats}
        bookmarks={items}
        tagColours={tagColours}
      />
      <CategoryForm
        open={categoryForm !== null}
        onClose={() => setCategoryForm(null)}
        category={categoryForm?.category ?? null}
        parentId={categoryForm?.parentId ?? null}
        categories={cats}
      />
      <MoveDialog
        bookmark={moving}
        categories={cats}
        bookmarks={items}
        onClose={() => setMoving(null)}
      />
      <BookmarkDetails
        bookmark={details}
        categoryName={detailsCategory}
        status={details ? statuses.get(details.id) : undefined}
        tagColours={tagColours}
        onClose={() => setDetailsId(null)}
        onEdit={(b) => {
          setDetailsId(null);
          setBookmarkForm({ bookmark: b });
        }}
        onDelete={(b) => void actions.deleteBookmark(b)}
      />
      <ConfirmDialog
        open={deletingCategory !== null}
        danger
        title={`Delete “${deletingCategory?.name ?? ''}”?`}
        description="Its bookmarks stay and move to Uncategorised. You can undo this right after."
        confirmLabel="Delete"
        onCancel={() => setDeletingCategory(null)}
        onConfirm={async () => {
          if (deletingCategory) await actions.deleteCategory(deletingCategory);
          setDeletingCategory(null);
        }}
      />
    </div>
  );
}
