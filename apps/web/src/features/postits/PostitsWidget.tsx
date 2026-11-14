import { StickyNote } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router';
import { useCollection } from '@/data';
import { Badge, EmptyState, Panel, Skeleton, useIsPhone } from '@/ui';
import { PostitCard } from './PostitCard';
import { QuickCapture } from './QuickCapture';
import { recentPostits } from './order';

/** Dashboard widget: quick capture plus pinned and most recent notes, editable in place. */
export default function PostitsWidget() {
  const notes = useCollection('postits');
  const phone = useIsPhone();
  const shown = useMemo(
    () => recentPostits((notes ?? []).filter((n) => !n.archived)).slice(0, phone ? 4 : 8),
    [notes, phone],
  );
  const total = (notes ?? []).filter((n) => !n.archived).length;

  return (
    <Panel
      title="Post-its"
      colour="yellow"
      icon={<StickyNote className="size-3.5" aria-hidden />}
      flush={false}
      actions={
        <>
          <Badge>{total}</Badge>
          <Link to="/postits" className="px-1 text-xs text-accent-text hover:underline">
            All
          </Link>
        </>
      }
    >
      <div className="flex flex-col gap-2 p-2">
        <QuickCapture compact />
        {notes === undefined ? (
          <Skeleton className="h-16" />
        ) : shown.length === 0 ? (
          <EmptyState title="No post-its yet" icon={<StickyNote />} className="py-3">
            Notes you jot down show up here.
          </EmptyState>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] items-start gap-2">
            {shown.map((n) => (
              <PostitCard key={n.id} note={n} clamp />
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}
