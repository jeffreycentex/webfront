import { Link2 } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router';
import { Badge, ColourDot, Panel } from '@/ui';
import type { WikiPage } from '../data';
import { backlinkContext, findBacklinks } from '../lib/links';
import { sectionColour } from '../lib/tree';

/** Pages that link to this one, with the sentence around the link. */
export function Backlinks({ page, pages }: { page: WikiPage; pages: readonly WikiPage[] }) {
  const links = useMemo(() => findBacklinks(pages, page), [pages, page]);
  return (
    <Panel
      title="Linked from"
      icon={<Link2 aria-hidden className="size-3.5" />}
      actions={<Badge>{links.length}</Badge>}
      className="mt-4"
    >
      {links.length === 0 ? (
        <p className="px-2 py-1.5 text-xs text-fg-3">
          No pages link here yet. Link to it from another page with <code>[[{page.title}]]</code>.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {links.map((p) => {
            const colour = sectionColour(pages, p.id);
            return (
              <li key={p.id} className="px-2 py-1 text-sm max-sm:px-3">
                <Link
                  to={`/wiki/${p.slug}`}
                  className="flex items-center gap-1.5 font-medium hover:underline"
                >
                  {colour && <ColourDot colour={colour} />}
                  {p.title}
                </Link>
                <p className="truncate text-xs text-fg-3">{backlinkContext(p.body, page.title)}</p>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
