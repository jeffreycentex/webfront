import { StickyNote } from 'lucide-react';
import { lazy } from 'react';
import { defineFeature } from '../types';
import { commands } from './commands';
import { postitsSearchProvider } from './search';

/**
 * Feature: postits — owner: Task 6. Routes and the dashboard widget are lazy.
 * Search results link to `/postits?focus=<id>`.
 */
const PostitsWidget = lazy(() => import('./PostitsWidget'));

export default defineFeature({
  id: 'postits',
  routes: [
    {
      path: 'postits',
      lazy: async () => ({ Component: (await import('./PostitsPage')).PostitsPage }),
    },
  ],
  nav: { label: 'Post-its', icon: StickyNote, path: '/postits', order: 20, shortcut: 'g p' },
  dashboardWidgets: [{ id: 'postits', title: 'Post-its', order: 30, component: PostitsWidget }],
  searchProvider: postitsSearchProvider,
  commands,
});
