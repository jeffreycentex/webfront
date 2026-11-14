import { registerSW } from 'virtual:pwa-register';
import { setPwaState, setPwaUpdater } from './pwaState';

const UPDATE_CHECK_MS = 60 * 60 * 1000;

/**
 * Register the service worker. The update is never applied silently: when a new version is
 * waiting, `needRefresh` flips and the shell shows "Update available, reload". Called once from
 * main.tsx (production builds only have a worker; in dev the plugin is a no-op).
 */
export function initPwa(): void {
  const update = registerSW({
    immediate: true,
    onNeedRefresh: () => setPwaState({ needRefresh: true }),
    onOfflineReady: () => setPwaState({ offlineReady: true }),
    onRegisteredSW: (_url, registration) => {
      if (!registration) return;
      // Long-lived tabs (this replaces the new-tab page) check for updates hourly.
      setInterval(() => {
        if (navigator.onLine) void registration.update().catch(() => {});
      }, UPDATE_CHECK_MS);
    },
  });
  setPwaUpdater(update);
}
