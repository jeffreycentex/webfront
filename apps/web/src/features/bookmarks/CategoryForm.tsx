import type { ColourKey } from '@webfront/shared';
import { useState, type FormEvent } from 'react';
import { patch, put } from '@/data';
import { Button, ColourPicker, Field, Input, Modal, Select } from '@/ui';
import { sortKeyForAppend, type Category } from './model';

export interface CategoryFormProps {
  open: boolean;
  onClose: () => void;
  /** Editing this category; otherwise creating. */
  category?: Category | null;
  /** Prefill the parent for a new sub-category. */
  parentId?: string | null;
  categories: readonly Category[];
}

export function CategoryForm(props: CategoryFormProps) {
  if (!props.open) return null;
  return <Body key={props.category?.id ?? `new-${props.parentId ?? ''}`} {...props} />;
}

function Body({ onClose, category, parentId, categories }: CategoryFormProps) {
  const [name, setName] = useState(category?.name ?? '');
  const [colour, setColour] = useState<ColourKey>(category?.colour ?? 'blue');
  const [parent, setParent] = useState(category ? (category.parentId ?? '') : (parentId ?? ''));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const hasChildren = category ? categories.some((c) => c.parentId === category.id) : false;
  const parents = categories.filter((c) => !c.parentId && c.id !== category?.id);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return setError('Give the category a name.');
    setSaving(true);
    try {
      const parentId = parent || null;
      if (category) {
        const changes: Partial<Pick<Category, 'name' | 'colour' | 'parentId' | 'sortKey'>> = {
          name: trimmed,
          colour,
          parentId,
        };
        if (parentId !== category.parentId) {
          changes.sortKey = sortKeyForAppend(categories.filter((c) => c.parentId === parentId));
        }
        await patch('bookmarkCategories', category.id, changes);
      } else {
        await put('bookmarkCategories', {
          name: trimmed,
          colour,
          parentId,
          sortKey: sortKeyForAppend(categories.filter((c) => c.parentId === parentId)),
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the category.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={category ? 'Edit category' : parentId ? 'New sub-category' : 'New category'}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="category-form" variant="primary" disabled={saving}>
            {category ? 'Save' : 'Add category'}
          </Button>
        </>
      }
    >
      <form id="category-form" onSubmit={(e) => void submit(e)} className="flex flex-col gap-2.5">
        <Field label="Name" error={error}>
          {(p) => (
            <Input
              {...p}
              data-autofocus=""
              value={name}
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg-2">Colour</span>
          <ColourPicker value={colour} onChange={(c) => c && setColour(c)} />
        </div>
        <Field
          label="Inside"
          hint={
            hasChildren ? 'This category has sub-categories, so it stays top level.' : undefined
          }
        >
          {(p) => (
            <Select
              {...p}
              disabled={hasChildren}
              value={parent}
              onChange={(e) => setParent(e.target.value)}
            >
              <option value="">Top level</option>
              {parents.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </form>
    </Modal>
  );
}
