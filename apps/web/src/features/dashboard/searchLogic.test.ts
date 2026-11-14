import { describe, expect, it } from 'vitest';
import { isoWeek } from './dates';
import {
  buildOptions,
  groupResults,
  looksLikeUrl,
  pickOption,
  type ProviderResults,
} from './searchLogic';

const engine = { name: 'DuckDuckGo', urlTemplate: 'https://duckduckgo.com/?q=%s' };
const group = (id: string, label: string, scores: number[]): ProviderResults => ({
  providerId: id,
  label,
  colour: 'blue',
  results: scores.map((s, i) => ({
    id: `${id}${i}`,
    title: `${label} ${i}`,
    href: `/${id}/${i}`,
    score: s,
  })),
});

describe('looksLikeUrl', () => {
  it('recognises addresses and hostnames', () => {
    expect(looksLikeUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(looksLikeUrl('example.com')).toBe('https://example.com/');
    expect(looksLikeUrl('docs.example.co.uk/path')).toBe('https://docs.example.co.uk/path');
    expect(looksLikeUrl('localhost:3000/x')).toBe('http://localhost:3000/x');
    expect(looksLikeUrl('192.168.1.5:8080')).toBe('http://192.168.1.5:8080/');
  });
  it('rejects ordinary text, files and unsafe schemes', () => {
    for (const q of [
      'hello world',
      'notes.txt',
      'readme.md',
      'javascript:alert(1)',
      'a',
      'foo.',
      'what is example.com',
      '',
      'ftp://x.com',
    ]) {
      expect(looksLikeUrl(q)).toBeNull();
    }
  });
});

describe('options', () => {
  it('orders groups by best score so the top option is the top result', () => {
    const g = groupResults([
      group('a', 'Alpha', [0.2, 0.4]),
      group('b', 'Beta', [0.9]),
      group('c', 'Empty', []),
    ]);
    expect(g.map((x) => x.label)).toEqual(['Beta', 'Alpha']);
    expect(g[1]!.results.map((r) => r.score)).toEqual([0.4, 0.2]);
  });

  it('has results then the web search; the web search alone when nothing matches', () => {
    const opts = buildOptions('milk', [group('s', 'Shopping', [0.5])], engine);
    expect(opts.map((o) => o.kind)).toEqual(['result', 'web']);
    expect(opts[1]!.href).toBe('https://duckduckgo.com/?q=milk');
    expect(buildOptions('zzz qqq', [], engine).map((o) => o.kind)).toEqual(['web']);
    expect(buildOptions('   ', [], engine)).toEqual([]);
  });

  it('puts a typed address first and Ctrl/Cmd+Enter forces the web search', () => {
    const opts = buildOptions('example.com', [group('s', 'Shopping', [0.5])], engine);
    expect(opts[0]).toMatchObject({ kind: 'url', href: 'https://example.com/' });
    expect(pickOption(opts, 0, { mod: false })?.kind).toBe('url');
    expect(pickOption(opts, 1, { mod: false })?.kind).toBe('result');
    expect(pickOption(opts, 0, { mod: true })?.kind).toBe('web');
  });
});

describe('isoWeek', () => {
  it('follows ISO 8601', () => {
    expect(isoWeek(new Date(2026, 0, 1))).toBe(1);
    expect(isoWeek(new Date(2026, 10, 14))).toBe(46);
    expect(isoWeek(new Date(2021, 0, 3))).toBe(53);
    expect(isoWeek(new Date(2024, 11, 30))).toBe(1);
  });
});
