import type { Command } from '../types';

/** Commands navigate to the page with a timestamp in location.state; the page acts on it. */
export const commands: Command[] = [
  {
    id: 'calendar.today',
    title: 'Go to today',
    keywords: ['calendar', 'agenda', 'now'],
    run: ({ navigate }) => navigate('/calendar', { state: { jump: Date.now() } }),
  },
  {
    id: 'calendar.refresh',
    title: 'Refresh calendars',
    keywords: ['calendar', 'sync', 'ics', 'feeds', 'reload'],
    run: ({ navigate }) => navigate('/calendar', { state: { refresh: Date.now() } }),
  },
  {
    id: 'calendar.addFeed',
    title: 'Add calendar feed',
    keywords: ['calendar', 'ics', 'outlook', 'google', 'subscribe'],
    run: ({ navigate }) => navigate('/calendar', { state: { addFeed: Date.now() } }),
  },
];
