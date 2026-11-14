import { describe, expect, it } from 'vitest';
import { firstLine, linkify } from './text';

describe('linkify', () => {
  it('leaves plain text alone and keeps line breaks', () => {
    expect(linkify('a\nb')).toEqual([{ type: 'text', value: 'a\nb' }]);
    expect(linkify('')).toEqual([]);
  });
  it('links http(s) and www urls', () => {
    expect(linkify('see https://example.com/a?b=1 now')).toEqual([
      { type: 'text', value: 'see ' },
      { type: 'link', value: 'https://example.com/a?b=1', href: 'https://example.com/a?b=1' },
      { type: 'text', value: ' now' },
    ]);
    expect(linkify('www.example.com')).toEqual([
      { type: 'link', value: 'www.example.com', href: 'https://www.example.com' },
    ]);
  });
  it('trims trailing punctuation but keeps balanced parentheses', () => {
    expect(linkify('go to https://a.com/x.')[1]).toMatchObject({ value: 'https://a.com/x' });
    expect(linkify('(https://a.com/x)')[1]).toMatchObject({ value: 'https://a.com/x' });
    expect(linkify('https://en.wikipedia.org/wiki/Foo_(bar)')[0]).toMatchObject({
      value: 'https://en.wikipedia.org/wiki/Foo_(bar)',
    });
  });
  it('never links dangerous schemes or HTML', () => {
    const segs = linkify('javascript:alert(1) <a href="https://x.com">x</a> data:text/html,hi');
    expect(segs.filter((s) => s.type === 'link').every((s) => s.href.startsWith('https://'))).toBe(
      true,
    );
    expect(segs.map((s) => s.value).join('')).toContain('<a href=');
  });
  it('round-trips the original text', () => {
    const t = 'x https://a.com/b, y www.c.org! z\nhttp://d.io';
    expect(
      linkify(t)
        .map((s) => s.value)
        .join(''),
    ).toBe(t);
  });
});

describe('firstLine', () => {
  it('uses the first non-empty line and truncates', () => {
    expect(firstLine('\n\n hello \nworld')).toBe('hello');
    expect(firstLine('x'.repeat(100), 10)).toBe('xxxxxxxxx…');
  });
});
