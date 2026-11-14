import { ListTodo } from 'lucide-react';
import { defineFeature } from '../types';
import { commands } from './commands';
import { tasksSearchProvider } from './search';
import { useDueBadge } from './useDueBadge';

/**
 * Feature: tasks — owner: Task 6. The route is lazy; everything heavy lives in TasksPage.
 *
 * Other features (the dashboard agenda) read the `tasks` collection directly through `@/data`:
 * see the field notes on `taskFields` in packages/shared/src/collections/notes.ts.
 * The nav entry shows an overdue + due-today badge.
 */
export default defineFeature({
  id: 'tasks',
  routes: [
    {
      path: 'tasks',
      lazy: async () => ({ Component: (await import('./TasksPage')).TasksPage }),
    },
  ],
  nav: {
    label: 'Tasks',
    icon: ListTodo,
    path: '/tasks',
    order: 30,
    shortcut: 'g t',
    phoneOrder: 2,
    useBadge: useDueBadge,
  },
  searchProvider: tasksSearchProvider,
  commands,
});
