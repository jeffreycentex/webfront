import { ChevronDown, ChevronRight, FileUp } from 'lucide-react';
import { useCallback, useMemo, useRef, useState, type DragEvent } from 'react';
import { Button, Checkbox, Field, Modal, Select, Spinner, useToast } from '@/ui';
import { useBookmarks, useCategories } from '../data';
import { applyImport, undoImport, type ImportProgress } from './apply';
import {
  IMPORT_MAX_BYTES,
  IMPORT_MAX_LINKS,
  SKIP_LABELS,
  duplicateKey,
  parseBookmarksHtml,
  type ImportFolder,
  type ParsedImport,
  type SkipReason,
} from './parseNetscape';
import {
  DEFAULT_OPTIONS,
  buildSelection,
  existingUrlKeys,
  groupKeys,
  type ImportOptions,
} from './plan';

/**
 * "Import from browser": pick or drop the HTML export, preview, confirm. The file is read and
 * parsed in this tab and never uploaded.
 */

type Stage =
  | { kind: 'pick'; error: string | null }
  | { kind: 'reading'; name: string }
  | { kind: 'preview'; name: string; parsed: ParsedImport }
  | { kind: 'importing'; progress: ImportProgress };

const tick = () => new Promise<void>((r) => setTimeout(r, 30));
const MAX_LISTED = 100;

export default function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <Body onClose={onClose} />;
}

