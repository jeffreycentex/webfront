import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { useCollection } from '@/data';
import { Button, Drawer, EmptyState, Spinner, useIsPhone, useToast } from '@/ui';
import { NewPageDialog } from './components/Dialogs';
import { PageTree } from './components/PageTree';
import { PageView } from './components/PageView';
import { WikiHome } from './components/WikiHome';
import { createPage, findBySlug, type WikiPage as Page } from './data';
import { onReconciled, reconcileNow } from './runtime';

/**
 * `/wiki/*`: page tree on the left (a drawer on phones), the page (or the wiki home) on the
 * right. Query parameters: `?new=1[&title=…]` opens the new-page dialog, `?search=1` focuses
 * the search box, `?edit=1` opens a page in the editor.
 */
export function WikiPage() {
  const params = useParams();
  const slug = (params['*'] ?? '').split('/')[0] ?? '';
  const pages = useCollection('wikiPages');
  const phone = useIsPhone();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [search, setSearch] = useSearchParams();
  const [treeOpen, setTreeOpen] = useState(false);
  const [newDialog, setNewDialog] = useState<{ title: string; parentId: string | null } | null>(
    null,
  );
  const [focusSearch, setFocusSearch] = useState(0);
  // `?edit=1` opens the page in the editor; remembered for this slug while the param is removed.
  const editFor = useRef<string | null>(null);
  if (search.get('edit') === '1') editFor.current = slug;
  else if (editFor.current !== slug) editFor.current = null;

  // Query-parameter actions (from commands and links).
  useEffect(() => {
    let changed = false;
    if (search.get('new')) {
      setNewDialog({ title: search.get('title') ?? '', parentId: search.get('parent') });
      search.delete('new');
      search.delete('title');
      search.delete('parent');
      changed = true;
    }
    if (search.get('search')) {
      if (phone) setTreeOpen(true);
      setFocusSearch((n) => n + 1);
      search.delete('search');
      changed = true;
    }
    if (search.get('edit')) {
      search.delete('edit');
      changed = true;
    }
    if (changed) setSearch(search, { replace: true });
  }, [search, setSearch, phone]);

  // Pick up merges of concurrent edits promptly while the wiki is open, and say so.
  useEffect(() => {
    void reconcileNow();
  }, [pages]);
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  useEffect(
    () =>
      onReconciled((id, kind) => {
        const title = pagesRef.current?.find((p) => p.id === id)?.title ?? 'a page';
        toast(
          kind === 'merged'
            ? { title: `Merged edits from another device into “${title}”`, tone: 'success' }
            : {
                title: `Edit conflict on “${title}”`,
                description: 'Both versions are kept; open the page to choose.',
                tone: 'warning',
              },
        );
      }),
    [toast],
  );

  const found = useMemo(() => (pages && slug ? findBySlug(pages, slug) : {}), [pages, slug]);

  const onCreatePage = async (title: string, contextId: string | null = null) => {
    if (!pages) return;
    if (!title.trim()) {
      setNewDialog({ title: '', parentId: contextId });
      return;
    }
    // Clicked a link to a missing page: create it next to the page that links to it.
    const context = pages.find((p) => p.id === contextId);
    const page = await createPage({ title, parentId: context?.parentId ?? null });
    toast({ title: `Created “${page.title}”`, tone: 'success' });
    void navigate(`/wiki/${page.slug}?edit=1`);
  };

  if (!pages) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (found.redirect) return <Navigate to={`/wiki/${found.redirect.slug}`} replace />;

  const page: Page | undefined = found.page;
  const tree = (
    <PageTree
      pages={pages}
      activeId={page?.id ?? null}
      focusSearch={focusSearch}
      onNavigate={() => setTreeOpen(false)}
      onNewChild={(parentId) => {
        setTreeOpen(false);
        setNewDialog({ title: '', parentId });
      }}
    />
  );

  let content;
  if (!slug) {
    content = (
      <WikiHome
        pages={pages}
        onNew={() => setNewDialog({ title: '', parentId: null })}
        onOpenTree={phone ? () => setTreeOpen(true) : undefined}
      />
    );
  } else if (!page) {
    content = (
      <EmptyState
        title="Page not found"
        action={
          <Button
            variant="primary"
            size="sm"
            onClick={() => setNewDialog({ title: slug.replace(/-/g, ' '), parentId: null })}
          >
            Create “{slug.replace(/-/g, ' ')}”
          </Button>
        }
      >
        No wiki page has the address /wiki/{slug}.
      </EmptyState>
    );
  } else {
    content = (
      <PageView
        key={page.id}
        page={page}
        pages={pages}
        initialMode={editFor.current === slug ? 'split' : 'read'}
        {...(phone ? { onOpenTree: () => setTreeOpen(true) } : {})}
        onCreatePage={(title, ctx) => void onCreatePage(title, ctx ?? null)}
      />
    );
  }

  return (
    <div className="-mx-3 -my-2.5 flex h-[calc(100%+1.25rem)] min-h-0 max-sm:-mx-2.5">
      {!phone && (
        <aside
          aria-label="Wiki pages"
          className="flex w-60 shrink-0 flex-col border-r border-line bg-surface lg:w-64"
        >
          {tree}
        </aside>
      )}
      <section className="scroll-thin min-h-0 min-w-0 flex-1 overflow-auto">{content}</section>
      {phone && (
        <Drawer open={treeOpen} onClose={() => setTreeOpen(false)} title="Wiki pages" side="left">
          <div className="-mx-3 -my-2 flex h-[70vh] flex-col">{tree}</div>
        </Drawer>
      )}
      <NewPageDialog
        open={newDialog !== null}
        pages={pages}
        initialTitle={newDialog?.title ?? ''}
        initialParentId={newDialog?.parentId ?? null}
        onClose={() => setNewDialog(null)}
        onCreated={(p) => {
          setNewDialog(null);
          void navigate(`/wiki/${p.slug}?edit=1`);
        }}
      />
    </div>
  );
}
