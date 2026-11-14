import { describe, expect, it } from 'vitest';
import { linkify, maskUrl, plainText } from './text';

describe('linkify', () => {
  it('links http(s) urls and trims trailing punctuation', () => {
    expect(
      linkify('Join https://meet.example.com/abc-def, then see (https://x.test/a_(b)).'),
    ).toEqual([
      { type: 'text', value: 'Join ' },
      {
        type: 'link',
        value: 'https://meet.example.com/abc-def',
        href: 'https://meet.example.com/abc-def',
      },
      { type: 'text', value: ', then see (' },
      { type: 'link', value: 'https://x.test/a_(b)', href: 'https://x.test/a_(b)' },
      { type: 'text', value: ').' },
    ]);
  });
  it('never links other schemes and returns plain text untouched', () => {
    expect(linkify('javascript:alert(1) and ftp://x.test and data:text/html,hi')).toEqual([
      { type: 'text', value: 'javascript:alert(1) and ftp://x.test and data:text/html,hi' },
    ]);
    expect(linkify('')).toEqual([]);
  });
});

describe('plainText', () => {
  it('strips tags, keeps link targets and decodes entities', () => {
    expect(plainText('Hi<br>there &amp; <b>you</b><script>alert(1)</script>')).toBe(
      'Hi\nthere & youalert(1)',
    );
    expect(plainText('<a href="https://x.test/y">Agenda</a>')).toBe('Agenda (https://x.test/y)');
    expect(plainText('<p>One</p><p>Two</p>')).toBe('One\nTwo');
    expect(plainText('plain & simple')).toBe('plain & simple');
    expect(plainText('&#65;&#x42; &bogus;')).toBe('AB &bogus;');
  });
});

describe('maskUrl', () => {
  it('keeps only the host', () => {
    expect(
      maskUrl('https://calendar.google.com/calendar/ical/secret%40x/private-abc/basic.ics'),
    ).toBe('https://calendar.google.com/••••••');
    expect(maskUrl('webcal://outlook.office365.com/owa/calendar/a/b/reachcalendar.ics')).toContain(
      'webcal://outlook.office365.com/',
    );
    expect(maskUrl('garbage')).not.toContain('garbage');
  });
});
