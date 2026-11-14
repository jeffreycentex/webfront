import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { ColourKey, LinkCheckResult, RecordOf } from '@webfront/shared';
import { ChevronDown, ChevronRight, Info, MoreHorizontal, Plus } from 'lucide-react';
import { useMemo } from 'react';
import {
  Badge,
  ColourDot,
  DragHandle,
  DropdownMenu,
  IconButton,
  List,
  Panel,
  type MenuItem,
} from '@/ui';
import { useBookmarkActions } from './actions';
import { BookmarkRow } from './BookmarkRow';
import {
  sectionBookmarks,
  sectionId,
  UNCATEGORISED_ID,
  type Bookmark,
  type Category,
  type Section,
} from './model';

type ServiceStatus = RecordOf<'serviceStatuses'>;

export interface BookmarkColumnsProps {
  /** Sections to show (already filtered). */
  sections: Section[];
  /** Every section, unfiltered: the source of truth for reorder maths. */
  allSections: Section[];
  statuses: Map<string, ServiceStatus>;
  tagColours: Record<string, ColourKey>;
  activeId: string | null;
  linkResults: Map<string, LinkCheckResult>;
  /** Drag and drop is off while a filter is active. */
  dragEnabled: boolean;
  collapsed: ReadonlySet<string>;
  onToggleCollapsed: (id: string) => void;
  onDetails: (b: Bookmark) => void;
  onEditBookmark: (b: Bookmark) => void;
  onDeleteBookmark: (b: Bookmark) => void;
  onMoveBookmark: (b: Bookmark) => void;
  onAddBookmark: (categoryId: string | null) => void;
  onEditCategory: (c: Category) => void;
  onAddSubcategory: (c: Category) => void;
  onDeleteCategory: (c: Category) => void;
}

const bookmarkKey = (id: string) => `bm:${id}`;
const categoryKey = (id: string) => `cat:${id}`;

/** Only consider droppables of the matching kind for the thing being dragged. */
const collision: CollisionDetection = (args) => {
  const kind = args.active.data.current?.type === 'category' ? 'category' : 'bookmark';
  const containers = args.droppableContainers.filter((c) => {
    const t = c.data.current?.type;
    return kind === 'category' ? t === 'category' : t === 'bookmark' || t === 'zone';
  });
  return closestCenter({ ...args, droppableContainers: containers });
};

