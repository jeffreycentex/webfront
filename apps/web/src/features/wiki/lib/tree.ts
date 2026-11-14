import { compareBySortKey, type ColourKey } from '@webfront/shared';

/** Page tree helpers (pure). */

export interface TreePage {
  id: string;
  title: string;
  parentId: string | null;
  sortKey: string;
  colour: ColourKey | null;
}

export interface TreeNode<P extends TreePage = TreePage> {
  page: P;
  depth: number;
  children: TreeNode<P>[];
  /** Colour of the top-level section this page belongs to. */
  colour: ColourKey | null;
}

/**
 * Build the forest. Pages whose parent is missing (deleted, not yet synced) or that sit in
 * a parent cycle (possible after concurrent moves) are shown at the top level, so nothing
 * becomes unreachable.
 */
export function buildTree<P extends TreePage>(pages: readonly P[]): TreeNode<P>[] {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const effectiveParent = new Map<string, string | null>();
  for (const p of pages) {
    let parent = p.parentId && byId.has(p.parentId) ? p.parentId : null;
    // Cycle check: walk up; if we come back to p, detach it.
    const seen = new Set<string>([p.id]);
    let cur = parent;
    while (cur) {
      if (seen.has(cur)) {
        parent = null;
        break;
      }
      seen.add(cur);
      const up = byId.get(cur)?.parentId ?? null;
      cur = up && byId.has(up) ? up : null;
    }
    effectiveParent.set(p.id, parent);
  }
  const kids = new Map<string | null, P[]>();
  for (const p of pages) {
    const parent = effectiveParent.get(p.id) ?? null;
    const list = kids.get(parent) ?? [];
    list.push(p);
    kids.set(parent, list);
  }
  for (const list of kids.values()) list.sort(compareBySortKey);
  const build = (parent: string | null, depth: number, colour: ColourKey | null): TreeNode<P>[] =>
    (kids.get(parent) ?? []).map((page) => {
      const c = depth === 0 ? page.colour : colour;
      return { page, depth, colour: c, children: build(page.id, depth + 1, c) };
    });
  return build(null, 0, null);
}

/** Depth-first list of visible nodes (children of collapsed nodes are skipped). */
export function flattenTree<P extends TreePage>(
  nodes: readonly TreeNode<P>[],
  collapsed: ReadonlySet<string> = new Set(),
): TreeNode<P>[] {
  const out: TreeNode<P>[] = [];
  const walk = (list: readonly TreeNode<P>[]) => {
    for (const n of list) {
      out.push(n);
      if (n.children.length > 0 && !collapsed.has(n.page.id)) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** Ids of all descendants of `id`. */
export function descendantIds(pages: readonly TreePage[], id: string): Set<string> {
  const kids = new Map<string, string[]>();
  for (const p of pages) {
    if (!p.parentId) continue;
    const list = kids.get(p.parentId) ?? [];
    list.push(p.id);
    kids.set(p.parentId, list);
  }
  const out = new Set<string>();
  const stack = [...(kids.get(id) ?? [])];
  while (stack.length) {
    const cur = stack.pop()!;
    if (out.has(cur) || cur === id) continue;
    out.add(cur);
    stack.push(...(kids.get(cur) ?? []));
  }
  return out;
}

/** Ancestors of `id`, root first. */
export function ancestorsOf<P extends TreePage>(pages: readonly P[], id: string): P[] {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const out: P[] = [];
  const seen = new Set<string>([id]);
  let cur = byId.get(id)?.parentId ?? null;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const p = byId.get(cur);
    if (!p) break;
    out.unshift(p);
    cur = p.parentId;
  }
  return out;
}

/** Colour of the top-level section that contains `id`. */
export function sectionColour(pages: readonly TreePage[], id: string): ColourKey | null {
  const chain = ancestorsOf(pages, id);
  const root = chain[0] ?? pages.find((p) => p.id === id);
  return root?.colour ?? null;
}
