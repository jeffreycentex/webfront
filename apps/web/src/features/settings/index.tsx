import { Settings } from 'lucide-react';
import { defineFeature } from '../types';

/**
 * Feature: settings — owner: Task 10. The page and every section load lazily. It renders each
 * feature's `settingsPanels` (from `useFeatures()`) between its own sections.
 */
export default defineFeature({
  id: 'settings',
  routes: [
    {
      path: 'settings',
      lazy: async () => ({ Component: (await import('./SettingsPage')).SettingsPage }),
    },
  ],
  commands: [
    {
      id: 'settings.recentlyDeleted',
      title: 'Recently deleted',
      keywords: ['restore', 'undelete', 'trash', 'bin', 'recover', 'undo'],
      run: ({ navigate }) => void navigate('/settings#deleted'),
    },
  ],
  nav: { label: 'Settings', icon: Settings, path: '/settings', order: 90, shortcut: 'g ,' },
});
