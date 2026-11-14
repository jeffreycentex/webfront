import type { ColourKey, RecordOf } from '@webfront/shared';
import { safeHttpUrl } from '@webfront/shared';
import { Check, Copy, Eye, EyeOff, ExternalLink, Pencil, Trash2 } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { Button, Drawer, IconButton, Skeleton, TagChip, formatRelativeShort } from '@/ui';
import { statusInfo } from './BookmarkRow';
import { Favicon } from './Favicon';
import { hostOf, type Bookmark } from './model';
import { displayHint, useReveal } from './reveal';

const Markdown = lazy(() => import('./NotesView'));

export interface BookmarkDetailsProps {
  bookmark: Bookmark | null;
  categoryName?: string | undefined;
  status?: RecordOf<'serviceStatuses'> | undefined;
  tagColours?: Record<string, ColourKey>;
  onClose: () => void;
  onEdit?: (b: Bookmark) => void;
  onDelete?: (b: Bookmark) => void;
}

/**
 * Side panel with everything about one bookmark. The hint stays masked until "Reveal" is
 * pressed and re-masks when the panel closes or another bookmark is shown.
 */
export function BookmarkDetails({
  bookmark: b,
  categoryName,
  status,
  tagColours,
  onClose,
  onEdit,
  onDelete,
}: BookmarkDetailsProps) {
  const [revealed, toggle] = useReveal(b !== null, b?.id);
  const [copied, setCopied] = useState(false);

  const copyUsername = async () => {
    if (!b?.username) return;
    try {
      await navigator.clipboard.writeText(b.username);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (insecure context or denied): nothing to do.
    }
  };

  return (
    <Drawer
      open={b !== null}
      onClose={onClose}
      title={
        b ? (
          <span className="inline-flex min-w-0 items-center gap-2">
            <Favicon url={b.url} title={b.title} />
            <span className="truncate">{b.title}</span>
          </span>
        ) : (
          ''
        )
      }
      footer={
        b && (
          <>
            {onDelete && (
              <Button
                variant="ghost"
                onClick={() => {
                  onDelete(b);
                  onClose();
                }}
              >
                <Trash2 aria-hidden className="size-3.5" /> Delete
              </Button>
            )}
            {onEdit && (
              <Button onClick={() => onEdit(b)}>
                <Pencil aria-hidden className="size-3.5" /> Edit
              </Button>
            )}
            <a
              href={safeHttpUrl(b.url) ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-(--control-h) items-center gap-1.5 rounded-md border border-accent bg-accent px-2.5 text-sm font-medium text-accent-fg hover:bg-accent-hover"
            >
              <ExternalLink aria-hidden className="size-3.5" /> Open
            </a>
          </>
        )
      }
    >
      {b && (
        <dl className="flex flex-col gap-3 text-sm">
          <Row label="Address">
            <a
              href={safeHttpUrl(b.url) ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all text-accent-text hover:underline"
            >
              {b.url}
            </a>
            <span className="text-xs text-fg-3">{hostOf(b.url)}</span>
          </Row>
          {categoryName && <Row label="Category">{categoryName}</Row>}
          {b.tags.length > 0 && (
            <Row label="Tags">
              <span className="flex flex-wrap gap-1">
                {b.tags.map((t) => (
                  <TagChip
                    key={t}
                    label={t}
                    {...(tagColours?.[t] ? { colour: tagColours[t] } : {})}
                  />
                ))}
              </span>
            </Row>
          )}
          {b.isService && (
            <Row label="Status">
              {statusInfo(status).label}
              {status?.checkedAt && (
                <span className="text-xs text-fg-3">
                  checked {formatRelativeShort(status.checkedAt)} ago
                </span>
              )}
            </Row>
          )}
          {(b.username || b.hint) && (
            <Row label="Sign-in reminder">
              {b.username && (
                <span className="flex items-center gap-1.5">
                  <span className="text-xs text-fg-3">Username</span>
                  <code className="rounded-sm bg-surface-3 px-1 font-mono text-xs">
                    {b.username}
                  </code>
                  <IconButton
                    size="sm"
                    label={copied ? 'Copied' : 'Copy username'}
                    icon={copied ? <Check /> : <Copy />}
                    onClick={() => void copyUsername()}
                  />
                </span>
              )}
              {b.hint && (
                <span className="flex items-center gap-1.5">
                  <span className="text-xs text-fg-3">Hint</span>
                  <span
                    data-testid="hint"
                    className="min-w-0 break-words rounded-sm bg-surface-3 px-1 font-mono text-xs"
                  >
                    {displayHint(b.hint, revealed)}
                  </span>
                  <Button size="sm" variant="ghost" aria-pressed={revealed} onClick={toggle}>
                    {revealed ? (
                      <EyeOff aria-hidden className="size-3.5" />
                    ) : (
                      <Eye aria-hidden className="size-3.5" />
                    )}
                    {revealed ? 'Hide' : 'Reveal'}
                  </Button>
                </span>
              )}
              <span className="text-xs text-fg-3">
                A reminder only. Keep real passwords in a password manager.
              </span>
            </Row>
          )}
          {b.notes.trim() && (
            <Row label="Notes">
              <Suspense fallback={<Skeleton className="h-8 w-full" />}>
                <Markdown source={b.notes} />
              </Suspense>
            </Row>
          )}
        </dl>
      )}
    </Drawer>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="label-caps text-fg-3">{label}</dt>
      <dd className="flex flex-col gap-1">{children}</dd>
    </div>
  );
}