export function BookmarkColumns(props: BookmarkColumnsProps) {
  const { sections, allSections, dragEnabled } = props;
  const actions = useBookmarkActions();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const topCategories = useMemo(
    () => allSections.flatMap((s) => (s.category ? [s.category] : [])),
    [allSections],
  );

  const onDragEnd = (e: DragEndEvent) => {
    const a = e.active.data.current;
    const o = e.over?.data.current;
    if (!a || !o) return;
    if (a.type === 'category') {
      if (o.type !== 'category' || e.active.id === e.over?.id) return;
      const from = topCategories.findIndex((c) => c.id === a.id);
      const to = topCategories.findIndex((c) => c.id === o.id);
      const cat = topCategories[from];
      if (cat && to >= 0) void actions.moveCategory(cat, topCategories, to);
      return;
    }
    if (a.type !== 'bookmark' || (o.type !== 'bookmark' && o.type !== 'zone')) return;
    if (e.active.id === e.over?.id) return;
    const all = allSections.flatMap((s) => [s, ...s.children]);
    const target = all.find((s) => sectionId(s) === o.sectionKey);
    const bookmark = all.flatMap((s) => s.bookmarks).find((b) => b.id === a.id);
    if (!target || !bookmark) return;
    const categoryId = target.category?.id ?? null;
    if (o.type === 'zone') {
      void actions.moveBookmark(bookmark, categoryId, target.bookmarks, 'end');
    } else {
      const to = target.bookmarks.findIndex((b) => b.id === o.id);
      if (to >= 0) void actions.moveBookmark(bookmark, categoryId, target.bookmarks, to);
    }
  };

  const items = sections.map((s) => (s.category ? categoryKey(s.category.id) : UNCATEGORISED_ID));
  return (
    <DndContext sensors={sensors} collisionDetection={collision} onDragEnd={onDragEnd}>
      <SortableContext items={items} strategy={rectSortingStrategy} disabled={!dragEnabled}>
        <div className="[column-gap:0.5rem] [column-width:18rem]">
          {sections.map((s) => (
            <CategoryPanel key={sectionId(s)} section={s} siblings={topCategories} {...props} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function CategoryPanel({
  section,
  siblings,
  ...p
}: BookmarkColumnsProps & { section: Section; siblings: Category[] }) {
  const actions = useBookmarkActions();
  const cat = section.category;
  const id = sectionId(section);
  const sortable = useSortable({
    id: cat ? categoryKey(cat.id) : UNCATEGORISED_ID,
    data: { type: 'category', id: cat?.id },
    disabled: !cat || !p.dragEnabled,
  });
  const collapsed = p.collapsed.has(id);
  const count = sectionBookmarks(section).length;
  const total = sectionBookmarks(p.allSections.find((s) => sectionId(s) === id) ?? section).length;

  const menu: MenuItem[] = cat
    ? [
        { label: 'Add bookmark', onSelect: () => p.onAddBookmark(cat.id) },
        { label: 'Add sub-category', onSelect: () => p.onAddSubcategory(cat) },
        'separator',
        { label: 'Edit category', onSelect: () => p.onEditCategory(cat) },
        {
          label: 'Move earlier',
          onSelect: () => void actions.stepCategory(cat, siblings, -1),
          disabled: siblings[0]?.id === cat.id,
        },
        {
          label: 'Move later',
          onSelect: () => void actions.stepCategory(cat, siblings, 1),
          disabled: siblings[siblings.length - 1]?.id === cat.id,
        },
        'separator',
        { label: 'Delete category', danger: true, onSelect: () => p.onDeleteCategory(cat) },
      ]
    : [{ label: 'Add bookmark', onSelect: () => p.onAddBookmark(null) }];

  return (
    <div
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Translate.toString(sortable.transform),
        transition: sortable.transition,
        opacity: sortable.isDragging ? 0.6 : undefined,
      }}
      className="mb-2 break-inside-avoid"
    >
      <Panel
        title={
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <span className="truncate">{cat?.name ?? 'Uncategorised'}</span>
            <Badge>{count === total ? count : `${count}/${total}`}</Badge>
          </span>
        }
        colour={cat?.colour ?? null}
        icon={
          <span className="flex items-center gap-0.5">
            {cat && p.dragEnabled && (
              <DragHandle
                ref={sortable.setActivatorNodeRef}
                aria-label={`Drag category ${cat.name}`}
                {...sortable.attributes}
                {...sortable.listeners}
              />
            )}
            <button
              type="button"
              aria-expanded={!collapsed}
              aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${cat?.name ?? 'Uncategorised'}`}
              onClick={() => p.onToggleCollapsed(id)}
              className="inline-flex size-4 items-center justify-center rounded-sm text-fg-3 hover:bg-surface-3 hover:text-fg max-sm:size-8"
            >
              {collapsed ? (
                <ChevronRight aria-hidden className="size-3.5" />
              ) : (
                <ChevronDown aria-hidden className="size-3.5" />
              )}
            </button>
          </span>
        }
        actions={
          <>
            <IconButton
              size="sm"
              label={`Add bookmark to ${cat?.name ?? 'Uncategorised'}`}
              icon={<Plus />}
              onClick={() => p.onAddBookmark(cat?.id ?? null)}
            />
            <DropdownMenu
              label="Category actions"
              placement="bottom-end"
              items={menu}
              trigger={<IconButton size="sm" label="Category actions" icon={<MoreHorizontal />} />}
            />
          </>
        }
      >
        {!collapsed && (
          <>
            <BookmarkList section={section} {...p} />
            {section.children.map((child) => (
              <div key={sectionId(child)} className="border-t border-line">
                {child.category && (
                  <div className="flex min-h-5 items-center justify-between gap-1 bg-surface-2 px-2 text-2xs font-semibold uppercase tracking-wide text-fg-2 max-sm:min-h-8 max-sm:px-3">
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      <ColourDot colour={child.category.colour} />
                      <span className="truncate">{child.category.name}</span>
                    </span>
                    <DropdownMenu
                      label="Sub-category actions"
                      placement="bottom-end"
                      items={subMenu(child.category, section, p, actions)}
                      trigger={
                        <IconButton
                          size="sm"
                          label={`Actions for ${child.category.name}`}
                          icon={<MoreHorizontal />}
                          className="!h-4 !w-4"
                        />
                      }
                    />
                  </div>
                )}
                <BookmarkList section={child} {...p} />
              </div>
            ))}
          </>
        )}
      </Panel>
    </div>
  );
}

function subMenu(
  c: Category,
  parent: Section,
  p: BookmarkColumnsProps,
  actions: ReturnType<typeof useBookmarkActions>,
): MenuItem[] {
  const siblings = parent.children.flatMap((s) => (s.category ? [s.category] : []));
  return [
    { label: 'Add bookmark', onSelect: () => p.onAddBookmark(c.id) },
    { label: 'Edit sub-category', onSelect: () => p.onEditCategory(c) },
    {
      label: 'Move earlier',
      onSelect: () => void actions.stepCategory(c, siblings, -1),
      disabled: siblings[0]?.id === c.id,
    },
    {
      label: 'Move later',
      onSelect: () => void actions.stepCategory(c, siblings, 1),
      disabled: siblings[siblings.length - 1]?.id === c.id,
    },
    'separator',
    { label: 'Delete sub-category', danger: true, onSelect: () => p.onDeleteCategory(c) },
  ];
}

function BookmarkList({ section, ...p }: BookmarkColumnsProps & { section: Section }) {
  const key = sectionId(section);
  const zone = useDroppable({
    id: `zone:${key}`,
    data: { type: 'zone', sectionKey: key },
    disabled: section.bookmarks.length > 0 || !p.dragEnabled,
  });
  const ids = section.bookmarks.map((b) => bookmarkKey(b.id));
  if (section.bookmarks.length === 0) {
    return (
      <div
        ref={zone.setNodeRef}
        className={`px-2 py-1.5 text-xs text-fg-3 ${zone.isOver ? 'bg-accent-soft' : ''}`}
      >
        {section.category ? 'Empty. Drop a bookmark here or use +.' : ''}
      </div>
    );
  }
  return (
    <SortableContext items={ids} strategy={verticalListSortingStrategy} disabled={!p.dragEnabled}>
      <List>
        {section.bookmarks.map((b, i) => (
          <SortableRow
            key={b.id}
            bookmark={b}
            sectionKey={key}
            siblings={section.bookmarks}
            first={i === 0}
            last={i === section.bookmarks.length - 1}
            {...p}
          />
        ))}
      </List>
    </SortableContext>
  );
}

function SortableRow({
  bookmark: b,
  sectionKey,
  siblings,
  first,
  last,
  ...p
}: BookmarkColumnsProps & {
  bookmark: Bookmark;
  sectionKey: string;
  siblings: Bookmark[];
  first: boolean;
  last: boolean;
}) {
  const actions = useBookmarkActions();
  const s = useSortable({
    id: bookmarkKey(b.id),
    data: { type: 'bookmark', id: b.id, sectionKey },
    disabled: !p.dragEnabled,
  });
  const menu: MenuItem[] = [
    { label: 'Details', onSelect: () => p.onDetails(b) },
    { label: 'Edit', onSelect: () => p.onEditBookmark(b) },
    { label: 'Move to category…', onSelect: () => p.onMoveBookmark(b) },
    {
      label: 'Move up',
      onSelect: () => void actions.stepBookmark(b, siblings, -1),
      disabled: first || !p.dragEnabled,
    },
    {
      label: 'Move down',
      onSelect: () => void actions.stepBookmark(b, siblings, 1),
      disabled: last || !p.dragEnabled,
    },
    'separator',
    { label: 'Delete', danger: true, onSelect: () => p.onDeleteBookmark(b) },
  ];
  return (
    <BookmarkRow
      bookmark={b}
      status={p.statuses.get(b.id)}
      tagColours={p.tagColours}
      active={p.activeId === b.id}
      linkResult={p.linkResults.get(b.id)}
      liRef={s.setNodeRef}
      dragging={s.isDragging}
      style={{ transform: CSS.Translate.toString(s.transform), transition: s.transition }}
      handle={
        p.dragEnabled ? (
          <DragHandle
            ref={s.setActivatorNodeRef}
            aria-label={`Drag ${b.title}`}
            className="sm:opacity-0 sm:focus:opacity-100 sm:group-hover/row:opacity-100 sm:group-focus-within/row:opacity-100"
            {...s.attributes}
            {...s.listeners}
          />
        ) : undefined
      }
      actions={
        <>
          <IconButton
            size="sm"
            label={`Details for ${b.title}`}
            icon={<Info />}
            onClick={() => p.onDetails(b)}
          />
          <DropdownMenu
            label={`Actions for ${b.title}`}
            placement="bottom-end"
            items={menu}
            trigger={
              <IconButton size="sm" label={`Actions for ${b.title}`} icon={<MoreHorizontal />} />
            }
          />
        </>
      }
    />
  );
}
