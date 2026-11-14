import { CircleAlert, CloudCheck, CloudOff, KeyRound, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { syncNow, useSyncStatus, type SyncStatus } from '../data';
import { cx } from '../lib/cx';
import { useOnline } from '../lib/online';
import { formatRelativeShort } from '../lib/time';
import { Spinner, Tooltip } from '../ui';

export interface SyncView {
  tone: 'ok' | 'warn' | 'bad' | 'busy';
  label: string;
  detail: string;
}

/** Pure mapping from sync status to what the header shows. Exported for tests. */
export function describeSync(status: SyncStatus, now: number = Date.now()): SyncView {
  const pending = status.pendingChanges;
  const last = status.lastSyncedAt
    ? `Last synced ${formatRelativeShort(status.lastSyncedAt, now)} ago.`
    : 'Not synced yet.';
  switch (status.state) {
    case 'syncing':
      return {
        tone: 'busy',
        label: 'Syncing',
        detail: pending ? `Syncing ${pending} change${pending === 1 ? '' : 's'}…` : 'Syncing…',
      };
    case 'offline':
      return {
        tone: 'warn',
        label: pending ? `Offline · ${pending}` : 'Offline',
        detail: `Server unreachable. Edits are saved on this device${pending ? ` (${pending} waiting to sync)` : ''} and will sync when it is back. ${last}`,
      };
    case 'unauthenticated':
      return {
        tone: 'bad',
        label: 'Sign in',
        detail: 'Your session expired. Sign in again to sync. Local data is kept.',
      };
    case 'error':
      return {
        tone: 'bad',
        label: 'Sync error',
        detail: `${status.error ?? 'Sync failed.'} Will retry. ${last}`,
      };
    default:
      return pending > 0
        ? {
            tone: 'warn',
            label: `${pending} pending`,
            detail: `${pending} change${pending === 1 ? '' : 's'} waiting to sync. ${last}`,
          }
        : { tone: 'ok', label: 'Synced', detail: last };
  }
}

const toneClass: Record<SyncView['tone'], string> = {
  ok: 'text-ok-text hover:bg-ok-soft',
  warn: 'text-warn-text bg-warn-soft hover:brightness-95',
  bad: 'text-bad-text bg-bad-soft hover:brightness-95',
  busy: 'text-accent-text hover:bg-accent-soft',
};

/** Header pill: synced / syncing / offline (+pending count) / error. Click to sync now. */
export function SyncIndicator() {
  const status = useSyncStatus();
  // Re-render every 30s so "synced 5m ago" stays fresh.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const view = describeSync(status, now);
  const icon =
    view.tone === 'busy' ? (
      <Spinner label="Syncing" className="size-3" />
    ) : status.state === 'offline' ? (
      <CloudOff aria-hidden className="size-3.5" />
    ) : status.state === 'unauthenticated' ? (
      <KeyRound aria-hidden className="size-3.5" />
    ) : view.tone === 'bad' ? (
      <CircleAlert aria-hidden className="size-3.5" />
    ) : (
      <CloudCheck aria-hidden className="size-3.5" />
    );
  return (
    <Tooltip label={view.detail} placement="bottom-end">
      <button
        type="button"
        onClick={() => void syncNow()}
        aria-label={`Sync status: ${view.label}. Press to sync now.`}
        data-sync-state={status.state}
        className={cx(
          'inline-flex h-6 items-center gap-1 rounded-full px-2 text-xs font-medium tabular-nums transition-colors max-sm:h-[36px] max-sm:px-2.5',
          toneClass[view.tone],
        )}
      >
        {icon}
        <span className="max-sm:hidden">{view.label}</span>
        {view.tone !== 'ok' && view.tone !== 'busy' && (
          <span className="sm:hidden">{status.pendingChanges || ''}</span>
        )}
      </button>
    </Tooltip>
  );
}

/** Shown only while the browser itself reports no network. */
export function OnlineIndicator() {
  const online = useOnline();
  if (online) return null;
  return (
    <Tooltip
      label="No network connection. Everything keeps working from local data."
      placement="bottom-end"
    >
      <span
        role="status"
        aria-label="No network connection"
        className="inline-flex h-6 items-center gap-1 rounded-full bg-warn-soft px-2 text-xs font-medium text-warn-text max-sm:h-[36px]"
      >
        <WifiOff aria-hidden className="size-3.5" />
        <span className="max-sm:hidden">No network</span>
      </span>
    </Tooltip>
  );
}
