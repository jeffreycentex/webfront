import { useMemo } from 'react';
import { Link } from 'react-router';
import { Button, EmptyState, Panel, Skeleton } from '@/ui';
import { BookmarkRow } from './BookmarkRow';
import { useBookmarks, useCategories, useStatuses, useTagColours } from './data';
import {
  buildSections,
  displayOrder,
  filterSections,
  rankBookmarks,
  sectionBookmarks,
  sectionId,
  type Section,
} from './model';

/**
 * Read-optimised category columns (no editing chrome). `query` lets the dashboard's search
 * bar drive the filter; the dashboard widget itself passes none.
 */
export function BookmarkColumns({ query = '' }: { query?: string }) {
  const categories = useCategories();
  const bookmarks = useBookmarks();
  const statuses = useStatuses();
  const tagColours = useTagColours();

  const sections = useMemo(() => {
    const all = buildSections(categories ?? [], bookmarks ?? []);
    if (!query.trim()) return all;
    const ranked = rankBookmarks(displayOrder(all), categories ?? [], query);
    return filterSections(all, new Set(ranked.map((r) => r.bookmark.id)));
  }, [categories, bookmarks, query]);

  if (!categories || !bookmarks) return <Skeleton className="h-32 w-full" />;
  if (bookmarks.length === 0 && categories.length === 0) {
    return (
      <EmptyState title="No bookmarks yet">
        <Link to="/bookmarks?new=category">
          <Button size="sm" variant="primary">
            Add your first category
          </Button>
        </Link>
      </EmptyState>
    );
  }
  if (sections.length === 0) return <p className="text-sm text-fg-3">No matching bookmarks.</p>;

  return (
    <div className="[column-gap:0.5rem] [column-width:16rem]">
      {sections.map((s) => (
        <ReadOnlyPanel key={sectionId(s)} section={s} statuses={statuses} tagColours={tagColours} />
      ))}
    </div>
  );
}

function ReadOnlyPanel({
  section,
  statuses,
  tagColours,
}: {
  section: Section;
  statuses: ReturnType<typeof useStatuses>;
  tagColours: ReturnType<typeof useTagColours>;
}) {
  const rows = (s: Section) =>
    s.bookmarks.map((b) => (
      <BookmarkRow
        key={b.id}
        bookmark={b}
        status={statuses.get(b.id)}
        tagColours={tagColours}
        showTags={false}
      />
    ));
  return (
    <Panel
      title={section.category?.name ?? 'Uncategorised'}
      colour={section.category?.colour ?? null}
      headingLevel={3}
      className="mb-2 break-inside-avoid"
      actions={<span className="text-2xs text-fg-3">{sectionBookmarks(section).length}</span>}
    >
      <ul className="divide-y divide-line">{rows(section)}</ul>
      {section.children.map((child) => (
        <div key={sectionId(child)} className="border-t border-line">
          <p className="bg-surface-2 px-2 text-2xs font-semibold uppercase tracking-wide text-fg-2">
            {child.category?.name}
          </p>
          <ul className="divide-y divide-line">{rows(child)}</ul>
        </div>
      ))}
    </Panel>
  );
}

/** Dashboard widget `bookmarks`; `query` is the dashboard search bar's live filter. */
export default function BookmarksWidget({ query }: { query?: string }) {
  return <BookmarkColumns query={query ?? ''} />;
}
