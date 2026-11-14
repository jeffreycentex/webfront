import { COLOUR_KEYS, type ColourKey } from '@webfront/shared';
import { Eye, EyeOff, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { patch, put, remove, restore } from '@/data';
import {
  Badge,
  Button,
  ColourDot,
  ColourPicker,
  EmptyState,
  Field,
  IconButton,
  Input,
  Skeleton,
  Spinner,
  Switch,
  formatRelativeShort,
  useOnline,
  useToast,
} from '@/ui';
import { useCalendar, type CalendarFeed } from './model';
import { refreshCalendars } from './refresh';
import { maskUrl } from './text';

const PREFERRED_COLOURS: ColourKey[] = [
  'blue',
  'green',
  'orange',
  'violet',
  'pink',
  'teal',
  'red',
  'amber',
  'cyan',
  'lime',
  'indigo',
  'yellow',
];

/** Normalise what the user pasted. Returns an error message or the cleaned URL. */
export function checkFeedUrl(
  raw: string,
): { ok: true; url: string } | { ok: false; error: string } {
  const value = raw.trim();
  if (!value) return { ok: false, error: 'Paste the calendar link' };
  try {
    const u = new URL(value.replace(/^webcals?:\/\//i, 'https://'));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme');
    return { ok: true, url: value };
  } catch {
    return { ok: false, error: 'Enter a link starting with https:// or webcal://' };
  }
}

export function FeedManager({ startAdding = false }: { startAdding?: boolean }) {
  const { feeds, loading } = useCalendar();
  const [editing, setEditing] = useState<CalendarFeed | 'new' | null>(startAdding ? 'new' : null);

  if (editing) {
    return (
      <FeedForm
        feed={editing === 'new' ? null : editing}
        usedColours={feeds.map((f) => f.colour)}
        onDone={() => setEditing(null)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-xs text-fg-3">
          Read-only ICS links. The server fetches them every 15 minutes and syncs the events to all
          your devices.
        </p>
        <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
          <Plus className="size-3.5" aria-hidden /> Add feed
        </Button>
      </div>
      {loading ? (
        <Skeleton className="h-10" />
      ) : feeds.length === 0 ? (
        <div className="rounded-md border border-line">
          <EmptyState title="No calendar feeds yet">
            Add an Outlook or Google Calendar link to see your events here.
          </EmptyState>
        </div>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-md border border-line bg-surface">
          {feeds.map((feed) => (
            <FeedRow key={feed.id} feed={feed} onEdit={() => setEditing(feed)} />
          ))}
        </ul>
      )}
      <Instructions />
    </div>
  );
}

function FeedRow({ feed, onEdit }: { feed: CalendarFeed; onEdit: () => void }) {
  const online = useOnline();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const refresh = async () => {
    setBusy(true);
    try {
      const res = await refreshCalendars(feed.id);
      toast(
        res.ok
          ? {
              title: `Refreshed ${feed.name}`,
              description: `${res.events} events`,
              tone: 'success',
            }
          : {
              title: `Could not refresh ${feed.name}`,
              description: res.error ?? undefined,
              tone: 'error',
            },
      );
    } catch (err) {
      toast({ title: 'Refresh failed', description: (err as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    setConfirming(false);
    await remove('calendarFeeds', feed.id);
    toast({
      title: `Removed ${feed.name}`,
      action: { label: 'Undo', onClick: () => void restore('calendarFeeds', feed.id) },
    });
  };

  const status = !feed.enabled ? (
    <Badge>Off</Badge>
  ) : feed.lastError ? (
    <Badge tone="bad">Error</Badge>
  ) : feed.lastFetchedAt ? (
    <Badge tone="ok">OK</Badge>
  ) : (
    <Badge tone="warn">Pending</Badge>
  );

  return (
    <li className="flex flex-col gap-0.5 px-2 py-1.5 max-sm:px-3">
      <div className="flex items-center gap-2">
        <ColourDot colour={feed.colour} className="size-2.5" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{feed.name}</span>
        {status}
        <Switch
          aria-label={`${feed.name} enabled`}
          checked={feed.enabled}
          onCheckedChange={(enabled) => void patch('calendarFeeds', feed.id, { enabled })}
        />
        <IconButton
          label={online ? 'Refresh now' : 'Refresh (offline)'}
          size="sm"
          disabled={!online || busy || !feed.enabled}
          onClick={() => void refresh()}
          icon={busy ? <Spinner /> : <RefreshCw />}
        />
        <IconButton label="Edit feed" size="sm" icon={<Pencil />} onClick={onEdit} />
        {confirming ? (
          <span className="flex items-center gap-1">
            <Button variant="danger" size="sm" onClick={() => void del()}>
              Delete
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </span>
        ) : (
          <IconButton
            label="Delete feed"
            size="sm"
            variant="ghost"
            icon={<Trash2 />}
            onClick={() => setConfirming(true)}
          />
        )}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 pl-[18px] text-xs text-fg-3">
        <button
          type="button"
          onClick={() => setReveal((r) => !r)}
          aria-label={reveal ? 'Hide feed address' : 'Reveal feed address'}
          className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-sm text-left hover:text-fg"
        >
          {reveal ? <EyeOff className="size-3 shrink-0" /> : <Eye className="size-3 shrink-0" />}
          <code className="min-w-0 truncate font-mono text-2xs">
            {reveal ? feed.url : maskUrl(feed.url)}
          </code>
        </button>
        {feed.enabled && feed.lastError ? (
          <span className="text-bad-text" role="status">
            {feed.lastError}
            {feed.lastFetchedAt
              ? ` (last success ${formatRelativeShort(feed.lastFetchedAt)} ago)`
              : ''}
          </span>
        ) : feed.enabled && feed.lastFetchedAt ? (
          <span>
            Updated {formatRelativeShort(feed.lastFetchedAt)} ago · {feed.eventCount} events
          </span>
        ) : feed.enabled ? (
          <span>Waiting for the first fetch from the server</span>
        ) : (
          <span>Disabled: events hidden</span>
        )}
      </div>
    </li>
  );
}

function FeedForm({
  feed,
  usedColours,
  onDone,
}: {
  feed: CalendarFeed | null;
  usedColours: ColourKey[];
  onDone: () => void;
}) {
  const [name, setName] = useState(feed?.name ?? '');
  const [url, setUrl] = useState(feed?.url ?? '');
  const [showUrl, setShowUrl] = useState(false);
  const [colour, setColour] = useState<ColourKey>(
    feed?.colour ?? PREFERRED_COLOURS.find((c) => !usedColours.includes(c)) ?? COLOUR_KEYS[0],
  );
  const [enabled, setEnabled] = useState(feed?.enabled ?? true);
  const [errors, setErrors] = useState<{ name?: string; url?: string }>({});
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const checked = checkFeedUrl(url);
    const next = {
      ...(name.trim() ? {} : { name: 'Give the calendar a name' }),
      ...(checked.ok ? {} : { url: checked.error }),
    };
    setErrors(next);
    if (!checked.ok || next.name) return;
    setSaving(true);
    try {
      if (feed) {
        await patch('calendarFeeds', feed.id, {
          name: name.trim(),
          url: checked.url,
          colour,
          enabled,
        });
      } else {
        await put('calendarFeeds', { name: name.trim(), url: checked.url, colour, enabled });
      }
      onDone();
    } catch {
      setErrors({ url: 'Could not save this feed' });
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2.5" noValidate>
      <h3 className="text-sm font-semibold">{feed ? 'Edit feed' : 'Add calendar feed'}</h3>
      <Field label="Name" {...(errors.name ? { error: errors.name } : {})}>
        {(p) => (
          <Input
            {...p}
            data-autofocus
            value={name}
            maxLength={200}
            placeholder="Work, Family, Holidays…"
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </Field>
      <Field
        label="ICS link"
        hint="Treated as a secret: kept on your server and devices, never logged or shown in errors."
        {...(errors.url ? { error: errors.url } : {})}
      >
        {(p) => (
          <div className="flex gap-1">
            <Input
              {...p}
              type={showUrl ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              value={url}
              placeholder="https://… or webcal://…"
              onChange={(e) => setUrl(e.target.value)}
            />
            <IconButton
              label={showUrl ? 'Hide link' : 'Show link'}
              variant="secondary"
              icon={showUrl ? <EyeOff /> : <Eye />}
              onClick={() => setShowUrl((s) => !s)}
            />
          </div>
        )}
      </Field>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-fg-2">Colour</span>
        <ColourPicker value={colour} onChange={(c) => c && setColour(c)} label="Feed colour" />
      </div>
      <Switch label="Show this calendar" checked={enabled} onCheckedChange={setEnabled} />
      <div className="flex justify-end gap-1.5">
        <Button onClick={onDone} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={saving}>
          {feed ? 'Save' : 'Add feed'}
        </Button>
      </div>
      <Instructions />
    </form>
  );
}

export function Instructions() {
  return (
    <details className="rounded-md border border-line bg-surface-2 px-2 py-1 text-xs text-fg-2">
      <summary className="cursor-pointer select-none font-medium text-fg">
        Where do I find the ICS link?
      </summary>
      <div className="mt-1 flex flex-col gap-1.5 pb-1">
        <p>
          <strong className="text-fg">Outlook (web):</strong> Settings, Calendar, Shared calendars,
          Publish a calendar. Pick the calendar and &ldquo;Can view all details&rdquo;, press
          Publish, then copy the <em>ICS</em> link (not the HTML one).
        </p>
        <p>
          <strong className="text-fg">Google Calendar:</strong> Settings, pick the calendar under
          &ldquo;Settings for my calendars&rdquo;, Integrate calendar, then copy{' '}
          <em>Secret address in iCal format</em>.
        </p>
        <p className="text-fg-3">
          Anyone with the link can read the calendar, so keep it private. Feeds are read-only:
          nothing here changes your calendars.
        </p>
      </div>
    </details>
  );
}
