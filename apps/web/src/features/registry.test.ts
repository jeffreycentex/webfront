import { DASHBOARD_SECTION_IDS } from '@webfront/shared';
import { describe, expect, it } from 'vitest';
import { buildRoutes } from '../app/routes';
import { buildRegistry } from './context';
import { features } from './registry';

describe('feature registry', () => {
  const registry = buildRegistry(features);

  it('has unique feature ids matching their folders', () => {
    const ids = features.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(
      [
        'bookmarks',
        'calendar',
        'dashboard',
        'postits',
        'settings',
        'shopping',
        'tasks',
        'wiki',
      ].sort(),
    );
  });

  it('has unique nav paths and route paths', () => {
    const navPaths = registry.nav.map((n) => n.path);
    expect(new Set(navPaths).size).toBe(navPaths.length);
    const routePaths = features.flatMap((f) => f.routes.map((r) => (r.index ? '<index>' : r.path)));
    expect(new Set(routePaths).size).toBe(routePaths.length);
    for (const p of routePaths) expect(p?.startsWith('/')).toBe(false);
  });

  it('uses dashboard widget ids from the shared section list', () => {
    const ids = registry.dashboardWidgets.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(DASHBOARD_SECTION_IDS as readonly string[]).toContain(id);
  });

  it('builds a router tree with the layout and a catch-all', () => {
    const routes = buildRoutes(features);
    const root = routes.find((r) => r.path === '/');
    expect(root?.children?.some((c) => c.path === '*')).toBe(true);
    expect(routes.some((r) => r.path === '/capture')).toBe(true);
  });
});
