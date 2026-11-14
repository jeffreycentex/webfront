import { Pin } from 'lucide-react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { useCollection } from '@/data';
import { Button, ColourDot, List, ListRow, Panel, Skeleton, formatRelativeShort } from '@/ui';
import { sectionColour } from './lib/tree';

/** Dashboard widget `wiki`: pinned pages, then recently edited ones (compact). */
export default function WikiWidget() {
  const pages = useCollection('wikiPages');
  const navigate = useNavigate();
  const { pinned, recent } = useMemo(() => {
    const all = pages ?? [];
    const pinned = all.filter((p) => p.pinned).sort((a, b) => a.title.localeCompare(b.title));
    const pinnedIds = new Set(pinned.map((p) => p.id));
    const recent = all
      .filter((p) => !pinnedIds.has(p.id))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, Math.max(4, 8 - pinned.length));
    return { pinned, recent };
  }, [pages]);

  return (
    <Panel
      title="Wiki"
      colour="indigo"
      actions={
        <Button size="sm" variant="ghost" onClick={() => void navigate('/wiki?new=1')}>
          New
        </Button>
      }
    >
      {!pages ? (
        <div className="flex flex-col gap-1 p-2">
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ) : pages.length === 0 ? (
        <p className="px-2 py-1.5 text-xs text-fg-3">
          No pages yet.{' '}
          <button
            type="button"
            className="text-accent-text underline"
            onClick={() => void navigate('/wiki')}
          >
            Start the wiki
          </button>
        </p>
      ) : (
        <List>
          {[...pinned, ...recent].map((p) => {
            const colour = sectionColour(pages, p.id);
            return (
              <ListRow
                key={p.id}
                onActivate={() => void navigate(`/wiki/${p.slug}`)}
                leading={
                  colour ? <ColourDot colour={colour} /> : <span className="inline-block size-2" />
                }
                trailing={
                  p.pinned ? (
                    <Pin aria-label="Pinned" className="size-3 text-fg-3" />
                  ) : (
                    formatRelativeShort(p.updatedAt)
                  )
                }
              >
                {p.title}
              </ListRow>
            );
          })}
        </List>
      )}
    </Panel>
  );
}
