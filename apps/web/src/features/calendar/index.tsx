import { CalendarDays } from 'lucide-react';
import { lazy } from 'react';
import { defineFeature } from '../types';
import { commands } from './commands';
import { calendarSearchProvider } from './search';

/**
 * Feature: calendar — owner: Task 9. Read-only ICS feeds merged into agenda and month views,
 * all from local synced data (calendarFeeds + server-expanded calendarEvents).
 * Routes, the dashboard widget and the settings panel are lazy.
 */
const AgendaWidget = lazy(() => import('./AgendaWidget'));
const FeedsPanel = lazy(() => import('./FeedsPanel'));

export default defineFeature({
  id: 'calendar',
  routes: [
    {
      path: 'calendar',
      lazy: async () => ({ Component: (await import('./CalendarPage')).CalendarPage }),
    },
  ],
  nav: { label: 'Calendar', icon: CalendarDays, path: '/calendar', order: 50, shortcut: 'g c' },
  dashboardWidgets: [{ id: 'agenda', title: 'Today', order: 40, component: AgendaWidget }],
  searchProvider: calendarSearchProvider,
  settingsPanels: [
    { id: 'calendar-feeds', title: 'Calendar feeds', order: 40, component: FeedsPanel },
  ],
  commands,
});