function Body({ onClose }: { onClose: () => void }) {
  const categories = useCategories();
  const bookmarks = useBookmarks();
  const { toast } = useToast();
  const [stage, setStage] = useState<Stage>({ kind: 'pick', error: null });
  const [options, setOptions] = useState<ImportOptions>(DEFAULT_OPTIONS);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const existing = useMemo(() => existingUrlKeys(bookmarks ?? []), [bookmarks]);
  const parsed = stage.kind === 'preview' ? stage.parsed : null;
  const selection = useMemo(
    () => (parsed ? buildSelection(parsed, off, options, existing) : null),
    [parsed, off, options, existing],
  );
  const busy = stage.kind === 'importing' || stage.kind === 'reading';

  const readFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    if (file.size > IMPORT_MAX_BYTES) {
      setStage({
        kind: 'pick',
        error: `That file is ${(file.size / (1024 * 1024)).toFixed(1)} MB. The limit is ${IMPORT_MAX_BYTES / (1024 * 1024)} MB, which is far more than a bookmarks export. Nothing was read.`,
      });
      return;
    }
    setStage({ kind: 'reading', name: file.name });
    try {
      const text = await file.text();
      await tick(); // let the "reading" state paint before the synchronous parse
      const res = parseBookmarksHtml(text);
      if (!res.ok) setStage({ kind: 'pick', error: res.error });
      else {
        setOff(new Set());
        setOpen(
          new Set(res.parsed.categories.length <= 3 ? res.parsed.categories.map((c) => c.key) : []),
        );
        setStage({ kind: 'preview', name: file.name, parsed: res.parsed });
      }
    } catch {
      setStage({ kind: 'pick', error: 'That file could not be read.' });
    }
  }, []);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (stage.kind === 'pick') void readFile(e.dataTransfer.files[0]);
  };

  const run = async () => {
    if (!selection || !categories || !bookmarks) return;
    setStage({ kind: 'importing', progress: { done: 0, total: 1 } });
    try {
      const res = await applyImport({
        selection,
        merge: options.merge,
        categories,
        bookmarks,
        onProgress: (progress) => setStage({ kind: 'importing', progress }),
      });
      onClose();
      toast({
        title: `Imported ${res.links.toLocaleString()} bookmark${res.links === 1 ? '' : 's'}`,
        description:
          res.categoryIds.length > 0
            ? `${res.categoryIds.length} new categories${res.mergedCategories ? `, ${res.mergedCategories} merged into existing ones` : ''}.`
            : `Added to ${res.mergedCategories} existing categories.`,
        tone: 'success',
        duration: 15_000,
        action: {
          label: 'Undo',
          onClick: () => {
            void undoImport(res).then(
              () => toast({ title: 'Import undone', tone: 'neutral' }),
              () => toast({ title: 'Could not undo the import', tone: 'error' }),
            );
          },
        },
      });
    } catch {
      setStage({ kind: 'preview', name: '', parsed: parsed! });
      toast({
        title: 'Import failed',
        description: 'Nothing was kept from this attempt. Your data is unchanged.',
        tone: 'error',
      });
    }
  };

  const toggleGroups = (keys: string[], on: boolean) =>
    setOff((prev) => {
      const next = new Set(prev);
      for (const k of keys) on ? next.delete(k) : next.add(k);
      return next;
    });
  const toggleOpen = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const total = selection?.totals.links ?? 0;
  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      persistent
      size="lg"
      title="Import bookmarks from a browser"
      description="Reads the HTML file your browser exports. It is processed on this device and never uploaded."
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {stage.kind === 'preview' && (
            <Button
              variant="primary"
              disabled={total === 0 || !categories || !bookmarks}
              onClick={() => void run()}
            >
              Import {total.toLocaleString()} bookmark{total === 1 ? '' : 's'}
            </Button>
          )}
        </>
      }
    >
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (stage.kind === 'pick') setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className="flex flex-col gap-3"
      >
        {stage.kind === 'pick' && (
          <>
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className={`flex flex-col items-center gap-1.5 rounded-lg border-2 border-dashed px-4 py-8 text-sm text-fg-2 transition-colors ${dragging ? 'border-accent bg-accent-soft text-accent-text' : 'border-line-strong bg-surface-2 hover:bg-surface-3'}`}
            >
              <FileUp aria-hidden className="size-6" />
              <span className="font-medium text-fg">Choose a bookmarks file, or drop it here</span>
              <span className="text-xs text-fg-3">
                .html from Chrome, Edge, Firefox, Safari and most others. Up to{' '}
                {IMPORT_MAX_BYTES / (1024 * 1024)} MB and {IMPORT_MAX_LINKS.toLocaleString()} links.
              </span>
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".html,.htm,text/html"
              className="sr-only"
              aria-label="Bookmarks HTML file"
              data-autofocus=""
              onChange={(e) => {
                void readFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            {stage.error && (
              <p role="alert" className="rounded-md bg-bad-soft px-2 py-1.5 text-sm text-bad-text">
                {stage.error}
              </p>
            )}
          </>
        )}

        {stage.kind === 'reading' && (
          <p role="status" className="flex items-center gap-2 py-6 text-sm text-fg-2">
            <Spinner label="Reading" className="size-4" /> Reading {stage.name}…
          </p>
        )}

        {stage.kind === 'importing' && (
          <div role="status" className="flex flex-col gap-2 py-6">
            <p className="text-sm text-fg-2">
              Importing… {stage.progress.done.toLocaleString()} of{' '}
              {stage.progress.total.toLocaleString()}
            </p>
            <progress
              className="h-2 w-full overflow-hidden rounded-full [&::-moz-progress-bar]:bg-accent [&::-webkit-progress-bar]:bg-surface-3 [&::-webkit-progress-value]:bg-accent"
              value={stage.progress.done}
              max={Math.max(1, stage.progress.total)}
              aria-label="Import progress"
            />
          </div>
        )}

        {parsed && selection && stage.kind === 'preview' && (
          <>
            <Summary parsed={parsed} selection={selection} />
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label="Links already in Webfront">
                {(p) => (
                  <Select
                    {...p}
                    value={options.duplicates}
                    onChange={(e) =>
                      setOptions({ ...options, duplicates: e.target.value as 'skip' | 'import' })
                    }
                  >
                    <option value="skip">Skip them (also skips repeats within the file)</option>
                    <option value="import">Import them anyway</option>
                  </Select>
                )}
              </Field>
              <div className="flex items-end pb-0.5">
                <Checkbox
                  checked={options.merge}
                  onChange={(e) => setOptions({ ...options, merge: e.target.checked })}
                  label="Merge into existing categories with the same name"
                />
              </div>
            </div>
            <p className="text-xs text-fg-3">
              Folders become categories and their sub-folders become sub-categories. Anything nested
              deeper is flattened into its sub-category and tagged with the deeper folder path (for
              example &ldquo;Tools / Editors&rdquo;). Links outside any folder go to
              &ldquo;Imported&rdquo;.
            </p>
            <ul
              aria-label="Folders to import"
              className="max-h-[40vh] overflow-auto rounded-md border border-line bg-surface"
            >
              {parsed.categories.map((top) => (
                <TopRow
                  key={top.key}
                  top={top}
                  off={off}
                  open={open}
                  existing={existing}
                  onToggleGroups={toggleGroups}
                  onToggleOpen={toggleOpen}
                  stats={selection.stats}
                />
              ))}
            </ul>
          </>
        )}
      </div>
    </Modal>
  );
}

function Summary({
  parsed,
  selection,
}: {
  parsed: ParsedImport;
  selection: ReturnType<typeof buildSelection>;
}) {
  const t = selection.totals;
  const skipped = (Object.entries(parsed.skipped) as [SkipReason, number][]).filter(
    ([, n]) => n > 0,
  );
  return (
    <div className="flex flex-col gap-1 rounded-md bg-surface-2 px-2.5 py-2 text-sm" role="status">
      <p>
        <strong>{t.links.toLocaleString()}</strong> bookmarks in{' '}
        <strong>{t.categories.toLocaleString()}</strong> categories
        {t.subcategories > 0 && (
          <>
            {' '}
            and <strong>{t.subcategories.toLocaleString()}</strong> sub-categories
          </>
        )}{' '}
        will be imported.
      </p>
      <p className="text-fg-2">
        Duplicates: {t.duplicatesExisting.toLocaleString()} already in Webfront ,{' '}
        {t.duplicatesInFile.toLocaleString()} repeated in the file.
      </p>
      {parsed.skippedTotal > 0 && (
        <p className="text-fg-2">
          Skipped {parsed.skippedTotal.toLocaleString()} that cannot be imported:{' '}
          {skipped.map(([r, n]) => `${n.toLocaleString()} ${SKIP_LABELS[r]}`).join(', ')}.
        </p>
      )}
    </div>
  );
}

