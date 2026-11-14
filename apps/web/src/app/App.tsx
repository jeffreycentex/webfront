import { useMemo } from 'react';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { AuthGate, AuthProvider } from '../auth';
import { FeatureRegistryProvider } from '../features/context';
import { features } from '../features/registry';
import { ToastProvider } from '../ui';
import { AppErrorBoundary } from './errors';
import { buildRoutes } from './routes';

/**
 * Root component (Task 4, app shell): error boundary > toasts > auth (sign-in, lock, offline
 * rules, sync lifecycle) > feature registry > router. Theme is applied before first paint by
 * `public/theme-init.js` and kept in sync by `initTheme()` (main.tsx).
 */
export function App() {
  const router = useMemo(() => createBrowserRouter(buildRoutes(features)), []);
  return (
    <AppErrorBoundary>
      <ToastProvider>
        <AuthProvider>
          <AuthGate>
            <FeatureRegistryProvider features={features}>
              <RouterProvider router={router} />
            </FeatureRegistryProvider>
          </AuthGate>
        </AuthProvider>
      </ToastProvider>
    </AppErrorBoundary>
  );
}
