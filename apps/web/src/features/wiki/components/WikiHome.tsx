import { BookOpen, FolderTree, Pin, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Button,
  ColourDot,
  EmptyState,
  IconButton,
  List,
  ListRow,
  PageHeader,
  Panel,
  formatRelativeShort,
} from '@/ui';
import { createPage, type WikiPage } from '../data';
import { buildTree, sectionColour } from '../lib/tree';

const HOME_BODY = `Welcome to your wiki. Some tips:

- Link pages with \`[[Page title]]\` or \`[[Page title|label]]\`; links to pages that do not exist yet show in red and create the page when clicked.
- Press **e** to edit, **Esc** to stop; everything saves automatically and works offline.
- Paste or drop images straight into the editor.
- Top-level pages are sections: give them a colour from the page menu.
`;

/** `/wiki`: first-run empty state, or pinned + recently edited pages and the sections. */
export function WikiHome({
  pages,
  onNew,
  onOpenTree,
}: {
  pages: readonly WikiPage[];
  onNew: () => void;
  onOpenTree?: (() => void) | undefined;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const recent = useMemo(
    () => [...pages].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 12),
    [pages],
  );
  const pinned = useMemo(() => pages.filter((p) => p.pinned), [pages]);
  const sections = useMemo(() => buildTree(pages), [pages]);

  if (pages.length === 0) {
    return (
      <div className="px-3 py-6">
        <EmptyState
          icon={<BookOpen className="size-6" />}
          title="Your wiki is empty"
          action={
            <Button
              variant="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const p = await createPage({ title: 'Home', body: HOME_BODY, colour: 'indigo' });
                  void navigate(`/wiki/${p.slug}`);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Create a Home page
            </Button>
          }
        >
          Write notes in Markdown, link them with [[double brackets]], and find everything with
          search.
        </EmptyState>
      </div>
    );
  }

  const row = (p: WikiPage, trailing?: string) => {
    const colour = sectionColour(pages, p.id);
    return (
      <ListRow
        key={p.id}
        onActivate={() => void navigate(`/wiki/${p.slug}`)}
        leading={colour ? <ColourDot colour={colour} /> : <span className="inline-block size-2" />}
        trailing={trailing}
      >
        {p.title}
      </ListRow>
    );
  };

  return (
    <div className="px-3 py-2 max-sm:px-2.5">
      <PageHeader
        title="Wiki"
        icon={<BookOpen className="size-4" />}
        actions={
          <>
            {onOpenTree && <IconButton label="Pages" icon={<FolderTree />} onClick={onOpenTree} />}
            <Button variant="primary" size="sm" onClick={onNew}>
              <Plus aria-hidden className="size-3.5" /> New page
            </Button>
          </>
        }
      >
        <span className="text-xs text-fg-3">
          {pages.length} page{pages.length === 1 ? '' : 's'} in {sections.length} section
          {sections.length === 1 ? '' : 's'}
        </span>
      </PageHeader>
      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Recently edited" colour="indigo">
          <List>{recent.map((p) => row(p, formatRelativeShort(p.updatedAt)))}</List>
        </Panel>
        <div className="flex flex-col gap-3">
          {pinned.length > 0 && (
            <Panel title="Pinned" colour="amber" icon={<Pin aria-hidden className="size-3.5" />}>
              <List>{pinned.map((p) => row(p))}</List>
            </Panel>
          )}
          <Panel title="Sections" colour="teal">
            <List>
              {sections.map((n) => (
                <ListRow
                  key={n.page.id}
                  onActivate={() => void navigate(`/wiki/${n.page.slug}`)}
                  leading={
                    n.colour ? (
                      <ColourDot colour={n.colour} />
                    ) : (
                      <span className="inline-block size-2" />
                    )
                  }
                  trailing={n.children.length ? `${n.children.length}` : undefined}
                >
                  {n.page.title}
                </ListRow>
              ))}
            </List>
          </Panel>
        </div>
      </div>
    </div>
  );
}
