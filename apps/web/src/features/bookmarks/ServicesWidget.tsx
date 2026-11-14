import { safeHttpUrl } from '@webfront/shared';
import { RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { formatRelativeShort, IconButton, StatusDot, useOnline, useToast } from '@/ui';
import { checkServicesNow } from './api';
import { statusInfo } from './BookmarkRow';
import { useBookmarks, useStatuses } from './data';

/** Dashboard widget `services`: a compact row of status chips (down first). */
export default function ServicesWidget() {
  const bookmarks = useBookmarks();
  const statuses = useStatuses();
  const online = useOnline();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const services = useMemo(() => {
    const rank = (id: string) => {
      const s = statuses.get(id)?.state;
      return s === 'down' ? 0 : s === 'unknown' || !s ? 1 : 2;
    };
    return (bookmarks ?? [])
      .filter((b) => b.isService)
      .sort((a, b) => rank(a.id) - rank(b.id) || a.title.localeCompare(b.title));
  }, [bookmarks, statuses]);

  if (!bookmarks) return null;
  if (services.length === 0) {
    return (
      <p className="text-sm text-fg-3">
        No services yet. Flag a bookmark as a service to monitor it from{' '}
        <Link to="/bookmarks" className="text-accent-text underline">
          Bookmarks
        </Link>
        .
      </p>
    );
  }

  const refresh = async () => {
    setBusy(true);
    try {
      await checkServicesNow();
    } catch {
      toast({ title: 'Could not run the check', tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1">
      {services.map((b) => {
        const st = statuses.get(b.id);
        const { dot, label } = statusInfo(st);
        return (
          <a
            key={b.id}
            href={safeHttpUrl(b.url) ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
            title={`${b.title}: ${label}`}
            className={`inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-sm hover:brightness-95 max-sm:h-9 ${
              dot === 'bad'
                ? 'border-bad bg-bad-soft text-bad-text'
                : 'border-line bg-surface text-fg hover:bg-surface-2'
            }`}
          >
            <StatusDot status={dot} label={label} pulse={dot === 'bad'} />
            <span className="max-w-32 truncate">{b.title}</span>
            {st?.changedAt && (
              <span className="text-2xs text-fg-3">{formatRelativeShort(st.changedAt)}</span>
            )}
          </a>
        );
      })}
      <IconButton
        size="sm"
        label={online ? 'Check services now' : 'Check services now (needs a connection)'}
        icon={<RefreshCw className={busy ? 'animate-spin' : ''} />}
        disabled={!online || busy}
        onClick={() => void refresh()}
      />
    </div>
  );
}
