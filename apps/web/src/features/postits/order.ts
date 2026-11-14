import {
  colourKeySchema,
  compareBySortKey,
  sortKeyBefore,
  sortKeyForIndex,
  type ColourKey,
  type RecordOf,
} from '@webfront/shared';

export type Postit = RecordOf<'postits'>;

/** Display order: pinned first, then by sortKey (ties by id). */
export function sortPostits(notes: readonly Postit[]): Postit[] {
  return [...notes].sort((a, b) => Number(b.pinned) - Number(a.pinned) || compareBySortKey(a, b));
}

/** Dashboard order: pinned first, then newest first. */
export function recentPostits(notes: readonly Postit[]): Postit[] {
  return [...notes].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : compareBySortKey(a, b)),
  );
}

/** New notes go to the front of the grid. */
export function newNoteKey(all: readonly { sortKey: string; id: string }[]): string {
  let first: string | null = null;
  for (const n of all) if (first === null || n.sortKey < first) first = n.sortKey;
  return sortKeyBefore(first);
}

/** sortKey for moving `activeId` onto `overId`'s position (like dnd-kit's arrayMove); null = no-op. */
export function reorderKey(
  ordered: readonly { id: string; sortKey: string }[],
  activeId: string,
  overId: string,
): string | null {
  const from = ordered.findIndex((n) => n.id === activeId);
  const to = ordered.findIndex((n) => n.id === overId);
  if (from < 0 || to < 0 || from === to) return null;
  return sortKeyForIndex(
    ordered.filter((n) => n.id !== activeId),
    to,
  );
}

const STORAGE_KEY = 'webfront.postits.colour';

/** Colour used for the previous new note (per device convenience). */
export function readLastColour(fallback: ColourKey = 'yellow'): ColourKey {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    const parsed = colourKeySchema.safeParse(v);
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

export function writeLastColour(colour: ColourKey): void {
  try {
    localStorage.setItem(STORAGE_KEY, colour);
  } catch {
    /* storage unavailable: ignore */
  }
}
