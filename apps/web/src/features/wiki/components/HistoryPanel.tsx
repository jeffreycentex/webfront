import { History, RotateCcw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useCollection } from '@/data';
import {
  Badge,
  Button,
  ConfirmDialog,
  Drawer,
  EmptyState,
  List,
  ListRow,
  cx,
  formatRelativeShort,
  useToast,
} from '@/ui';
import { restoreRevision, type WikiPage } from '../data';
import { diffStats } from '../lib/diff';
import { DiffView } from './DiffView';

const byNewest = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) =>
  a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1;

/** Revision list with a diff against the current text and restore. */
export function HistoryPanel({
  page,
  open,
  onClose,
}: {
  page: WikiPage;
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const revisions = useCollection('wikiRevisions', { where: { pageId: page.id }, sort: byNewest });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const selected = revisions?.find((r) => r.id === selectedId) ?? revisions?.[0];
  const stats = useMemo(
    () => new Map((revisions ?? []).slice(0, 60).map((r) => [r.id, diffStats(r.body, page.body)])),
    [revisions, page.body],
  );

  return (
    <Drawer open={open} onClose={onClose} title={`History · ${page.title}`} width="max-w-[760px]">
      {!revisions ? null : revisions.length === 0 ? (
        <EmptyState icon={<History className="size-5" />} title="No revisions yet">
          Snapshots are taken every few minutes while you edit, when you leave the page, and before
          merges and restores.
        </EmptyState>
      ) : (
        <div className="flex min-h-0 flex-col gap-2 sm:flex-row">
          <List
            className="max-h-[30vh] shrink-0 overflow-auto rounded-md border border-line sm:max-h-[75vh] sm:w-56"
            aria-label="Revisions"
          >
            {revisions.map((r) => {
              const s = stats.get(r.id);
              const same = r.body === page.body;
              return (
                <ListRow
                  key={r.id}
                  selected={r.id === selected?.id}
                  onActivate={() => setSelectedId(r.id)}
                  trailing={
                    same ? (
                      <Badge tone="ok">current</Badge>
                    ) : s ? (
                      <span className="font-mono text-[11px]">
                        <span className="text-ok-text">+{s.added}</span>{' '}
                        <span className="text-bad-text">−{s.removed}</span>
                      </span>
                    ) : null
                  }
                >
                  <span title={new Date(r.createdAt).toLocaleString()}>
                    {new Date(r.createdAt).toLocaleString(undefined, {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    })}
                  </span>
                  <span className="ml-1 text-fg-3">{formatRelativeShort(r.createdAt)}</span>
                </ListRow>
              );
            })}
          </List>
          {selected && (
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-center gap-2">
                <p className={cx('min-w-0 flex-1 truncate text-xs text-fg-3')}>
                  Changes from this revision to the current text
                  {selected.title !== page.title ? ` (titled “${selected.title}”)` : ''}
                </p>
                <Button
                  size="sm"
                  disabled={selected.body === page.body}
                  onClick={() => setConfirm(true)}
                >
                  <RotateCcw aria-hidden className="size-3.5" /> Restore
                </Button>
              </div>
              <DiffView
                from={selected.body}
                to={page.body}
                fromLabel="This revision"
                toLabel="Current"
              />
            </div>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        title="Restore this revision?"
        description="The current text is saved in the history first, so you can switch back."
        confirmLabel="Restore"
        onCancel={() => setConfirm(false)}
        onConfirm={async () => {
          if (!selected) return;
          await restoreRevision(page, selected);
          setConfirm(false);
          toast({ title: 'Revision restored', tone: 'success' });
        }}
      />
    </Drawer>
  );
}
