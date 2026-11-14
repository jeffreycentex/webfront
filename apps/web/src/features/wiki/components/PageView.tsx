import {
  Bold,
  Code,
  Columns2,
  Eye,
  FilePlus,
  FolderTree,
  Heading,
  History,
  Italic,
  Link as LinkIcon,
  List as ListIcon,
  ListChecks,
  MoreHorizontal,
  Palette,
  Pencil,
  Pin,
  PinOff,
  SquareStack,
  Trash,
} from 'lucide-react';
import {
  lazy,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link, useNavigate } from 'react-router';
import {
  Button,
  ColourPicker,
  DropdownMenu,
  IconButton,
  Modal,
  Spinner,
  Toolbar,
  ToolbarSeparator,
  Tooltip,
  colourStyle,
  cx,
  formatRelativeShort,
  useHotkeys,
  useIsPhone,
  useToast,
} from '@/ui';
import { AttachmentError, addImage } from '../attachments';
import { setColour, setPinned, type WikiPage } from '../data';
import type { Heading as HeadingT } from '../markdown';
import { ancestorsOf, sectionColour } from '../lib/tree';
import { recoverBackup, useBodyEditor, type SaveState } from '../useBodyEditor';
import { Backlinks } from './Backlinks';
import { ConflictBanner } from './ConflictBanner';
import { DeleteDialog, MoveDialog, RenameDialog } from './Dialogs';
import type { EditorHandle, FormatKind } from './Editor';
import { HistoryPanel } from './HistoryPanel';
import { MarkdownView } from './MarkdownView';
import { Toc } from './Toc';

const Editor = lazy(() => import('./Editor'));

export type ViewMode = 'read' | 'edit' | 'split';
const MODE_KEY = 'webfront.wiki.editMode';

function preferredEditMode(phone: boolean): ViewMode {
  if (phone) return 'edit';
  try {
    return localStorage.getItem(MODE_KEY) === 'edit' ? 'edit' : 'split';
  } catch {
    return 'split';
  }
}

function SaveIndicator({ state, error }: { state: SaveState; error: string | null }) {
  const map = {
    saved: { label: 'Saved', cls: 'text-ok-text', dot: 'bg-ok' },
    unsaved: { label: 'Unsaved', cls: 'text-warn-text', dot: 'bg-warn' },
    saving: { label: 'Saving…', cls: 'text-fg-3', dot: 'bg-fg-3 animate-pulse' },
    error: { label: 'Not saved', cls: 'text-bad-text', dot: 'bg-bad' },
  }[state];
  return (
    <span
      role="status"
      title={error ?? undefined}
      className={cx('inline-flex items-center gap-1 text-xs', map.cls)}
    >
      <span aria-hidden className={cx('size-1.5 rounded-full', map.dot)} />
      {map.label}
    </span>
  );
}

export interface PageViewProps {
  page: WikiPage;
  pages: readonly WikiPage[];
  initialMode?: ViewMode;
  onOpenTree?: () => void;
  onCreatePage: (title: string, parentId?: string | null) => void;
}

