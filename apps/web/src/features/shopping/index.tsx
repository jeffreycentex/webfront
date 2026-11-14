import { ShoppingCart } from 'lucide-react';
import { lazy } from 'react';
import { defineFeature } from '../types';
import { shoppingSearch } from './search';

const ShoppingWidget = lazy(() => import('./ShoppingWidget'));

/**
 * Feature: shopping — owner: Task 7. Multiple lists, quick add with history, store sections.
 * Keep this file tiny: routes and the widget are lazy.
 */
export default defineFeature({
  id: 'shopping',
  routes: [
    {
      path: 'shopping',
      lazy: async () => ({ Component: (await import('./ShoppingPage')).ShoppingPage }),
    },
  ],
  nav: {
    label: 'Shopping',
    icon: ShoppingCart,
    path: '/shopping',
    order: 40,
    shortcut: 'g s',
    phoneOrder: 1,
  },
  dashboardWidgets: [
    { id: 'shopping', title: 'Shopping list', order: 50, component: ShoppingWidget },
  ],
  searchProvider: shoppingSearch,
  commands: [
    {
      id: 'shopping.add',
      title: 'Add to shopping list',
      keywords: ['shopping', 'groceries', 'buy', 'item'],
      run: ({ navigate }) => navigate('/shopping?add=1'),
    },
    {
      id: 'shopping.newList',
      title: 'New shopping list',
      keywords: ['shopping', 'list', 'create'],
      run: ({ navigate }) => navigate('/shopping?new=1'),
    },
  ],
});
