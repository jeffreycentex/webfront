// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BookmarkColumns } from './BookmarkColumns';
import { buildSections, type Bookmark, type Category } from './model';

afterEach(cleanup);

const cats = [
  { id: 'c1', name: 'Homelab', colour: 'teal', parentId: null, sortKey: 'a0' },
  { id: 'c2', name: 'Storage', colour: 'blue', parentId: 'c1', sortKey: 'a0' },
] as unknown as Category[];
const items = [
  {
    id: 'b1',
    title: 'Proxmox',
    url: 'https://pve.lan/',
    categoryId: 'c1',
    tags: ['vm'],
    username: 'root',
    hint: null,
    notes: 'x',
    sortKey: 'a0',
    isService: true,
    serviceCheck: null,
  },
  {
    id: 'b2',
    title: 'NAS',
    url: 'https://nas.lan/',
    categoryId: 'c2',
    tags: [],
    username: null,
    hint: null,
    notes: '',
    sortKey: 'a0',
    isService: false,
    serviceCheck: null,
  },
] as unknown as Bookmark[];

function renderColumns(list: Bookmark[]) {
  const sections = buildSections(cats, list);
  return render(
    <BookmarkColumns
      sections={sections}
      allSections={sections}
      statuses={new Map()}
      tagColours={{}}
      activeId={null}
      linkResults={new Map()}
      dragEnabled={false}
      collapsed={new Set()}
      onToggleCollapsed={() => {}}
      onDetails={() => {}}
      onEditBookmark={() => {}}
      onDeleteBookmark={() => {}}
      onMoveBookmark={() => {}}
      onAddBookmark={() => {}}
      onEditCategory={() => {}}
      onAddSubcategory={() => {}}
      onDeleteCategory={() => {}}
    />,
  );
}

describe('BookmarkColumns', () => {
  it('never makes a stored javascript: or data: URL clickable', () => {
    renderColumns([
      { ...items[0]!, id: 'x1', title: 'Evil JS', url: 'javascript:alert(document.cookie)' },
      {
        ...items[1]!,
        id: 'x2',
        title: 'Evil data',
        url: 'data:text/html,<script>alert(1)</script>',
      },
    ] as Bookmark[]);
    for (const name of ['Evil JS', 'Evil data']) {
      const anchor = screen.getByText(name).closest('a')!;
      expect(anchor.hasAttribute('href'), name).toBe(false);
    }
  });

  it('renders categories, sub-headings and real new-tab anchors', () => {
    const sections = buildSections(cats, items);
    render(
      <BookmarkColumns
        sections={sections}
        allSections={sections}
        statuses={new Map()}
        tagColours={{}}
        activeId="b1"
        linkResults={new Map()}
        dragEnabled
        collapsed={new Set()}
        onToggleCollapsed={() => {}}
        onDetails={() => {}}
        onEditBookmark={() => {}}
        onDeleteBookmark={() => {}}
        onMoveBookmark={() => {}}
        onAddBookmark={() => {}}
        onEditCategory={() => {}}
        onAddSubcategory={() => {}}
        onDeleteCategory={() => {}}
      />,
    );
    expect(screen.getByRole('heading', { name: /Homelab/ })).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Proxmox/ });
    expect(link).toHaveAttribute('href', 'https://pve.lan/');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(
      within(screen.getByRole('link', { name: /NAS/ }).closest('div')!.parentElement!).getByText(
        'Storage',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Has notes')).toBeInTheDocument();
  });
});
