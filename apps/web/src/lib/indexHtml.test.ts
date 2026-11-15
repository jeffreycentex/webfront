import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** The server sends `script-src 'self'` (apps/server/src/http/static.ts): no inline script. */
describe('index.html and the CSP', () => {
  const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');

  it('has no inline <script> and no inline event handlers', () => {
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      expect(m[1], m[0]).toMatch(/\ssrc=/);
      expect(m[2]!.trim(), m[0]).toBe('');
    }
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it('loads the theme no-flash snippet from a same-origin file before the app', () => {
    const theme = html.indexOf('src="/theme-init.js"');
    expect(theme).toBeGreaterThan(-1);
    expect(theme).toBeLessThan(html.indexOf('src="/src/main.tsx"'));
    const snippet = readFileSync(
      fileURLToPath(new URL('../../public/theme-init.js', import.meta.url)),
      'utf8',
    );
    expect(snippet).toContain("getItem('wf.theme')");
  });
});
