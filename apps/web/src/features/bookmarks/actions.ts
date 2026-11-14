import { patch, put, remove, restore } from '@/data';
import { useToast } from '@/ui';
import { useCallback, useMemo } from 'react';
import {
  sortKeyForAppend,
  sortKeyForMove,
  sortKeyForStep,
  type Bookmark,
  type Category,
} from './model';

/** Write helpers with undo toasts. All writes are local and offline-safe. */
export function useBookmarkActions() {
  const { toast } = useToast();

  const undoable = useCallback(
    (title: string, undo: () => Promise<void>) => {
      toast({
        title,
        action: {
          label: 'Undo',
          onClick: () => {
            void undo().catch(() => toast({ title: 'Could not undo', tone: 'error' }));
          },
        },
      });
    },
    [toast],
  );

  return useMemo(
    () => ({
      async deleteBookmark(b: Bookmark) {
        await remove('bookmarks', b.id);
        undoable(`Deleted “${b.title}”`, () => restore('bookmarks', b.id));
      },
      async deleteCategory(c: Category) {
        await remove('bookmarkCategories', c.id);
        undoable(`Deleted category “${c.name}”`, () => restore('bookmarkCategories', c.id));
      },
      /** Move a bookmark to `categoryId` at `toIndex` among that category's bookmarks. */
      async moveBookmark(
        b: Bookmark,
        categoryId: string | null,
        siblings: readonly Bookmark[],
        toIndex: number | 'end',
      ) {
        const others = siblings.filter((s) => s.id !== b.id);
        const sortKey =
          toIndex === 'end' ? sortKeyForAppend(others) : sortKeyForMove(others, b.id, toIndex);
        await patch('bookmarks', b.id, { categoryId, sortKey });
      },
      async stepBookmark(b: Bookmark, siblings: readonly Bookmark[], delta: -1 | 1) {
        const sortKey = sortKeyForStep(siblings, b.id, delta);
        if (sortKey) await patch('bookmarks', b.id, { sortKey });
      },
      async moveCategory(c: Category, siblings: readonly Category[], toIndex: number) {
        await patch('bookmarkCategories', c.id, {
          sortKey: sortKeyForMove(siblings, c.id, toIndex),
        });
      },
      async stepCategory(c: Category, siblings: readonly Category[], delta: -1 | 1) {
        const sortKey = sortKeyForStep(siblings, c.id, delta);
        if (sortKey) await patch('bookmarkCategories', c.id, { sortKey });
      },
      async addBookmark(values: {
        url: string;
        title: string;
        categoryId: string | null;
        siblings: readonly Bookmark[];
        tags?: string[];
      }) {
        return put('bookmarks', {
          url: values.url,
          title: values.title,
          categoryId: values.categoryId,
          tags: values.tags ?? [],
          sortKey: sortKeyForAppend(values.siblings),
        });
      },
    }),
    [undoable],
  );
}
