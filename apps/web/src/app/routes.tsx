import type { RouteObject } from 'react-router';
import type { FeatureDescriptor } from '../features/types';
import { RouteError } from './errors';
import { Layout } from './Layout';
import { NotFound } from './NotFound';
import { RouteFallback } from './RouteFallback';

/**
 * Build the router tree from the feature registry (Task 4, app shell).
 *
 * - `bareRoutes` render without chrome (bookmarklet capture window).
 * - `routes` render inside `Layout`, each with its own error boundary (unless the route sets
 *   one), so a crashing page keeps the navigation visible.
 * - Route-level code splitting: a feature route may use react-router's `lazy:` (or
 *   `React.lazy` in its Component); the layout shows a progress bar while it loads.
 *   `/dev/ui` (design-system gallery) is lazy-loaded here.
 */
export function buildRoutes(features: readonly FeatureDescriptor[]): RouteObject[] {
  return [
    ...features.flatMap((f) => f.bareRoutes ?? []),
    {
      path: '/',
      Component: Layout,
      ErrorBoundary: RouteError,
      HydrateFallback: RouteFallback,
      // Each page gets its own error boundary, so a crashing page keeps the navigation visible.
      children: [
        ...features.flatMap((f) => f.routes),
        {
          path: 'dev/ui',
          lazy: async () => ({ Component: (await import('./DevUiPage')).DevUiPage }),
        },
        { path: '*', Component: NotFound },
      ].map((r): RouteObject => ({ ErrorBoundary: RouteError, ...r })),
    },
  ];
}
