import { describe, expect, it } from 'vitest';
import { safeHttpUrl } from './urls.js';

describe('safeHttpUrl', () => {
  it('passes http(s) URLs through (normalised)', () => {
    expect(safeHttpUrl('https://example.com')).toBe('https://example.com/');
    expect(safeHttpUrl(' http://192.168.1.5:8080/x?y#z ')).toBe('http://192.168.1.5:8080/x?y#z');
    expect(safeHttpUrl('HTTPS://Example.COM/a')).toBe('https://example.com/a');
  });

  it('refuses every other scheme and junk', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      '\u0000javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'blob:https://example.com/x',
      'about:blank',
      '//example.com',
      '/relative',
      'not a url',
      '',
      null,
      undefined,
    ]) {
      expect(safeHttpUrl(bad), String(bad)).toBeNull();
    }
  });
});
