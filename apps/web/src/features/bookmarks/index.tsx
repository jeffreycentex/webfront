import { Bookmark } from 'lucide-react';
import { lazy } from 'react';
import { defineFeature } from '../types';
import { bookmarkSearchProvider } from './search';

/**
 * Feature: bookmarks (with service tiles and the save-this-page bookmarklet) — owner: Task 5.
 * Kept tiny: everything heavy loads lazily (dnd-kit with the page, markdown-it with the notes view).
 */
const BookmarksWidget = lazy(() => import('./BookmarksWidget'));
const ServicesWidget = lazy(() => import('./ServicesWidget'));
const BookmarkletSettings = lazy(() => import('./BookmarkletSettings'));

export default defineFeature({
  id: 'bookmarks',
  routes: [
    {
      path: 'bookmarks',
      lazy: async () => ({ Component: (await import('./BookmarksPage')).BookmarksPage }),
    },
  ],
  bareRoutes: [
    {
      path: '/capture',
      lazy: async () => ({ Component: (await import('./CapturePage')).CapturePage }),
    },
  ],
  nav: {
    label: 'Bookmarks',
    icon: Bookmark,
    path: '/bookmarks',
    order: 10,
    shortcut: 'g b',
    phoneOrder: 3,
  },
  dashboardWidgets: [
    { id: 'bookmarks', title: 'Bookmarks', order: 10, component: BookmarksWidget },
    { id: 'services', title: 'Services', order: 20, component: ServicesWidget },
  ],
  searchProvider: bookmarkSearchProvider,
  settingsPanels: [
    {
      id: 'bookmarklet',
      title: 'Save-this-page bookmarklet',
      order: 40,
      component: BookmarkletSettings,
    },
  ],
  commands: [
    {
      id: 'bookmarks.new',
      title: 'New bookmark',
      keywords: ['add', 'link', 'save'],
      run: ({ navigate }) => void navigate('/bookmarks?new=bookmark'),
    },
    {
      id: 'bookmarks.newCategory',
      title: 'New bookmark category',
      keywords: ['add', 'folder', 'group'],
      run: ({ navigate }) => void navigate('/bookmarks?new=category'),
    },
    {
      id: 'bookmarks.checkLinks',
      title: 'Check bookmarks for dead links',
      keywords: ['broken', 'verify'],
      run: ({ navigate }) => void navigate('/bookmarks?check=1'),
    },
  ],
});
