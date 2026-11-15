import {
  BookOpen,
  Bookmark,
  CalendarDays,
  CircleCheck,
  Folder,
  ShoppingCart,
  StickyNote,
} from 'lucide-react';
import { useMemo, useState, type ComponentType } from 'react';
import { reader, useLiveData } from '@/data';
import { Button, Checkbox, EmptyState, Input, Select, Skeleton, useToast } from '@/ui';
import {
  DELETED_TYPES,
  HOUR_MS,
  PAGE_SIZE,
  TYPE_LABELS,
  applyPlan,
  loadDeleted,
  planRestore,
  type DeletedRow,
  type DeletedType,
  type RestoreRequest,
} from './deleted';

const ICONS: Record<DeletedType, ComponentType<{ className?: string }>> = {
  bookmarks: Bookmark,
  bookmarkCategories: Folder,
  postits: StickyNote,
  tasks: CircleCheck,
  shoppingLists: ShoppingCart,
  wikiPages: BookOpen,
  calendarFeeds: CalendarDays,
};

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 60 ? `${d} d ago` : new Date(ms).toLocaleDateString();
}

function companionLabel(row: DeletedRow): string | null {
  if (row.companions.length === 0) return null;
  const count = (t: DeletedType) => row.companions.filter((c) => c.type === t).length;
  const parts: string[] = [];
  const b = count('bookmarks');
  const s = count('bookmarkCategories');
  const p = count('wikiPages');
  if (b) parts.push(`${b} deleted bookmark${b === 1 ? '' : 's'}`);
  if (s) parts.push(`${s} sub-categor${s === 1 ? 'y' : 'ies'}`);
  if (p) parts.push(`${p} subpage${p === 1 ? '' : 's'}`);
  return parts.join(' and ');
}

