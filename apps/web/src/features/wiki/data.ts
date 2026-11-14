import {
  compareBySortKey,
  sortKeyAfter,
  sortKeyBetween,
  type ColourKey,
  type RecordOf,
} from '@webfront/shared';
import { patch, put, reader, remove, restore, transaction } from '@/data';
import { saveBody, resolveConflict as resolveConflictBody } from './lib/bodySync';
import { renameLinks, linksTo } from './lib/links';
import { revisionsToPrune, shouldSnapshot, type SnapshotReason } from './lib/revisions';
import { titleKey, uniqueSlug } from './lib/text';
import { descendantIds } from './lib/tree';
import { bodyStore, wikiIO } from './runtime';

/** Page operations used by the wiki UI (all local-first through `@/data`). */

export type WikiPage = RecordOf<'wikiPages'>;
export type WikiRevision = RecordOf<'wikiRevisions'>;

async function livePages(): Promise<WikiPage[]> {
  return reader.list('wikiPages');
}

export function takenSlugs(pages: readonly WikiPage[], exceptId?: string): Set<string> {
  return new Set(pages.filter((p) => p.id !== exceptId).map((p) => p.slug));
}

export function findBySlug(
  pages: readonly WikiPage[],
  slug: string,
): { page?: WikiPage; redirect?: WikiPage } {
  const page = pages.find((p) => p.slug === slug);
  if (page) return { page };
  const redirect = pages.find((p) => p.oldSlugs.includes(slug));
  return redirect ? { redirect } : {};
}

export function findByTitle(pages: readonly WikiPage[], title: string): WikiPage | undefined {
  const key = titleKey(title);
  return pages.find((p) => titleKey(p.title) === key);
}

export async function createPage(input: {
  title: string;
  parentId?: string | null;
  body?: string;
  colour?: ColourKey | null;
}): Promise<WikiPage> {
  const pages = await livePages();
  const parentId = input.parentId ?? null;
  const siblings = pages.filter((p) => p.parentId === parentId).sort(compareBySortKey);
  const title = input.title.trim() || 'Untitled';
  const page = await put('wikiPages', {
    title,
    slug: uniqueSlug(title, takenSlugs(pages)),
    parentId,
    body: '',
    colour: parentId ? null : (input.colour ?? null),
    sortKey: sortKeyAfter(siblings[siblings.length - 1]?.sortKey ?? null),
  });
  if (input.body) await saveBody(wikiIO, bodyStore, page.id, input.body, '');
  return (await reader.get('wikiPages', page.id)) ?? page;
}

/** Pages whose body links to `title` (for the rename prompt). */
export async function pagesLinkingTo(title: string, exceptId: string): Promise<WikiPage[]> {
  return (await livePages()).filter(
    (p) => p.id !== exceptId && p.body.includes('[[') && linksTo(p.body, title),
  );
}

/**
 * Rename a page: new title and a new unique slug (the old slug keeps redirecting). With
 * `updateLinks`, `[[Old title]]` links in other pages are rewritten (as ordinary body edits).
 */
export async function renamePage(
  id: string,
  newTitle: string,
  updateLinks: boolean,
): Promise<WikiPage> {
  const pages = await livePages();
  const page = pages.find((p) => p.id === id);
  if (!page) throw new Error('Page not found');
  const title = newTitle.trim();
  if (!title || title === page.title) return page;
  const slug = uniqueSlug(title, takenSlugs(pages, id), page.slug);
  const oldSlugs =
    slug === page.slug
      ? page.oldSlugs
      : [page.slug, ...page.oldSlugs.filter((s) => s !== slug)].slice(0, 20);
  const updated = await patch('wikiPages', id, { title, slug, oldSlugs });
  if (updateLinks) {
    for (const p of pages) {
      if (p.id === id || !p.body.includes('[[')) continue;
      const r = renameLinks(p.body, page.title, title);
      if (r.count > 0) await saveBody(wikiIO, bodyStore, p.id, r.text, p.body);
    }
  }
  return updated;
}

/** Move a page under `parentId` with `sortKey` (refuses to create a cycle). */
export async function movePage(
  id: string,
  parentId: string | null,
  sortKey: string,
): Promise<void> {
  const pages = await livePages();
  if (parentId === id || (parentId && descendantIds(pages, id).has(parentId))) return;
  const page = pages.find((p) => p.id === id);
  if (!page) return;
  const changes: Partial<WikiPage> = { parentId, sortKey };
  // Only sections (top-level pages) carry a colour.
  if (parentId && page.colour) changes.colour = null;
  await patch('wikiPages', id, changes);
}

