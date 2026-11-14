import { LayoutDashboard } from 'lucide-react';
import { defineFeature } from '../types';

/**
 * Feature: dashboard (home page) — owner: Task 10. The page is lazy; it renders every other
 * feature's dashboard widgets from `useFeatures()` and never imports them.
 */
export default defineFeature({
  id: 'dashboard',
  routes: [
    {
      index: true,
      lazy: async () => ({ Component: (await import('./DashboardPage')).DashboardPage }),
    },
  ],
  nav: {
    label: 'Home',
    icon: LayoutDashboard,
    path: '/',
    order: 0,
    shortcut: 'g h',
    phoneOrder: 0,
  },
});