export default function DeletedSection() {
  const rows = useLiveData(loadDeleted, []);
  const { toast } = useToast();
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<DeletedType | 'all'>('all');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // Rows whose companions are NOT restored with them (the default is to restore them).
  const [soloKeys, setSoloKeys] = useState<ReadonlySet<string>>(new Set());
  const [limits, setLimits] = useState<Partial<Record<DeletedType, number>>>({});
  const [busy, setBusy] = useState(false);
  const now = Date.now();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (rows ?? []).filter(
      (r) =>
        (typeFilter === 'all' || r.type === typeFilter) &&
        (!q || `${r.title} ${r.detail ?? ''}`.toLowerCase().includes(q)),
    );
  }, [rows, query, typeFilter]);

  const restoreRows = async (list: readonly DeletedRow[]) => {
    if (list.length === 0 || busy) return;
    setBusy(true);
    try {
      const requests: RestoreRequest[] = list.map((row) => ({
        row,
        withCompanions: !soloKeys.has(row.key),
      }));
      const plan = await planRestore(reader, requests);
      const undo = await applyPlan(plan);
      const total = plan.restores.length;
      const first = list[0]!;
      toast({
        title: list.length === 1 ? `Restored “${first.title}”` : `Restored ${total} items`,
        description:
          plan.notes.length > 0
            ? `Also: ${plan.notes.join(', ')}.`
            : list.length === 1 && total > 1
              ? `${total} items restored together.`
              : undefined,
        tone: 'success',
        action: {
          label: 'Undo',
          onClick: () => {
            void undo().catch(() => toast({ title: 'Could not undo', tone: 'error' }));
          },
        },
      });
      setSelected((s) => {
        const next = new Set(s);
        for (const r of list) next.delete(r.key);
        return next;
      });
    } catch (err) {
      toast({
        title: 'Could not restore',
        description: err instanceof Error ? err.message : undefined,
        tone: 'error',
      });
    } finally {
      setBusy(false);
    }
  };

  if (!rows) return <Skeleton className="h-12 w-full" />;

  const lastHour = rows.filter((r) => now - r.deletedAt <= HOUR_MS);
  const chosen = rows.filter((r) => selected.has(r.key));
  const toggle = (key: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="max-w-xl text-fg-3">
        <p>
          Deleted items are kept, not erased, so they can be restored here (and so the delete syncs
          to your other devices). There is no permanent delete. The time shown is when the item was
          deleted.
        </p>
        <p className="mt-1">
          Cleared shopping items come back through the list&apos;s suggestions and staples.
        </p>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="Nothing deleted" icon={<Bookmark />}>
          Bookmarks, post-its, tasks, shopping lists, wiki pages and calendar feeds you delete will
          show up here.
        </EmptyState>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="search"
              aria-label="Filter deleted items"
              placeholder="Filter by title"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full sm:w-56"
            />
            <div className="w-full sm:w-48">
              <Select
                aria-label="Type"
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value as DeletedType | 'all')}
              >
                <option value="all">All types</option>
                {DELETED_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABELS[t].plural}
                  </option>
                ))}
              </Select>
            </div>
            <Button
              variant="primary"
              disabled={busy || chosen.length === 0}
              className="max-sm:h-[44px]"
              onClick={() => void restoreRows(chosen)}
            >
              Restore selected{chosen.length > 0 ? ` (${chosen.length})` : ''}
            </Button>
            {lastHour.length > 0 && (
              <Button
                disabled={busy}
                className="max-sm:h-[44px]"
                onClick={() => void restoreRows(lastHour)}
              >
                Restore the {lastHour.length} deleted in the last hour
              </Button>
            )}
          </div>

          {filtered.length === 0 ? (
            <EmptyState title="No matches" icon={<Bookmark />}>
              Nothing deleted matches this filter.
            </EmptyState>
          ) : (
            DELETED_TYPES.map((type) => {
              const group = filtered.filter((r) => r.type === type);
              if (group.length === 0) return null;
              const limit = limits[type] ?? PAGE_SIZE;
              const Icon = ICONS[type];
              return (
                <section key={type} aria-label={TYPE_LABELS[type].plural}>
                  <h3 className="label-caps mb-0.5 flex items-center gap-1.5 text-fg-3">
                    <Icon className="size-3.5" />
                    {TYPE_LABELS[type].plural} ({group.length})
                  </h3>
                  <ul className="divide-y divide-line rounded-md border border-line">
                    {group.slice(0, limit).map((row) => {
                      const label = companionLabel(row);
                      return (
                        <li
                          key={row.key}
                          className="flex min-h-(--row-h) flex-wrap items-center gap-x-2 gap-y-0.5 px-2 py-0.5 max-sm:px-3"
                        >
                          <Checkbox
                            aria-label={`Select ${row.title}`}
                            checked={selected.has(row.key)}
                            onChange={() => toggle(row.key)}
                            className="min-h-0"
                          />
                          <Icon className="size-3.5 shrink-0 text-fg-3" />
                          <span className="sr-only">{TYPE_LABELS[type].singular}: </span>
                          <span className="min-w-0 flex-1 basis-40">
                            <span className="block truncate font-medium">{row.title}</span>
                            {row.detail && (
                              <span className="block truncate text-xs text-fg-3">{row.detail}</span>
                            )}
                          </span>
                          <time
                            className="shrink-0 text-xs text-fg-3"
                            dateTime={new Date(row.deletedAt).toISOString()}
                            title={new Date(row.deletedAt).toLocaleString()}
                          >
                            {ago(row.deletedAt, now)}
                          </time>
                          <Button
                            size="sm"
                            disabled={busy}
                            className="max-sm:h-[44px] max-sm:min-w-[44px]"
                            aria-label={`Restore ${row.title}`}
                            onClick={() => void restoreRows([row])}
                          >
                            Restore
                          </Button>
                          {label && (
                            <div className="basis-full pl-6 text-xs text-fg-2">
                              <Checkbox
                                label={`and its ${label}`}
                                checked={!soloKeys.has(row.key)}
                                onChange={(e) =>
                                  setSoloKeys((s) => {
                                    const next = new Set(s);
                                    if (e.target.checked) next.delete(row.key);
                                    else next.add(row.key);
                                    return next;
                                  })
                                }
                              />
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  {group.length > limit && (
                    <Button
                      size="sm"
                      className="mt-1 max-sm:h-[44px]"
                      onClick={() => setLimits((l) => ({ ...l, [type]: limit + PAGE_SIZE }))}
                    >
                      Show more ({group.length - limit} left)
                    </Button>
                  )}
                </section>
              );
            })
          )}
        </>
      )}
    </div>
  );
}
