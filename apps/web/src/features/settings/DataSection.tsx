import { API, attachmentsCleanupResponseSchema } from '@webfront/shared';
import { useRef, useState } from 'react';
import { clearLocalData, syncNow, useSyncStatus } from '@/data';
import { ApiRequestError, NetworkError, apiFetch } from '@/lib/api';
import { Badge, Button, ConfirmDialog, useOnline, useToast } from '@/ui';
import {
  applyImport,
  buildExport,
  exportFileName,
  planImport,
  planTotals,
  type ImportPlan,
} from './dataTransfer';

export default function DataSection() {
  return (
    <div className="flex flex-col gap-4 text-sm">
      <SyncDetails />
      <ExportImport />
      <RecentlyDeletedLink />
      <Cleanup />
      <ClearLocal />
    </div>
  );
}

function SyncDetails() {
  const s = useSyncStatus();
  const [busy, setBusy] = useState(false);
  const row = (k: string, v: React.ReactNode) => (
    <div className="flex justify-between gap-3 border-b border-line py-0.5 last:border-0">
      <dt className="text-fg-3">{k}</dt>
      <dd className="text-right">{v}</dd>
    </div>
  );
  return (
    <div>
      <h3 className="label-caps mb-1 text-fg-3">Sync</h3>
      <dl className="max-w-md">
        {row('State', s.state)}
        {row('Waiting to upload', s.pendingChanges)}
        {row(
          'Rejected by the server',
          s.rejectedChanges > 0 ? <Badge tone="bad">{s.rejectedChanges}</Badge> : 0,
        )}
        {row('Last synced', s.lastSyncedAt ? new Date(s.lastSyncedAt).toLocaleString() : 'never')}
        {s.error && row('Last error', <span className="text-bad-text">{s.error}</span>)}
      </dl>
      {s.rejectedChanges > 0 && (
        <p className="mt-1 max-w-md text-xs text-bad-text">
          Rejected changes will not sync. Check this device&apos;s clock and reload the app to make
          sure it is up to date.
        </p>
      )}
      <Button
        className="mt-1.5"
        size="sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await syncNow();
          } finally {
            setBusy(false);
          }
        }}
      >
        Sync now
      </Button>
    </div>
  );
}

function ExportImport() {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const doExport = async () => {
    const file = await buildExport();
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFileName();
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const onFile = async (file: File | undefined) => {
    setError(null);
    setPlan(null);
    if (!file) return;
    const result = await planImport(await file.text());
    if (result.ok) setPlan(result.plan);
    else setError(result.error);
    if (fileRef.current) fileRef.current.value = '';
  };

  const totals = plan ? planTotals(plan) : null;
  return (
    <div className="max-w-xl">
      <h3 className="label-caps mb-1 text-fg-3">Export and import</h3>
      <p className="mb-1.5 text-fg-3">
        The export is one JSON file with everything you have written: bookmarks, post-its, tasks,
        shopping, wiki pages and history, calendar feeds (including their private links) and
        settings. Uploaded images are not included. Importing merges by id: it adds missing records
        and updates older ones, and never deletes anything.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void doExport()}>Export everything</Button>
        <Button onClick={() => fileRef.current?.click()}>Import from file…</Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          aria-label="Import file"
          hidden
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
      </div>
      {error && (
        <p role="alert" className="mt-1.5 text-xs text-bad-text">
          {error}
        </p>
      )}
      {plan && totals && (
        <div className="mt-2 rounded-md border border-line p-2" aria-label="Import summary">
          <p className="mb-1 font-medium">
            Export from {new Date(plan.exportedAt).toLocaleString()}: {totals.added} new,{' '}
            {totals.updated} updated, {totals.unchanged} already up to date
            {totals.invalid > 0 ? `, ${totals.invalid} skipped as invalid` : ''}.
          </p>
          <ul className="mb-1.5 text-xs text-fg-2">
            {plan.summary.map((s) => (
              <li key={s.collection}>
                {s.collection}: {s.added} new, {s.updated} updated, {s.unchanged} unchanged
                {s.invalid ? `, ${s.invalid} invalid` : ''}
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button
              variant="primary"
              disabled={busy || plan.items.length === 0}
              onClick={async () => {
                setBusy(true);
                try {
                  const n = await applyImport(plan);
                  toast({ title: `Imported ${n} record${n === 1 ? '' : 's'}`, tone: 'success' });
                  setPlan(null);
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Import failed.');
                } finally {
                  setBusy(false);
                }
              }}
            >
              {plan.items.length === 0
                ? 'Nothing to import'
                : `Import ${plan.items.length} records`}
            </Button>
            <Button onClick={() => setPlan(null)}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function RecentlyDeletedLink() {
  return (
    <div className="max-w-xl">
      <h3 className="label-caps mb-1 text-fg-3">Deleted items</h3>
      <p className="text-fg-3">
        Deleted bookmarks, post-its, tasks, lists, pages and feeds are kept, so you can bring them
        back.{' '}
        <a href="#deleted" className="text-accent-text hover:underline">
          Open Recently deleted
        </a>
      </p>
    </div>
  );
}

function Cleanup() {
  const online = useOnline();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <div className="max-w-xl">
      <h3 className="label-caps mb-1 text-fg-3">Images</h3>
      <p className="mb-1.5 text-fg-3">
        Delete uploaded wiki images that no page or history entry uses any more (images less than a
        day old are kept). Needs a connection to the server.
      </p>
      <Button
        disabled={!online || busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await apiFetch(API.attachmentsCleanup, {
              method: 'POST',
              body: {},
              schema: attachmentsCleanupResponseSchema,
            });
            toast({
              title: `Removed ${r.removed} unused image${r.removed === 1 ? '' : 's'}`,
              description: `${r.kept} kept.`,
            });
          } catch (err) {
            toast({
              title: 'Cleanup failed',
              description:
                err instanceof NetworkError
                  ? 'The server is not reachable.'
                  : err instanceof ApiRequestError
                    ? err.message
                    : '',
              tone: 'error',
            });
          } finally {
            setBusy(false);
          }
        }}
      >
        Clean up unused images
      </Button>
      {!online && <span className="ml-2 text-xs text-fg-3">Offline</span>}
    </div>
  );
}

function ClearLocal() {
  const s = useSyncStatus();
  const [open, setOpen] = useState(false);
  return (
    <div className="max-w-xl rounded-md border border-bad/40 bg-bad-soft p-2">
      <h3 className="label-caps mb-1 text-bad-text">Danger zone</h3>
      <p className="mb-1.5 text-fg-2">
        Remove the local copy of your data from this device. Your data stays on the server and is
        downloaded again after you reload. You stay signed in.
      </p>
      <Button variant="danger" onClick={() => setOpen(true)}>
        Clear local data on this device
      </Button>
      <ConfirmDialog
        open={open}
        danger
        title="Clear local data?"
        description={
          s.pendingChanges + s.rejectedChanges > 0
            ? `Warning: ${s.pendingChanges} change${s.pendingChanges === 1 ? '' : 's'} not yet uploaded${s.rejectedChanges ? ` and ${s.rejectedChanges} rejected` : ''} will be lost for good. Sync first if you can.`
            : 'Everything is synced, so nothing will be lost. The page reloads afterwards.'
        }
        confirmLabel="Clear local data"
        onCancel={() => setOpen(false)}
        onConfirm={async () => {
          await clearLocalData();
          window.location.reload();
        }}
      />
    </div>
  );
}
