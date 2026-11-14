import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The root font size is 13px (styles/index.css), so Tailwind's rem-based spacing scale is 13/16
 * of its usual size: `h-11` is 35.75px, not 44px. Phone touch targets must use px (`h-[44px]`)
 * or the `--control-h` / `--row-h` variables, which are 40px / 44px below 640px. Regression for
 * the phone quick-add inputs that came out 35.75px tall (shorter than the default control).
 */
const SRC = fileURLToPath(new URL('..', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

describe('phone touch targets', () => {
  it('no control is sized with rem-based h-11 / w-11 / size-11 (35.75px with a 13px root)', () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/(?<![\w[-])(?:[a-z-]+:)*(?:min-)?(?:h|w|size)-11\b/g)) {
        offenders.push(`${path.relative(SRC, file)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