/** Move a page one step among its siblings, or indent/outdent it (keyboard alternative to drag). */
export async function nudgePage(
  id: string,
  direction: 'up' | 'down' | 'indent' | 'outdent',
): Promise<void> {
  const pages = await livePages();
  const page = pages.find((p) => p.id === id);
  if (!page) return;
  const siblings = pages.filter((p) => p.parentId === page.parentId).sort(compareBySortKey);
  const i = siblings.findIndex((p) => p.id === id);
  if (direction === 'up' && i > 0) {
    await movePage(
      id,
      page.parentId,
      sortKeyBetween(siblings[i - 2]?.sortKey ?? null, siblings[i - 1]!.sortKey),
    );
  } else if (direction === 'down' && i < siblings.length - 1) {
    await movePage(
      id,
      page.parentId,
      sortKeyBetween(siblings[i + 1]!.sortKey, siblings[i + 2]?.sortKey ?? null),
    );
  } else if (direction === 'indent' && i > 0) {
    const newParent = siblings[i - 1]!;
    const kids = pages.filter((p) => p.parentId === newParent.id).sort(compareBySortKey);
    await movePage(id, newParent.id, sortKeyAfter(kids[kids.length - 1]?.sortKey ?? null));
  } else if (direction === 'outdent' && page.parentId) {
    const parent = pages.find((p) => p.id === page.parentId);
    const grand = parent?.parentId ?? null;
    const aunts = pages.filter((p) => p.parentId === grand).sort(compareBySortKey);
    const pi = aunts.findIndex((p) => p.id === parent?.id);
    await movePage(
      id,
      grand,
      sortKeyBetween(aunts[pi]?.sortKey ?? null, aunts[pi + 1]?.sortKey ?? null),
    );
  }
}

export interface DeleteResult {
  undo: () => Promise<void>;
  count: number;
}

/**
 * Soft-delete a page. Its children are either moved up to the page's parent ('reparent') or
 * deleted with it ('all'). Returns an undo that restores everything as it was.
 */
export async function deletePage(id: string, children: 'reparent' | 'all'): Promise<DeleteResult> {
  const pages = await livePages();
  const page = pages.find((p) => p.id === id);
  if (!page) return { undo: async () => {}, count: 0 };
  const removed: string[] = [id];
  const moved: Array<{ id: string; parentId: string | null; sortKey: string }> = [];
  await transaction(async () => {
    if (children === 'all') {
      for (const d of descendantIds(pages, id)) {
        await remove('wikiPages', d);
        removed.push(d);
      }
    } else {
      const kids = pages.filter((p) => p.parentId === id).sort(compareBySortKey);
      const siblings = pages.filter((p) => p.parentId === page.parentId).sort(compareBySortKey);
      const at = siblings.findIndex((p) => p.id === id);
      let prev = page.sortKey;
      const next = siblings[at + 1]?.sortKey ?? null;
      for (const k of kids) {
        const key = sortKeyBetween(prev, next);
        moved.push({ id: k.id, parentId: k.parentId, sortKey: k.sortKey });
        await patch('wikiPages', k.id, { parentId: page.parentId, sortKey: key });
        prev = key;
      }
    }
    await remove('wikiPages', id);
  });
  return {
    count: removed.length,
    undo: async () => {
      await transaction(async () => {
        for (const r of removed) await restore('wikiPages', r);
        for (const m of moved)
          await patch('wikiPages', m.id, { parentId: m.parentId, sortKey: m.sortKey });
      });
    },
  };
}

export async function setColour(id: string, colour: ColourKey | null): Promise<void> {
  await patch('wikiPages', id, { colour });
}

export async function setPinned(id: string, pinned: boolean): Promise<void> {
  await patch('wikiPages', id, { pinned });
}

/* ---------------------------------------------------------------------- revisions */

export async function listRevisions(pageId: string): Promise<WikiRevision[]> {
  const revs = await reader.list('wikiRevisions', { where: { pageId } });
  return revs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/** Snapshot the page's current body if the policy says so, then prune old revisions. */
export async function snapshotPage(
  pageId: string,
  reason: SnapshotReason,
): Promise<WikiRevision | null> {
  const page = await reader.get('wikiPages', pageId);
  if (!page) return null;
  const revs = await listRevisions(pageId);
  if (!shouldSnapshot(revs[0], page.body, reason, Date.now())) return null;
  const rev = await put('wikiRevisions', {
    pageId,
    title: page.title,
    body: page.body,
    parentRevisionId: revs[0]?.id ?? null,
  });
  await pruneRevisions([rev, ...revs], page.baseRevisionId);
  return rev;
}

async function pruneRevisions(revs: WikiRevision[], protectId: string | null) {
  const ids = revisionsToPrune(revs, Date.now(), undefined, new Set(protectId ? [protectId] : []));
  if (ids.length === 0) return;
  await transaction(async () => {
    for (const id of ids) {
      // Empty the body first so tombstones do not keep the text around.
      await patch('wikiRevisions', id, { body: '' });
      await remove('wikiRevisions', id);
    }
  });
}

/** Restore a revision: snapshot the current text first, then write the old body as a new edit. */
export async function restoreRevision(page: WikiPage, rev: WikiRevision): Promise<void> {
  await snapshotPage(page.id, 'restore');
  const current = await reader.get('wikiPages', page.id);
  if (!current) return;
  await saveBody(wikiIO, bodyStore, page.id, rev.body, current.body);
  await patch('wikiPages', page.id, { baseRevisionId: rev.id });
}

/* ---------------------------------------------------------------------- conflicts */

export async function resolveConflict(page: WikiPage, body: string): Promise<void> {
  await snapshotPage(page.id, 'conflict');
  await resolveConflictBody(wikiIO, bodyStore, page.id, body);
}

export { saveBody };
