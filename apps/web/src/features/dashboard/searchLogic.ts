import { buildSearchUrl, type ColourKey } from '@webfront/shared';
import type { ComponentType } from 'react';
import type { IconProps, SearchResult } from '../types';

/**
 * Pure logic of the dashboard search bar: URL detection, grouping provider results and building
 * the flat, keyboard-navigable option list. No React, so it is unit tested directly.
 */

/** File extensions that look like a top-level domain but almost never are one. */
const NOT_A_TLD = new Set([
  'txt',
  'md',
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'csv',
  'json',
  'xml',
  'yaml',
  'yml',
  'js',
  'ts',
  'tsx',
  'jsx',
  'css',
  'html',
  'htm',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'sh',
  'zip',
  'tar',
  'gz',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'mp3',
  'mp4',
  'mov',
  'log',
  'ini',
  'conf',
  'exe',
  'dmg',
  'iso',
  'lock',
]);

const HOST_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME_RE = new RegExp(
  `^(?:localhost|${HOST_LABEL}(?:\\.${HOST_LABEL})*\\.([a-z]{2,24})|\\d{1,3}(?:\\.\\d{1,3}){3})(?::\\d{1,5})?(?:[/?#]\\S*)?$`,
  'i',
);

/**
 * If `input` is a web address or a bare hostname (`example.com`, `localhost:3000/x`,
 * `192.168.1.5`, `https://a.b/c`), the URL to open; otherwise null. Only http(s) is produced.
 */
export function looksLikeUrl(input: string): string | null {
  const q = input.trim();
  if (!q || /\s/.test(q)) return null;
  if (/^https?:\/\/\S+$/i.test(q)) {
    try {
      const u = new URL(q);
      return u.hostname ? u.href : null;
    } catch {
      return null;
    }
  }
  const m = HOSTNAME_RE.exec(q);
  if (!m) return null;
  const tld = m[1]?.toLowerCase();
  if (tld && NOT_A_TLD.has(tld)) return null;
  const local = /^(localhost|\d{1,3}(\.\d{1,3}){3})(:|\/|\?|#|$)/i.test(q);
  try {
    return new URL(`${local ? 'http' : 'https'}://${q}`).href;
  } catch {
    return null;
  }
}

export interface ProviderResults {
  providerId: string;
  label: string;
  colour: ColourKey;
  results: SearchResult[];
}

export interface SearchOption {
  key: string;
  kind: 'url' | 'result' | 'web';
  title: string;
  subtitle?: string | undefined;
  /** Where Enter goes. */
  href: string;
  /** `href` is an in-app route (react-router) rather than an absolute URL. */
  internal: boolean;
  /** Group label for `result` options. */
  group?: string | undefined;
  colour?: ColourKey | undefined;
  icon?: ComponentType<IconProps> | undefined;
}

/** Order groups by their best result (so the top option is the top-ranked result overall). */
export function groupResults(groups: readonly ProviderResults[]): ProviderResults[] {
  const best = (g: ProviderResults) => Math.max(...g.results.map((r) => r.score), -Infinity);
  return groups
    .filter((g) => g.results.length > 0)
    .map((g) => ({ ...g, results: [...g.results].sort((a, b) => b.score - a.score) }))
    .sort((a, b) => best(b) - best(a));
}

/**
 * The flat option list: [open-this-address?] + provider results (grouped) + web search.
 * Enter acts on the active option, which starts at index 0, so a typed address goes straight
 * there, otherwise the top result opens, and with no results the web search is the only option.
 */
export function buildOptions(
  query: string,
  groups: readonly ProviderResults[],
  engine: { name: string; urlTemplate: string },
): SearchOption[] {
  const q = query.trim();
  if (!q) return [];
  const options: SearchOption[] = [];
  const url = looksLikeUrl(q);
  if (url) {
    options.push({
      key: 'url',
      kind: 'url',
      title: `Open ${url.replace(/^https?:\/\//, '').replace(/\/$/, '')}`,
      href: url,
      internal: false,
    });
  }
  for (const g of groupResults(groups)) {
    for (const r of g.results) {
      options.push({
        key: `${g.providerId}:${r.id}`,
        kind: 'result',
        title: r.title,
        subtitle: r.subtitle,
        href: r.href,
        internal: !r.external,
        group: g.label,
        colour: r.colour ?? g.colour,
        icon: r.icon,
      });
    }
  }
  options.push({
    key: 'web',
    kind: 'web',
    title: `Search the web for “${q}”`,
    subtitle: engine.name,
    href: buildSearchUrl(engine.urlTemplate, q),
    internal: false,
  });
  return options;
}

export type Activation = 'default' | 'web' | 'newTab';

/** Which option Enter picks: Ctrl/Cmd+Enter forces the web search, otherwise the active one. */
export function pickOption(
  options: readonly SearchOption[],
  active: number,
  modifiers: { mod: boolean },
): SearchOption | undefined {
  if (modifiers.mod) return options.find((o) => o.kind === 'web');
  return options[Math.min(Math.max(active, 0), options.length - 1)];
}
