import { useState } from 'react';
import { Button, Field, Modal, Select } from '@/ui';
import { useBookmarkActions } from './actions';
import { categoryOptions, type Bookmark, type Category } from './model';

/** Keyboard- and touch-friendly alternative to drag and drop: pick a category from a list. */
export function MoveDialog({
  bookmark,
  categories,
  bookmarks,
  onClose,
}: {
  bookmark: Bookmark | null;
  categories: readonly Category[];
  bookmarks: readonly Bookmark[];
  onClose: () => void;
}) {
  if (!bookmark) return null;
  return (
    <Body
      key={bookmark.id}
      bookmark={bookmark}
      categories={categories}
      bookmarks={bookmarks}
      onClose={onClose}
    />
  );
}

function Body({
  bookmark,
  categories,
  bookmarks,
  onClose,
}: {
  bookmark: Bookmark;
  categories: readonly Category[];
  bookmarks: readonly Bookmark[];
  onClose: () => void;
}) {
  const actions = useBookmarkActions();
  const [target, setTarget] = useState(bookmark.categoryId ?? '');
  const move = async () => {
    const categoryId = target || null;
    await actions.moveBookmark(
      bookmark,
      categoryId,
      bookmarks.filter((b) => b.categoryId === categoryId),
      'end',
    );
    onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title="Move bookmark"
      description={bookmark.title}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void move()}>
            Move
          </Button>
        </>
      }
    >
      <Field label="Category">
        {(p) => (
          <Select
            {...p}
            data-autofocus=""
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">Uncategorised</option>
            {categoryOptions(categories).map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
    </Modal>
  );
}
