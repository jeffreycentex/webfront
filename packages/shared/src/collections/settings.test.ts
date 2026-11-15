import { describe, expect, it } from 'vitest';
import {
  SEARCH_ENGINE_PRESETS,
  buildSearchUrl,
  coreSettings,
  readSetting,
  resolveDashboardSections,
  sectionsToSetting,
  validateSearchTemplate,
} from './settings.js';

describe('search engine templates', () => {
  it('validates the template', () => {
    expect(validateSearchTemplate('https://example.com/?q=%s')).toBeNull();
    expect(validateSearchTemplate('http://localhost:8080/s/%s')).toBeNull();
    expect(validateSearchTemplate('')).toMatch(/Enter/);
    expect(validateSearchTemplate('https://example.com/?q=')).toMatch(/%s/);
    expect(validateSearchTemplate('not a url %s')).toMatch(/valid URL/);
    expect(validateSearchTemplate('javascript:alert(%s)')).toMatch(/http/);
    expect(validateSearchTemplate('ftp://example.com/%s')).toMatch(/http/);
  });

  it('every preset is valid and the setting rejects bad templates', () => {
    for (const p of SEARCH_ENGINE_PRESETS) expect(validateSearchTemplate(p.urlTemplate)).toBeNull();
    const bad = { name: 'x', urlTemplate: 'javascript:%s' };
    expect(readSetting(coreSettings.searchEngine, bad)).toEqual(
      coreSettings.searchEngine.defaultValue,
    );
  });

  it('encodes the query and replaces every %s', () => {
    expect(buildSearchUrl('https://e.com/?q=%s', ' a b&c/d ')).toBe(
      'https://e.com/?q=a%20b%26c%2Fd',
    );
    expect(buildSearchUrl('https://e.com/%s?q=%s', 'x y')).toBe('https://e.com/x%20y?q=x%20y');
    expect(buildSearchUrl('https://e.com/?q=%s', '$&')).toBe('https://e.com/?q=%24%26');
  });
});

describe('resolveDashboardSections', () => {
  const widgets = [
    { id: 'bookmarks', title: 'Bookmarks', order: 10 },
    { id: 'agenda', title: 'Today', order: 40 },
    { id: 'wiki', title: 'Wiki', order: 60 },
  ];

  it('uses default order without a saved setting', () => {
    const r = resolveDashboardSections(widgets, []);
    expect(r.sections.map((s) => s.id)).toEqual(['bookmarks', 'agenda', 'wiki']);
    expect(r.searchHidden).toBe(false);
  });

  it('applies saved order and visibility, drops unknown ids, appends new widgets', () => {
    const r = resolveDashboardSections(widgets, [
      { id: 'search', hidden: true },
      { id: 'wiki', hidden: false },
      { id: 'gone', hidden: false },
      { id: 'bookmarks', hidden: true },
    ]);
    expect(r.searchHidden).toBe(true);
    expect(r.sections).toEqual([
      { id: 'wiki', title: 'Wiki', hidden: false },
      { id: 'bookmarks', title: 'Bookmarks', hidden: true },
      { id: 'agenda', title: 'Today', hidden: false },
    ]);
    expect(sectionsToSetting(r.sections, r.searchHidden)[0]).toEqual({
      id: 'search',
      hidden: true,
    });
  });

  it('places a section missing from an old saved order after its default predecessor', () => {
    const ws = [
      { id: 'bookmarks', title: 'Bookmarks', order: 10 },
      { id: 'agenda', title: 'Today', order: 40 },
      { id: 'tasks', title: 'Tasks', order: 45 },
      { id: 'shopping', title: 'Shopping list', order: 50 },
      { id: 'wiki', title: 'Wiki', order: 60 },
    ];
    const r = resolveDashboardSections(ws, [
      { id: 'search', hidden: false },
      { id: 'wiki', hidden: false },
      { id: 'bookmarks', hidden: true },
      { id: 'agenda', hidden: false },
      { id: 'shopping', hidden: false },
    ]);
    expect(r.sections.map((s) => [s.id, s.hidden])).toEqual([
      ['wiki', false],
      ['bookmarks', true],
      ['agenda', false],
      ['tasks', false],
      ['shopping', false],
    ]);
  });

  it('ignores duplicate ids', () => {
    const r = resolveDashboardSections(widgets, [
      { id: 'agenda', hidden: false },
      { id: 'agenda', hidden: true },
    ]);
    expect(r.sections.map((s) => s.id)).toEqual(['bookmarks', 'agenda', 'wiki']);
    expect(r.sections.find((s) => s.id === 'agenda')!.hidden).toBe(false);
  });
});
