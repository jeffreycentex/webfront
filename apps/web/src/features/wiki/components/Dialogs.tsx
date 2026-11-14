import type { ColourKey } from '@webfront/shared';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Button, Checkbox, ColourPicker, ConfirmDialog, Field, Input, Modal, Select } from '@/ui';
import {
  createPage,
  deletePage,
  pagesLinkingTo,
  renamePage,
  movePage,
  type DeleteResult,
  type WikiPage,
} from '../data';
import { buildTree, descendantIds, flattenTree } from '../lib/tree';
import { compareBySortKey, sortKeyAfter } from '@webfront/shared';

/** Parent options: every page, indented by depth (optionally excluding a subtree). */
function ParentSelect({
  pages,
  value,
  onChange,
  exclude,
  id,
}: {
  pages: readonly WikiPage[];
  value: string;
  onChange: (v: string) => void;
  exclude?: Set<string>;
  id?: string;
}) {
  const rows = useMemo(() => flattenTree(buildTree(pages)), [pages]);
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">— Top level (new section) —</option>
      {rows
        .filter((n) => !exclude?.has(n.page.id))
        .map((n) => (
          <option key={n.page.id} value={n.page.id}>
            {`${' '.repeat(n.depth)}${n.page.title}`}
          </option>
        ))}
    </Select>
  );
}

export function NewPageDialog({
  open,
  pages,
  initialTitle = '',
  initialParentId = null,
  onClose,
  onCreated,
}: {
  open: boolean;
  pages: readonly WikiPage[];
  initialTitle?: string;
  initialParentId?: string | null;
  onClose: () => void;
  onCreated: (page: WikiPage) => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [parentId, setParentId] = useState(initialParentId ?? '');
  const [colour, setColour] = useState<ColourKey | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setTitle(initialTitle);
      setParentId(initialParentId ?? '');
      setColour(null);
    }
  }, [open, initialTitle, initialParentId]);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      const page = await createPage({ title, parentId: parentId || null, colour });
      onCreated(page);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New wiki page"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!title.trim() || busy} onClick={() => void submit()}>
            Create page
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2">
        <Field label="Title">
          {(p) => (
            <Input
              {...p}
              data-autofocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
            />
          )}
        </Field>
        <Field label="Inside">
          {(p) => <ParentSelect id={p.id} pages={pages} value={parentId} onChange={setParentId} />}
        </Field>
        {!parentId && (
          <Field
            label="Section colour"
            hint="Top-level pages are sections; their colour tints every page inside."
          >
            {() => <ColourPicker value={colour} onChange={setColour} allowNone />}
          </Field>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

export function RenameDialog({
  page,
  open,
  onClose,
  onRenamed,
}: {
  page: WikiPage;
  open: boolean;
  onClose: () => void;
  onRenamed: (p: WikiPage) => void;
}) {
  const [title, setTitle] = useState(page.title);
  const [linking, setLinking] = useState<number | null>(null);
  const [updateLinks, setUpdateLinks] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setTitle(page.title);
    setUpdateLinks(true);
    setLinking(null);
    void pagesLinkingTo(page.title, page.id).then((ps) => setLinking(ps.length));
  }, [open, page.title, page.id]);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      onRenamed(await renamePage(page.id, title, updateLinks && (linking ?? 0) > 0));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Rename page"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!title.trim() || busy} onClick={() => void submit()}>
            Rename
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2">
        <Field label="Title" hint="The page gets a new URL; the old one keeps redirecting here.">
          {(p) => (
            <Input
              {...p}
              data-autofocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
            />
          )}
        </Field>
        {linking !== null && linking > 0 && (
          <Checkbox
            label={`Update ${linking} page${linking === 1 ? '' : 's'} linking to “${page.title}”`}
            checked={updateLinks}
            onChange={(e) => setUpdateLinks(e.target.checked)}
          />
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

export function MoveDialog({
  page,
  pages,
  open,
  onClose,
}: {
  page: WikiPage;
  pages: readonly WikiPage[];
  open: boolean;
  onClose: () => void;
}) {
  const [parentId, setParentId] = useState(page.parentId ?? '');
  useEffect(() => {
    if (open) setParentId(page.parentId ?? '');
  }, [open, page.parentId]);
  const exclude = useMemo(
    () => new Set([page.id, ...descendantIds(pages, page.id)]),
    [pages, page.id],
  );
  const submit = async () => {
    const target = parentId || null;
    const siblings = pages
      .filter((p) => p.parentId === target && p.id !== page.id)
      .sort(compareBySortKey);
    await movePage(page.id, target, sortKeyAfter(siblings[siblings.length - 1]?.sortKey ?? null));
    onClose();
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Move “${page.title}”`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()}>
            Move
          </Button>
        </>
      }
    >
      <Field
        label="Move inside"
        hint="Tip: in the page tree, Alt+arrow keys move the focused page."
      >
        {(p) => (
          <ParentSelect
            id={p.id}
            pages={pages}
            value={parentId}
            onChange={setParentId}
            exclude={exclude}
          />
        )}
      </Field>
    </Modal>
  );
}

export function DeleteDialog({
  page,
  pages,
  open,
  onClose,
  onDeleted,
}: {
  page: WikiPage;
  pages: readonly WikiPage[];
  open: boolean;
  onClose: () => void;
  onDeleted: (result: DeleteResult) => void;
}) {
  const descendants = useMemo(() => descendantIds(pages, page.id), [pages, page.id]);
  const children = pages.filter((p) => p.parentId === page.id).length;
  const [mode, setMode] = useState<'reparent' | 'all'>('reparent');
  const [busy, setBusy] = useState(false);
  return (
    <ConfirmDialog
      open={open}
      danger
      busy={busy}
      title={`Delete “${page.title}”?`}
      confirmLabel={
        mode === 'all' && descendants.size > 0
          ? `Delete ${descendants.size + 1} pages`
          : 'Delete page'
      }
      description={
        descendants.size === 0 ? (
          'You can undo this for a few seconds; the page also stays recoverable in the sync history.'
        ) : (
          <span className="flex flex-col gap-1.5">
            <span>
              It has {children} child page{children === 1 ? '' : 's'} ({descendants.size} in total
              below it).
            </span>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="wiki-del"
                checked={mode === 'reparent'}
                onChange={() => setMode('reparent')}
              />
              Keep them: move the child pages up one level
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="wiki-del"
                checked={mode === 'all'}
                onChange={() => setMode('all')}
              />
              Delete all {descendants.size} pages below it as well
            </label>
          </span>
        )
      }
      onCancel={onClose}
      onConfirm={async () => {
        setBusy(true);
        try {
          onDeleted(await deletePage(page.id, mode));
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}
