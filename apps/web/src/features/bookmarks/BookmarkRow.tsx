import type { ColourKey, LinkCheckResult, RecordOf } from '@webfront/shared';
import { safeHttpUrl } from '@webfront/shared';
import { KeyRound, StickyNote, TriangleAlert } from 'lucide-react';
import type { CSSProperties, ReactNode, Ref } from 'react';
import { cx, StatusDot, TagChip, formatRelativeShort, type Status } from '@/ui';
import { Favicon } from './Favicon';
import type { Bookmark } from './model';

type ServiceStatus = RecordOf<'serviceStatuses'>;

export function statusInfo(
  status: ServiceStatus | undefined,
  now: number = Date.now(),
): { dot: Status; label: string } {
  if (!status || status.state === 'unknown') return { dot: 'idle', label: 'Status unknown' };
  const since = status.changedAt ? ` for ${formatRelativeShort(status.changedAt, now)}` : '';
  if (status.state === 'up') {
    return {
      dot: 'ok',
      label: `Up${since}${status.latencyMs !== null ? `, under ${status.latencyMs} ms` : ''}`,
    };
  }
  return { dot: 'bad', label: `Down${since}${status.message ? `: ${status.message}` : ''}` };
}

export function ServiceDot({ status }: { status: ServiceStatus | undefined }) {
  const { dot, label } = statusInfo(status);
  return <StatusDot status={dot} label={label} />;
}

export function linkProblemLabel(r: LinkCheckResult): string | null {
  if (r.state === 'dead') return `Dead link${r.message ? `: ${r.message}` : ''}`;
  if (r.state === 'redirected') return `Moved${r.finalUrl ? ` to ${r.finalUrl}` : ''}`;
  return null;
}

export interface BookmarkRowProps {
  bookmark: Bookmark;
  status?: ServiceStatus | undefined;
  tagColours?: Record<string, ColourKey>;
  /** Highlighted by keyboard navigation / top filter match. */
  active?: boolean;
  linkResult?: LinkCheckResult | undefined;
  /** Drag handle (editable page only). */
  handle?: ReactNode;
  /** Hover actions (editable page only). */
  actions?: ReactNode;
  showTags?: boolean;
  liRef?: Ref<HTMLLIElement>;
  style?: CSSProperties;
  dragging?: boolean;
}

/**
 * One dense bookmark row. The title is a real anchor (new tab, noopener), so middle-click and
 * modifier-click behave natively. Everything else is optional chrome around it.
 */
export function BookmarkRow({
  bookmark: b,
  status,
  tagColours,
  active,
  linkResult,
  handle,
  actions,
  showTags = true,
  liRef,
  style,
  dragging,
}: BookmarkRowProps) {
  const problem = linkResult ? linkProblemLabel(linkResult) : null;
  const hasCreds = Boolean(b.username || b.hint);
  return (
    <li
      ref={liRef}
      style={style}
      data-bookmark-id={b.id}
      aria-current={active ? 'true' : undefined}
      className={cx(
        'group/row relative flex min-h-(--row-h) items-center gap-1 px-1.5 text-sm max-sm:px-3',
        active ? 'bg-accent-soft' : 'hover:bg-surface-2',
        dragging && 'z-10 bg-surface-2 shadow-pop',
      )}
    >
      {handle}
      <a
        href={safeHttpUrl(b.url) ?? undefined}
        target="_blank"
        rel="noopener noreferrer"
        title={b.url}
        className="flex min-h-[inherit] min-w-0 flex-1 items-center gap-1.5 outline-none focus-visible:underline"
      >
        <Favicon url={b.url} title={b.title} />
        <span className="min-w-0 truncate">{b.title}</span>
        {showTags && b.tags.length > 0 && (
          <span className="flex min-w-0 shrink-[3] items-center gap-0.5 overflow-hidden max-sm:hidden">
            {b.tags.slice(0, 2).map((t) => (
              <TagChip
                key={t}
                label={t}
                className="max-w-16"
                {...(tagColours?.[t] ? { colour: tagColours[t] } : {})}
              />
            ))}
            {b.tags.length > 2 && <span className="text-2xs text-fg-3">+{b.tags.length - 2}</span>}
          </span>
        )}
      </a>
      <span className="flex shrink-0 items-center gap-1 text-fg-3">
        {problem && (
          <span title={problem} role="img" aria-label={problem}>
            <TriangleAlert
              aria-hidden
              className={cx('size-3', linkResult?.state === 'dead' ? 'text-bad' : 'text-warn')}
            />
          </span>
        )}
        {hasCreds && (
          <span title="Has a username or hint" role="img" aria-label="Has a username or hint">
            <KeyRound aria-hidden className="size-3" />
          </span>
        )}
        {b.notes.trim() && (
          <span title="Has notes" role="img" aria-label="Has notes">
            <StickyNote aria-hidden className="size-3" />
          </span>
        )}
        {b.isService && <ServiceDot status={status} />}
      </span>
      {actions && (
        <span className="flex shrink-0 items-center sm:opacity-0 sm:group-focus-within/row:opacity-100 sm:group-hover/row:opacity-100">
          {actions}
        </span>
      )}
    </li>
  );
}
