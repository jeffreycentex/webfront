import { z } from 'zod';
import { colourKeySchema } from '../colours.js';

/**
 * Owner: Task 10 (Dashboard/settings) for the core keys below.
 *
 * Settings are key/value records whose record `id` IS the key (registry `idKind: 'key'`),
 * so two devices setting the same key converge on one record. Values are any JSON.
 *
 * Feature-specific settings: define them in your own feature folder with `defineSetting`
 * using a namespaced key (`bookmarks.openInNewTab`), instead of editing this file.
 */

export const SETTING_KEY_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;
export const settingKeySchema = z.string().max(100).regex(SETTING_KEY_PATTERN);

export const settingFields = z.object({
  value: z.json(),
});

export interface SettingDef<T> {
  key: string;
  schema: z.ZodType<T>;
  defaultValue: T;
}

export function defineSetting<T>(
  key: string,
  schema: z.ZodType<T>,
  defaultValue: T,
): SettingDef<T> {
  if (!SETTING_KEY_PATTERN.test(key)) throw new Error(`invalid setting key: ${key}`);
  return { key, schema, defaultValue };
}

/** Read a setting value safely: falls back to the default when missing or invalid. */
export function readSetting<T>(def: SettingDef<T>, raw: unknown): T {
  const parsed = def.schema.safeParse(raw);
  return parsed.success ? parsed.data : def.defaultValue;
}

export const DASHBOARD_SECTION_IDS = [
  'search',
  'bookmarks',
  'services',
  'postits',
  'agenda',
  'tasks',
  'shopping',
  'wiki',
] as const;

/* ---------------------------------------------------------------- web search engines */

/**
 * Check a web-search URL template: it must contain `%s` (replaced with the URL-encoded query)
 * and be an http(s) URL once filled in. Returns an error message, or null when valid.
 */
export function validateSearchTemplate(template: string): string | null {
  const t = template.trim();
  if (!t) return 'Enter a search URL.';
  if (t.length > 2000) return 'That URL is too long.';
  if (!t.includes('%s')) return 'The URL must contain %s where the search text goes.';
  let url: URL;
  try {
    url = new URL(t.split('%s').join('webfront'));
  } catch {
    return 'That is not a valid URL. Example: https://example.com/search?q=%s';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'Use an http or https URL.';
  return null;
}

/** The search URL for `query` (every `%s` becomes the URL-encoded text). */
export function buildSearchUrl(template: string, query: string): string {
  return template.trim().split('%s').join(encodeURIComponent(query.trim()));
}

export const SEARCH_ENGINE_PRESETS = [
  { name: 'DuckDuckGo', urlTemplate: 'https://duckduckgo.com/?q=%s' },
  { name: 'Google', urlTemplate: 'https://www.google.com/search?q=%s' },
  { name: 'Bing', urlTemplate: 'https://www.bing.com/search?q=%s' },
  { name: 'Kagi', urlTemplate: 'https://kagi.com/search?q=%s' },
  { name: 'Brave', urlTemplate: 'https://search.brave.com/search?q=%s' },
  { name: 'Startpage', urlTemplate: 'https://www.startpage.com/do/search?q=%s' },
] as const;

/* ------------------------------------------------------------------ dashboard sections */

export interface DashboardSectionSetting {
  id: string;
  hidden: boolean;
}

export interface ResolvedSection {
  id: string;
  title: string;
  hidden: boolean;
}

/**
 * Combine the widgets the registered features provide with the saved `dashboard.sections`
 * setting: saved ids first in saved order (ids no feature provides are dropped), then widgets
 * the setting does not know yet, each placed after its default-order predecessor (so a new
 * feature appears in its default spot without the user doing anything). The `search` entry is the search bar: it is not a widget and always
 * sits on top, so it is returned separately.
 */
export function resolveDashboardSections(
  widgets: readonly { id: string; title: string; order: number }[],
  saved: readonly DashboardSectionSetting[],
): { searchHidden: boolean; sections: ResolvedSection[] } {
  const byId = new Map(widgets.map((w) => [w.id, w]));
  const seen = new Set<string>();
  const sections: ResolvedSection[] = [];
  for (const s of saved) {
    const w = byId.get(s.id);
    if (!w || seen.has(s.id)) continue;
    seen.add(s.id);
    sections.push({ id: s.id, title: w.title, hidden: s.hidden });
  }
  // Widgets the setting does not know yet go right after the widget that precedes them in the
  // default order (or first, when none does), so a new section lands in its default spot.
  const byDefault = [...widgets].sort((a, b) => a.order - b.order);
  byDefault.forEach((w, i) => {
    if (seen.has(w.id)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = sections.findIndex((s) => s.id === byDefault[j]!.id);
      if (k >= 0) {
        at = k + 1;
        break;
      }
    }
    sections.splice(at, 0, { id: w.id, title: w.title, hidden: false });
  });
  return { searchHidden: saved.find((s) => s.id === 'search')?.hidden ?? false, sections };
}

/** The setting value for an edited list (the search bar entry is kept first). */
export function sectionsToSetting(
  sections: readonly ResolvedSection[],
  searchHidden: boolean,
): DashboardSectionSetting[] {
  return [
    { id: 'search', hidden: searchHidden },
    ...sections.map((s) => ({ id: s.id, hidden: s.hidden })),
  ];
}

export const coreSettings = {
  searchEngine: defineSetting(
    'search.engine',
    z.object({
      name: z.string().min(1).max(100),
      /** `%s` is replaced with the URL-encoded query. */
      urlTemplate: z
        .string()
        .max(2000)
        .refine((t) => validateSearchTemplate(t) === null, 'Invalid search URL template'),
    }),
    { name: 'DuckDuckGo', urlTemplate: 'https://duckduckgo.com/?q=%s' },
  ),
  dashboardSections: defineSetting(
    'dashboard.sections',
    z.array(z.object({ id: z.string().min(1).max(100), hidden: z.boolean() })),
    DASHBOARD_SECTION_IDS.map((id) => ({ id, hidden: false })),
  ),
  theme: defineSetting('appearance.theme', z.enum(['system', 'light', 'dark']), 'system' as const),
  tagColours: defineSetting(
    'tags.colours',
    z.record(z.string(), colourKeySchema),
    {} as Record<string, z.infer<typeof colourKeySchema>>,
  ),
  /** Idle convenience lock; null = off. */
  idleLockMinutes: defineSetting('lock.idleMinutes', z.int().min(1).max(1440).nullable(), null),
} as const;