function TopRow({
  top,
  off,
  open,
  existing,
  stats,
  onToggleGroups,
  onToggleOpen,
}: {
  top: ImportFolder;
  off: ReadonlySet<string>;
  open: ReadonlySet<string>;
  existing: ReadonlySet<string>;
  stats: Map<string, { total: number; importing: number }>;
  onToggleGroups: (keys: string[], on: boolean) => void;
  onToggleOpen: (key: string) => void;
}) {
  const keys = groupKeys(top);
  const on = keys.filter((k) => !off.has(k)).length;
  const hasKids = top.subs.length > 0;
  const expandable = hasKids || top.links.length > 0;
  const isOpen = open.has(top.key);
  const count = top.links.length + top.subs.reduce((n, s) => n + s.links.length, 0);
  return (
    <li className="border-b border-line last:border-b-0">
      <div className="flex items-center gap-1 px-1.5">
        <ExpandButton
          open={isOpen}
          disabled={!expandable}
          label={top.name}
          onClick={() => onToggleOpen(top.key)}
        />
        <Checkbox
          aria-label={`Import ${top.name}`}
          checked={on > 0}
          indeterminate={on > 0 && on < keys.length}
          onChange={(e) => onToggleGroups(keys, e.target.checked)}
          label={<span className="font-medium">{top.name}</span>}
          className="min-w-0 flex-1"
        />
        <span className="shrink-0 text-xs text-fg-3">{count.toLocaleString()}</span>
      </div>
      {isOpen && (
        <ul className="pb-1 pl-6">
          {top.links.length > 0 && (
            <GroupRow
              folder={top}
              label={hasKids ? `Directly in ${top.name}` : null}
              off={off}
              open={open}
              existing={existing}
              stats={stats}
              onToggleGroups={onToggleGroups}
              onToggleOpen={onToggleOpen}
            />
          )}
          {top.subs.map((s) => (
            <GroupRow
              key={s.key}
              folder={s}
              label={s.name}
              off={off}
              open={open}
              existing={existing}
              stats={stats}
              onToggleGroups={onToggleGroups}
              onToggleOpen={onToggleOpen}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function GroupRow({
  folder,
  label,
  off,
  open,
  existing,
  stats,
  onToggleGroups,
  onToggleOpen,
}: {
  folder: ImportFolder;
  /** null = no row of its own (the category's links are listed directly). */
  label: string | null;
  off: ReadonlySet<string>;
  open: ReadonlySet<string>;
  existing: ReadonlySet<string>;
  stats: Map<string, { total: number; importing: number }>;
  onToggleGroups: (keys: string[], on: boolean) => void;
  onToggleOpen: (key: string) => void;
}) {
  const isOpen = label === null || open.has(folder.key);
  const s = stats.get(folder.key);
  const excluded = off.has(folder.key);
  return (
    <li>
      {label !== null && (
        <div className="flex items-center gap-1 pr-1.5">
          <ExpandButton open={isOpen} label={label} onClick={() => onToggleOpen(folder.key)} />
          <Checkbox
            aria-label={`Import ${label}`}
            checked={!excluded}
            onChange={(e) => onToggleGroups([folder.key], e.target.checked)}
            label={label}
            className="min-w-0 flex-1"
          />
          <span className="shrink-0 text-xs text-fg-3">
            {excluded || !s ? folder.links.length : `${s.importing} of ${s.total}`}
          </span>
        </div>
      )}
      {isOpen && (
        <ul className={label === null ? 'pl-1' : 'pl-7'}>
          {folder.links.slice(0, MAX_LISTED).map((l, i) => {
            const dup = existing.has(duplicateKey(l.url) ?? l.url);
            return (
              <li key={i} className="flex min-h-5 items-baseline gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate text-fg-2" title={l.url}>
                  {l.title}
                </span>
                {dup && <span className="shrink-0 text-warn-text">already saved</span>}
              </li>
            );
          })}
          {folder.links.length > MAX_LISTED && (
            <li className="text-xs text-fg-3">
              and {(folder.links.length - MAX_LISTED).toLocaleString()} more
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

function ExpandButton({
  open,
  label,
  onClick,
  disabled,
}: {
  open: boolean;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-5 shrink-0 items-center justify-center rounded text-fg-3 hover:bg-surface-2 disabled:opacity-30"
    >
      <Icon aria-hidden className="size-3.5" />
    </button>
  );
}
