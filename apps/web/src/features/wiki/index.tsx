import { BookOpen } from 'lucide-react';
import { lazy } from 'react';
import { defineFeature } from '../types';
import { onPullApplied } from '@/data';
import { reconcileNow, registerWikiResolver } from './runtime';

/**
 * Feature: wiki — owner: Task 8.
 *
 * Kept tiny: the page (markdown-it, dnd-kit), the editor (CodeMirror, its own chunk), search
 * (MiniSearch) and the background reconciler/uploader all load lazily. Only the body-merge
 * record resolver is registered eagerly, so it is in place before the first pull.
 */

registerWikiResolver();

if (typeof window !== 'undefined' && import.meta.env.MODE !== 'test') {
  // Background work: reconcile concurrent body edits, upload images pasted while offline.
  setTimeout(() => {
    void import('./background').then((m) => m.start()).catch(() => undefined);
    // Reconcile as soon as a pulled page lands instead of waiting for the 4 s poll.
    onPullApplied(() => void reconcileNow());
  }, 1500);
}

const WikiWidget = lazy(() => import('./WikiWidget'));

const loadPage = async () => ({ Component: (await import('./WikiPage')).WikiPage });

export default defineFeature({
  id: 'wiki',
  routes: [{ path: 'wiki/*', lazy: loadPage }],
  nav: { label: 'Wiki', icon: BookOpen, path: '/wiki', order: 60, shortcut: 'g w' },
  dashboardWidgets: [{ id: 'wiki', title: 'Wiki', order: 60, component: WikiWidget }],
  searchProvider: {
    id: 'wiki',
    label: 'Wiki',
    search: async (query, limit) => {
      try {
        return await (await import('./search')).search(query, limit);
      } catch {
        return [];
      }
    },
  },
  commands: [
    {
      id: 'wiki.new',
      title: 'New wiki page',
      keywords: ['wiki', 'page', 'note', 'create', 'add'],
      run: ({ navigate }) => void navigate('/wiki?new=1'),
    },
    {
      id: 'wiki.search',
      title: 'Search wiki',
      keywords: ['wiki', 'find', 'full text'],
      run: ({ navigate }) => void navigate('/wiki?search=1'),
    },
  ],
});
