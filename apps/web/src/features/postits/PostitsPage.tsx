import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  SortableContext,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';
import { Archive, StickyNote } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { patch, useCollection } from '@/data';
import { Badge, Button, cx, DragHandle, EmptyState, PageHeader, Skeleton } from '@/ui';
import { PostitCard } from './PostitCard';
import { QuickCapture } from './QuickCapture';
import { reorderKey, sortPostits, type Postit } from './order';

export const GRID =
  'grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] items-start gap-2 sm:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]';

export function PostitsPage() {
  const notes = useCollection('postits');
  const [params, setParams] = useSearchParams();
  const focusId = params.get('focus');
  const [view, setView] = useState<'notes' | 'archived'>('notes');
  const [highlight, setHighlight] = useState<string | null>(null);

  const { active, archived } = useMemo(() => {
    const all = notes ?? [];
    return {
      active: sortPostits(all.filter((n) => !n.archived)),
      archived: sortPostits(all.filter((n) => n.archived)),
    };
  }, [notes]);
  const pinned = active.filter((n) => n.pinned);
  const others = active.filter((n) => !n.pinned);

  // Arriving from search: show the right view, scroll to the note and flash it.
  useEffect(() => {
    if (!focusId || !notes) return;
    const target = notes.find((n) => n.id === focusId);
    if (!target) return;
    const wantArchived = target.archived;
    if ((view === 'archived') !== wantArchived) {
      setView(wantArchived ? 'archived' : 'notes');
      return;
    }
    const el = document.querySelector<HTMLElement>(`[data-postit-id="${CSS.escape(focusId)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.focus({ preventScroll: true });
    setHighlight(focusId);
    const t = setTimeout(() => setHighlight(null), 2500);
    const next = new URLSearchParams(params);
    next.delete('focus');
    setParams(next, { replace: true });
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, notes, view]);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-2 p-3 max-sm:px-3">
      <PageHeader
        title="Post-its"
        icon={<StickyNote />}
        actions={
          <div className="flex items-center gap-1" role="group" aria-label="View">
            <Button
              size="sm"
              variant={view === 'notes' ? 'subtle' : 'ghost'}
              aria-pressed={view === 'notes'}
              onClick={() => setView('notes')}
            >
              Notes <Badge>{active.length}</Badge>
            </Button>
            <Button
              size="sm"
              variant={view === 'archived' ? 'subtle' : 'ghost'}
              aria-pressed={view === 'archived'}
              onClick={() => setView('archived')}
            >
              <Archive className="size-3" aria-hidden /> Archived <Badge>{archived.length}</Badge>
            </Button>
          </div>
        }
      />
      {view === 'notes' && <QuickCapture autoFocus={!focusId} />}

      {notes === undefined ? (
        <div className={GRID} aria-busy>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      ) : view === 'archived' ? (
        archived.length === 0 ? (
          <EmptyState title="Nothing archived" icon={<Archive />}>
            Archive a note to tuck it away. It stays searchable and can be restored here.
          </EmptyState>
        ) : (
          <div className={GRID}>
            {archived.map((n) => (
              <PostitCard key={n.id} note={n} mode="archived" highlighted={highlight === n.id} />
            ))}
          </div>
        )
      ) : active.length === 0 ? (
        <EmptyState title="No post-its yet" icon={<StickyNote />}>
          Type above and press Enter. Pick a colour, pin the important ones, drag to rearrange.
        </EmptyState>
      ) : (
        <>
          {pinned.length > 0 && (
            <Section label="Pinned">
              <SortableGrid notes={pinned} highlight={highlight} />
            </Section>
          )}
          {others.length > 0 && (
            <Section label={pinned.length > 0 ? 'Notes' : null}>
              <SortableGrid notes={others} highlight={highlight} />
            </Section>
          )}
        </>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string | null; children: React.ReactNode }) {
  return (
    <section aria-label={label ?? 'Notes'}>
      {label && <h2 className="label-caps mb-1 text-fg-3">{label}</h2>}
      {children}
    </section>
  );
}

/** Drag-to-arrange grid. Keyboard: focus a grip, Space to lift, arrow keys to move, Space to drop. */
function SortableGrid({ notes, highlight }: { notes: Postit[]; highlight: string | null }) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over) return;
    const key = reorderKey(notes, String(active.id), String(over.id));
    if (key) void patch('postits', String(active.id), { sortKey: key });
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={notes.map((n) => n.id)} strategy={rectSortingStrategy}>
        <div className={GRID}>
          {notes.map((n) => (
            <SortableNote key={n.id} note={n} highlighted={highlight === n.id} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function SortableNote({ note, highlighted }: { note: Postit; highlighted: boolean }) {
  const s = useSortable({ id: note.id });
  return (
    <div
      ref={s.setNodeRef}
      style={{ transform: DndCSS.Transform.toString(s.transform), transition: s.transition }}
      className={cx('min-w-0', s.isDragging && 'relative z-10 opacity-80')}
    >
      <PostitCard
        note={note}
        highlighted={highlighted}
        dragHandle={
          <DragHandle
            ref={s.setActivatorNodeRef}
            {...s.attributes}
            {...s.listeners}
            aria-label="Reorder note"
          />
        }
      />
    </div>
  );
}
