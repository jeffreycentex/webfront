import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { DEFAULT_SHOPPING_SECTIONS, type ColourKey } from '@webfront/shared';
import { patch } from '@/data';
import { Button, ColourPicker, Field, IconButton, Input, Modal } from '@/ui';
import { createList, saveSections, type ShoppingList } from './store';

/** Create a list (name + colour). */
export function NewListModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (list: ShoppingList) => void;
}) {
  const [name, setName] = useState('');
  const [colour, setColour] = useState<ColourKey>('green');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const list = await createList(name, colour);
    setName('');
    onCreated(list);
    onClose();
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New shopping list"
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" form="new-list-form" type="submit" disabled={!name.trim()}>
            Create
          </Button>
        </>
      }
    >
      <form id="new-list-form" onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Name">
          {(p) => (
            <Input
              {...p}
              value={name}
              placeholder="Groceries, Hardware…"
              onChange={(e) => setName(e.target.value)}
              data-autofocus
            />
          )}
        </Field>
        <ColourPicker value={colour} onChange={(c) => c && setColour(c)} />
      </form>
    </Modal>
  );
}

/** Rename, recolour, edit the store sections, or archive a list. */
export function ListSettingsModal({
  list,
  onClose,
  onArchive,
  onMove,
  canMoveLeft,
  canMoveRight,
}: {
  list: ShoppingList | null;
  onClose: () => void;
  onArchive: (list: ShoppingList) => void;
  onMove: (list: ShoppingList, delta: -1 | 1) => void;
  canMoveLeft: boolean;
  canMoveRight: boolean;
}) {
  return (
    <Modal open={list !== null} onClose={onClose} title="List settings" size="md">
      {list && (
        <SettingsForm
          key={list.id}
          list={list}
          onClose={onClose}
          onArchive={onArchive}
          onMove={onMove}
          canMoveLeft={canMoveLeft}
          canMoveRight={canMoveRight}
        />
      )}
    </Modal>
  );
}

interface Row {
  /** Original name, or null for a section added in this editor. */
  original: string | null;
  name: string;
}

function SettingsForm({
  list,
  onClose,
  onArchive,
  onMove,
  canMoveLeft,
  canMoveRight,
}: {
  list: ShoppingList;
  onClose: () => void;
  onArchive: (list: ShoppingList) => void;
  onMove: (list: ShoppingList, delta: -1 | 1) => void;
  canMoveLeft: boolean;
  canMoveRight: boolean;
}) {
  const [name, setName] = useState(list.name);
  const [colour, setColour] = useState<ColourKey>(list.colour);
  const [rows, setRows] = useState<Row[]>(list.sections.map((s) => ({ original: s, name: s })));

  const move = (i: number, d: -1 | 1) =>
    setRows((r) => {
      const j = i + d;
      if (j < 0 || j >= r.length) return r;
      const next = [...r];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const cleaned = rows.map((r) => ({ ...r, name: r.name.trim() })).filter((r) => r.name);
    const seen = new Set<string>();
    const unique = cleaned.filter((r) => {
      const k = r.name.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const renames = new Map<string, string>();
    for (const r of unique)
      if (r.original && r.original !== r.name) renames.set(r.original, r.name);
    const sections = unique.map((r) => r.name);
    const sectionsChanged = JSON.stringify(sections) !== JSON.stringify(list.sections);
    if (trimmed !== list.name || colour !== list.colour) {
      await patch('shoppingLists', list.id, { name: trimmed, colour });
    }
    if (sectionsChanged) await saveSections(list.id, sections, renames);
    onClose();
  };

  return (
    <form onSubmit={save} className="flex flex-col gap-3">
      <Field label="Name">
        {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <ColourPicker value={colour} onChange={(c) => c && setColour(c)} />
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-xs font-medium text-fg-2">
          Store sections (in the order you walk the shop)
        </legend>
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-1">
            <Input
              aria-label={`Section ${i + 1}`}
              value={r.name}
              onChange={(e) =>
                setRows((rs) => rs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
              }
            />
            <IconButton
              label="Move section up"
              icon={<ArrowUp />}
              size="sm"
              disabled={i === 0}
              onClick={() => move(i, -1)}
              tooltip={false}
            />
            <IconButton
              label="Move section down"
              icon={<ArrowDown />}
              size="sm"
              disabled={i === rows.length - 1}
              onClick={() => move(i, 1)}
              tooltip={false}
            />
            <IconButton
              label="Remove section"
              icon={<Trash2 />}
              size="sm"
              onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
              tooltip={false}
            />
          </div>
        ))}
        <div className="flex gap-1.5">
          <Button size="sm" onClick={() => setRows((r) => [...r, { original: null, name: '' }])}>
            <Plus aria-hidden className="size-3.5" /> Add section
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              setRows(DEFAULT_SHOPPING_SECTIONS.map((s) => ({ original: null, name: s })))
            }
          >
            Reset to defaults
          </Button>
        </div>
        <p className="text-xs text-fg-3">
          Items in a removed section show under Other. Renaming moves its items along.
        </p>
      </fieldset>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2">
        <div className="flex gap-1.5">
          <Button
            variant="danger"
            onClick={() => {
              onArchive(list);
              onClose();
            }}
          >
            <Trash2 aria-hidden className="size-3.5" /> Archive list
          </Button>
          <IconButton
            label="Move list earlier"
            icon={<ArrowUp />}
            disabled={!canMoveLeft}
            onClick={() => onMove(list, -1)}
            tooltip={false}
          />
          <IconButton
            label="Move list later"
            icon={<ArrowDown />}
            disabled={!canMoveRight}
            onClick={() => onMove(list, 1)}
            tooltip={false}
          />
        </div>
        <div className="flex gap-1.5">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            Save
          </Button>
        </div>
      </div>
    </form>
  );
}
