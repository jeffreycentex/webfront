import type { ColourKey } from '@webfront/shared';
import type { ComponentType } from 'react';
import type { NavigateFunction, RouteObject } from 'react-router';

/**
 * The web feature descriptor (Task 1 contract). Every feature folder's `index.tsx` default-
 * exports one of these; `registry.ts` collects them; the app shell (Task 4) and dashboard /
 * search / settings (Task 10) consume them via `useFeatures()`.
 */

export interface IconProps {
  className?: string;
  size?: number | string;
  strokeWidth?: number | string;
}

export interface NavEntry {
  label: string;
  /** A lucide-react icon or any component taking IconProps. */
  icon: ComponentType<IconProps>;
  /** Absolute in-app path, e.g. '/bookmarks'. */
  path: string;
  /** Lower comes first in the sidebar / bottom tab bar. */
  order: number;
  /** Keyboard shortcut shown in tooltips, e.g. 'g b'. Bound by the app shell. */
  shortcut?: string;
  /**
   * Live count shown as a small badge next to the label (sidebar and phone tab bar); hidden
   * when it returns 0 or undefined. Called as a React hook, so it may use `@/data` hooks, but
   * it must be the same function for the lifetime of the app.
   */
  useBadge?: () => number | undefined;
  /** Position in the phone tab bar (lower first; the first four are shown, the rest under "More"). Defaults to `1000 + order`. */
  phoneOrder?: number;
}

/** Props every dashboard widget may receive; widgets that ignore them are unaffected. */
export interface DashboardWidgetProps {
  /** The dashboard search bar's current text (live filter), '' when empty. */
  query?: string;
}

export interface DashboardWidget {
  /** Stable id, stored in the `dashboard.sections` setting (see DASHBOARD_SECTION_IDS). */
  id: string;
  title: string;
  component: ComponentType<DashboardWidgetProps>;
  /** Default position on the dashboard (lower first) when the user has not reordered. */
  order: number;
}

export interface SearchResult {
  /** Unique within the provider. */
  id: string;
  title: string;
  subtitle?: string;
  /** In-app path ('/wiki/home') or, with `external: true`, an absolute URL (bookmarks). */
  href: string;
  external?: boolean;
  /** Higher ranks first across providers; aim for 0..1. */
  score: number;
  colour?: ColourKey;
  icon?: ComponentType<IconProps>;
}

/** Search over this feature's local data for the dashboard search bar / command palette. */
export interface SearchProvider {
  id: string;
  label: string;
  /** Must be fast (local data only) and never throw; return [] for no matches. */
  search(query: string, limit: number): Promise<SearchResult[]>;
}

export interface SettingsPanel {
  id: string;
  title: string;
  component: ComponentType;
  order: number;
}

export interface CommandContext {
  navigate: NavigateFunction;
}

/** Entry in the Ctrl/Cmd+K command palette. */
export interface Command {
  id: string;
  title: string;
  keywords?: string[];
  shortcut?: string;
  run(ctx: CommandContext): void | Promise<void>;
}

export interface FeatureDescriptor {
  /** Folder name, e.g. 'bookmarks'. */
  id: string;
  /**
   * Routes rendered inside the app layout (nav, header). Paths are relative to '/', without a
   * leading slash ('bookmarks', 'wiki/:slug'); use `index: true` for the home page.
   */
  routes: RouteObject[];
  /** Routes rendered without the layout chrome (e.g. the bookmarklet capture window). */
  bareRoutes?: RouteObject[];
  nav?: NavEntry;
  dashboardWidgets?: DashboardWidget[];
  searchProvider?: SearchProvider;
  settingsPanels?: SettingsPanel[];
  commands?: Command[];
}

export function defineFeature(descriptor: FeatureDescriptor): FeatureDescriptor {
  return descriptor;
}
