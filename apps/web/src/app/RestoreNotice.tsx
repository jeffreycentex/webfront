import { History, X } from 'lucide-react';
import { useState } from 'react';
import { dismissRestoreNotice, getSetAsideChanges, useRestoreNotice } from '../data';

/**
 * Persistent notice after this device replaced its data with a restored server backup (see
 * `resetForRestore` in data/local.ts). Shown in every tab until dismissed; offers the unsynced
 * changes that were set aside as a JSON download. Re-applying them is not supported.
 */
export function RestoreNotice() {
  const notice = useRestoreNotice();
  const [busy, setBusy] = useState(false);
  if (!notice) return null;
  const n = notice.setAside;

  const download = async () => {
    setBusy(true);
    try {
      const batches = await getSetAsideChanges();
      const body = JSON.stringify(
        {
          kind: 'webfront-set-aside-changes',
          exportedAt: new Date().toISOString(),
          note: 'Unsynced changes this device held when the server was restored from a backup. Each change lists the record (collection, id) and the field values it had not yet synced.',
          batches,
        },
        null,
        2,
      );
      const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `webfront-set-aside-${notice.at.slice(0, 19).replace(/[:T]/g, '-')}.json`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="status"
      data-testid="restore-notice"
      className="flex items-start gap-2 border-b border-warn/30 bg-warn-soft px-3 py-1 text-xs text-warn-text"
    >
      <History aria-hidden className="mt-px size-3.5 shrink-0" />
      <p className="min-w-0 flex-1">
        This device was updated to match a restored backup.{' '}
        {n > 0 ? (
          <>
            {n} unsynced change{n === 1 ? '' : 's'} from this device {n === 1 ? 'was' : 'were'} set
            aside.
          </>
        ) : (
          'It had no unsynced changes.'
        )}
        {notice.dropped > 0 &&
          ` (${notice.dropped} older set-aside changes were too many to keep.)`}
        {n > 0 && (
          <>
            {' '}
            <button
              type="button"
              disabled={busy}
              onClick={() => void download()}
              className="font-medium underline disabled:opacity-60"
            >
              Download them as JSON
            </button>
          </>
        )}
      </p>
      <button
        type="button"
        aria-label="Dismiss restore notice"
        className="shrink-0 rounded-sm p-0.5 hover:bg-warn/10"
        onClick={() => void dismissRestoreNotice()}
      >
        <X aria-hidden className="size-3.5" />
      </button>
    </div>
  );
}
