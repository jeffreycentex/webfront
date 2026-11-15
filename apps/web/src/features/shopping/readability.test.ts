import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('readability', () => {
  it('shopping sources never use white-on-colour classes', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const files = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const src = readFileSync(dir + f, 'utf8');
      expect(src, f).not.toMatch(/text-white|bg-white|border-white|#fff\b|#ffffff/i);
    }
  });
});