export function PageView({
  page,
  pages,
  initialMode = 'read',
  onOpenTree,
  onCreatePage,
}: PageViewProps) {
  const phone = useIsPhone();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [mode, setModeState] = useState<ViewMode>(
    initialMode === 'read' ? 'read' : phone ? 'edit' : initialMode,
  );
  const [headings, setHeadings] = useState<HeadingT[]>([]);
  const [dialog, setDialog] = useState<null | 'rename' | 'move' | 'delete' | 'colour' | 'history'>(
    null,
  );
  const editorRef = useRef<EditorHandle>(null);
  const editor = useBodyEditor(page);
  const preview = useDeferredValue(editor.draft);
  const colour = useMemo(() => sectionColour(pages, page.id), [pages, page.id]);
  const crumbs = useMemo(() => ancestorsOf(pages, page.id), [pages, page.id]);
  const titles = useCallback(() => pages.map((p) => p.title), [pages]);
  const editing = mode !== 'read';

  // Merge in a draft left behind by a tab that was closed mid-edit.
  useEffect(() => {
    void recoverBackup(page.id).then((recovered) => {
      if (recovered)
        toast({
          title: 'Recovered unsaved changes',
          description: 'Text typed before the tab closed was saved.',
        });
    });
  }, [page.id, toast]);

  const setMode = (m: ViewMode) => {
    if (m === mode) return;
    if (m === 'read') void editor.flush();
    if (m !== 'read' && !phone) {
      try {
        localStorage.setItem(MODE_KEY, m);
      } catch {
        // ignore
      }
    }
    setModeState(m);
  };

  useHotkeys(
    {
      e: () => setMode(preferredEditMode(phone)),
      h: () => setDialog('history'),
    },
    { enabled: !editing && dialog === null },
  );
  useHotkeys(
    {
      escape: () => setMode('read'),
      'mod+s': () => void editor.flush(),
    },
    { enabled: editing && dialog === null, allowInInput: true },
  );

  const onImages = useCallback(
    async (files: File[]) => {
      const out: string[] = [];
      for (const f of files) {
        try {
          out.push(await addImage(f, f.name || 'image'));
        } catch (err) {
          toast({
            title: 'Image not added',
            description: err instanceof AttachmentError ? err.message : String(err),
            tone: 'error',
          });
        }
      }
      return out;
    },
    [toast],
  );

  const fmt = (kind: FormatKind) => editorRef.current?.format(kind);
  const formatButtons: Array<[FormatKind, string, ReactNode, string?]> = [
    ['bold', 'Bold', <Bold key="b" />, 'mod+b'],
    ['italic', 'Italic', <Italic key="i" />, 'mod+i'],
    ['heading', 'Heading', <Heading key="h" />, 'mod+alt+h'],
    ['link', 'Link', <LinkIcon key="l" />, 'mod+k'],
    ['wikilink', 'Wiki link', <SquareStack key="w" />],
    ['list', 'Bulleted list', <ListIcon key="u" />, 'mod+shift+8'],
    ['task', 'Task list', <ListChecks key="t" />, 'mod+shift+9'],
    ['code', 'Code', <Code key="c" />, 'mod+e'],
  ];

  const createFromLink = (title: string) => onCreatePage(title, page.id);
  const toc = <Toc headings={headings} />;
  const showSideToc = !editing && headings.length >= 3;

  const editorEl = (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <Spinner />
        </div>
      }
    >
      <Editor
        ref={editorRef}
        initial={editor.draft}
        replace={editor.replace}
        onChange={editor.setDraft}
        onBlur={() => void editor.flush()}
        titles={titles}
        onImages={onImages}
        className="h-full min-h-[50vh]"
      />
    </Suspense>
  );

  return (
    <article className="flex min-h-full flex-col" style={colourStyle(colour)}>
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-line bg-surface/95 px-3 pb-1.5 pt-1.5 backdrop-blur max-sm:px-2.5">
        <nav
          aria-label="Breadcrumb"
          className="flex min-h-4 items-center gap-1 truncate text-xs text-fg-3"
        >
          {onOpenTree && (
            <IconButton
              label="Pages"
              size="sm"
              icon={<FolderTree />}
              onClick={onOpenTree}
              className="-ml-1"
            />
          )}
          <Link to="/wiki" className="hover:text-fg">
            Wiki
          </Link>
          {crumbs.map((c) => (
            <span key={c.id} className="flex min-w-0 items-center gap-1">
              <span aria-hidden>/</span>
              <Link to={`/wiki/${c.slug}`} className="truncate hover:text-fg">
                {c.title}
              </Link>
            </span>
          ))}
        </nav>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h1
            className={cx(
              'min-w-0 flex-1 truncate border-l-[3px] pl-1.5 text-lg font-semibold leading-7',
              colour ? 'border-[color:var(--c)]' : 'border-transparent pl-0',
            )}
          >
            <button
              type="button"
              className="max-w-full truncate text-left hover:underline"
              onClick={() => setDialog('rename')}
              title="Rename"
            >
              {page.title}
            </button>
          </h1>
          <span className="text-xs text-fg-3" title={new Date(page.updatedAt).toLocaleString()}>
            edited {formatRelativeShort(page.updatedAt)}
          </span>
          {editing && <SaveIndicator state={editor.state} error={editor.error} />}
          <Toolbar label="View" className="rounded-md border border-line p-0.5">
            {(phone ? (['read', 'edit'] as const) : (['read', 'edit', 'split'] as const)).map(
              (m) => {
                const meta = {
                  read: {
                    label: 'Read',
                    icon: <Eye aria-hidden className="size-3.5" />,
                    sc: 'escape',
                  },
                  edit: {
                    label: 'Edit',
                    icon: <Pencil aria-hidden className="size-3.5" />,
                    sc: 'e',
                  },
                  split: {
                    label: 'Split',
                    icon: <Columns2 aria-hidden className="size-3.5" />,
                    sc: undefined,
                  },
                }[m];
                return (
                  <Tooltip key={m} label={meta.label} shortcut={meta.sc}>
                    <Button
                      size="sm"
                      variant={mode === m ? 'primary' : 'ghost'}
                      aria-pressed={mode === m}
                      onClick={() => setMode(m)}
                    >
                      {meta.icon}
                      <span className="max-sm:sr-only">{meta.label}</span>
                    </Button>
                  </Tooltip>
                );
              },
            )}
          </Toolbar>
          <IconButton
            label="History"
            shortcut="h"
            size="sm"
            icon={<History />}
            onClick={() => setDialog('history')}
          />
          <DropdownMenu
            label="Page actions"
            trigger={<IconButton label="Page actions" size="sm" icon={<MoreHorizontal />} />}
            items={[
              {
                label: 'New page inside',
                icon: <FilePlus />,
                onSelect: () => onCreatePage('', page.id),
              },
              { label: 'Rename…', icon: <Pencil />, onSelect: () => setDialog('rename') },
              { label: 'Move…', icon: <FolderTree />, onSelect: () => setDialog('move') },
              ...(page.parentId === null
                ? [
                    {
                      label: 'Section colour…',
                      icon: <Palette />,
                      onSelect: () => setDialog('colour'),
                    },
                  ]
                : []),
              {
                label: page.pinned ? 'Unpin from dashboard' : 'Pin to dashboard',
                icon: page.pinned ? <PinOff /> : <Pin />,
                onSelect: () => void setPinned(page.id, !page.pinned),
              },
              {
                label: 'History',
                icon: <History />,
                shortcut: 'h',
                onSelect: () => setDialog('history'),
              },
              'separator',
              {
                label: 'Delete…',
                icon: <Trash />,
                danger: true,
                onSelect: () => setDialog('delete'),
              },
            ]}
          />
        </div>
        {editing && (
          <Toolbar label="Formatting" className="mt-1 flex-wrap">
            {formatButtons.map(([kind, label, icon, sc], i) => (
              <span key={kind} className="contents">
                {(i === 4 || i === 7) && <ToolbarSeparator />}
                <IconButton
                  label={label}
                  shortcut={sc}
                  size="sm"
                  icon={icon}
                  onClick={() => fmt(kind)}
                />
              </span>
            ))}
          </Toolbar>
        )}
      </header>

      <div className="flex-1 px-3 py-2 max-sm:px-2.5">
        <ConflictBanner page={page} />

        {mode === 'read' && (
          <div className="flex gap-6">
            <div className="min-w-0 max-w-[860px] flex-1">
              {headings.length >= 3 && (
                <details className="mb-2 rounded-md border border-line bg-surface px-2 py-1 xl:hidden">
                  <summary className="cursor-pointer text-xs text-fg-2">Contents</summary>
                  <div className="pt-1">{toc}</div>
                </details>
              )}
              {page.body.trim() ? (
                <MarkdownView
                  source={page.body}
                  pages={pages}
                  onCreatePage={createFromLink}
                  onHeadings={setHeadings}
                />
              ) : (
                <div className="rounded-md border border-dashed border-line px-3 py-6 text-center text-sm text-fg-3">
                  This page is empty.{' '}
                  <button
                    type="button"
                    className="text-accent-text underline"
                    onClick={() => setMode(preferredEditMode(phone))}
                  >
                    Start writing
                  </button>{' '}
                  (or press <kbd>e</kbd>).
                </div>
              )}
              <Backlinks page={page} pages={pages} />
            </div>
            {showSideToc && (
              <aside className="sticky top-24 hidden max-h-[calc(100vh-8rem)] w-52 shrink-0 self-start overflow-auto xl:block">
                {toc}
              </aside>
            )}
          </div>
        )}

        {mode === 'edit' && (
          <div className="h-[calc(100dvh-13rem)] min-h-[320px] overflow-hidden rounded-md border border-line">
            {editorEl}
          </div>
        )}

        {mode === 'split' && (
          <div className="grid h-[calc(100dvh-13rem)] min-h-[320px] grid-cols-2 gap-2">
            <div className="min-h-0 overflow-hidden rounded-md border border-line">{editorEl}</div>
            <div
              className="scroll-thin min-h-0 overflow-auto rounded-md border border-line bg-surface px-3 py-2"
              aria-label="Preview"
            >
              <MarkdownView source={preview} pages={pages} onCreatePage={createFromLink} />
            </div>
          </div>
        )}
      </div>

      <RenameDialog
        page={page}
        open={dialog === 'rename'}
        onClose={() => setDialog(null)}
        onRenamed={(p) => {
          setDialog(null);
          if (p.slug !== page.slug) void navigate(`/wiki/${p.slug}`, { replace: true });
        }}
      />
      <MoveDialog
        page={page}
        pages={pages}
        open={dialog === 'move'}
        onClose={() => setDialog(null)}
      />
      <DeleteDialog
        page={page}
        pages={pages}
        open={dialog === 'delete'}
        onClose={() => setDialog(null)}
        onDeleted={(res) => {
          setDialog(null);
          const parent = pages.find((p) => p.id === page.parentId);
          void navigate(parent ? `/wiki/${parent.slug}` : '/wiki');
          toast({
            title: res.count > 1 ? `Deleted ${res.count} pages` : `Deleted “${page.title}”`,
            action: {
              label: 'Undo',
              onClick: () => void res.undo().then(() => navigate(`/wiki/${page.slug}`)),
            },
            duration: 8000,
          });
        }}
      />
      <Modal
        open={dialog === 'colour'}
        onClose={() => setDialog(null)}
        title="Section colour"
        size="sm"
      >
        <p className="mb-2 text-xs text-fg-3">Tints this section and every page inside it.</p>
        <ColourPicker
          value={page.colour}
          allowNone
          onChange={(c) => {
            void setColour(page.id, c);
            setDialog(null);
          }}
        />
      </Modal>
      <HistoryPanel page={page} open={dialog === 'history'} onClose={() => setDialog(null)} />
    </article>
  );
}
