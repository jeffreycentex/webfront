import { Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { patch, useRecord } from '@/data';
import { Button, Drawer, Field, Input, Select, useIsPhone } from '@/ui';

export interface EditItemSheetProps {
  itemId: string | null;
  sections: readonly string[];
  onClose: () => void;
  onRemove: (id: string) => void;
}

/** Edit name, quantity, section and note. Reads the live record, so remote edits show up. */
export function EditItemSheet({ itemId, sections, onClose, onRemove }: EditItemSheetProps) {
  const item = useRecord('shoppingItems', itemId);
  const phone = useIsPhone();
  const open = itemId !== null && Boolean(item);
  return (
    <Drawer open={open} onClose={onClose} title="Edit item" side={phone ? 'bottom' : 'right'}>
      {item && (
        <EditForm
          key={item.id}
          item={item}
          sections={sections}
          onClose={onClose}
          onRemove={onRemove}
        />
      )}
    </Drawer>
  );
}

function EditForm({
  item,
  sections,
  onClose,
  onRemove,
}: {
  item: NonNullable<ReturnType<typeof useRecord<'shoppingItems'>>>;
  sections: readonly string[];
  onClose: () => void;
  onRemove: (id: string) => void;
}) {
  const [name, setName] = useState(item.name);
  const [quantity, setQuantity] = useState(item.quantity ?? '');
  const [section, setSection] = useState(item.section ?? '');
  const [note, setNote] = useState(item.note);
  const options =
    item.section && !sections.includes(item.section) ? [...sections, item.section] : sections;

  const save = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    void patch('shoppingItems', item.id, {
      name: trimmed,
      quantity: quantity.trim() || null,
      section: section || null,
      note: note.trim(),
    });
    onClose();
  };

  return (
    <form onSubmit={save} className="flex flex-col gap-3">
      <Field label="Name">
        {(p) => (
          <Input {...p} value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
        )}
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Quantity">
          {(p) => (
            <Input
              {...p}
              value={quantity}
              placeholder="e.g. 2, 500g"
              onChange={(e) => setQuantity(e.target.value)}
            />
          )}
        </Field>
        <Field label="Section">
          {(p) => (
            <Select {...p} value={section} onChange={(e) => setSection(e.target.value)}>
              <option value="">No section</option>
              {options.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Field label="Note">
        {(p) => <Input {...p} value={note} onChange={(e) => setNote(e.target.value)} />}
      </Field>
      <div className="flex items-center justify-between gap-2 pt-1">
        <Button
          variant="danger"
          onClick={() => {
            onRemove(item.id);
            onClose();
          }}
        >
          <Trash2 aria-hidden className="size-3.5" /> Remove
        </Button>
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
