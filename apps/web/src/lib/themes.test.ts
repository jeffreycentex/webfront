import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { THEMES } from './theme';

/**
 * Contrast guard for every theme, computed from the CSS source (src/styles/index.css), so a new
 * theme cannot ship unreadable. WCAG 2.x relative luminance; colours are `#rrggbb` or `oklch()`.
 */
const css = readFileSync(fileURLToPath(new URL('../styles/index.css', import.meta.url)), 'utf8');

const KEYS = [
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'teal',
  'cyan',
  'blue',
  'indigo',
  'violet',
  'pink',
];

function block(id: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1]!;
    const hit =
      sel.includes(`[data-theme='${id}']`) ||
      (id === 'light' && /(^|\s|,):root\s*[,{]?/.test(sel) && sel.includes('.light'));
    if (!hit) continue;
    for (const d of m[2]!.matchAll(/--wf-([a-z0-9-]+):\s*([^;]+);/g)) out[d[1]!] = d[2]!.trim();
  }
  return out;
}

function oklchToRgb(L: number, C: number, H: number): [number, number, number] {
  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return lin.map((v) => Math.min(1, Math.max(0, v))) as [number, number, number];
}

/** Linear-light RGB 0..1. */
function toLinear(value: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
  }
  const ok = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value);
  if (ok) return oklchToRgb(Number(ok[1]), Number(ok[2]), Number(ok[3]));
  throw new Error(`unsupported colour: ${value}`);
}
const lum = (v: string) => {
  const [r, g, b] = toLinear(v);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
function ratio(a: string, b: string): number {
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const TOKENS = [
  'bg', 'surface', 'surface-2', 'surface-3', 'line', 'line-strong', 'fg', 'fg-2', 'fg-3',
  'accent', 'accent-hover', 'accent-fg', 'accent-soft', 'accent-text',
  'ok', 'ok-soft', 'ok-text', 'warn', 'warn-soft', 'warn-text', 'bad', 'bad-soft', 'bad-text',
  'overlay', 'shadow', 'shadow-sm',
  ...KEYS.flatMap((k) => [k, `${k}-soft`]),
]; // prettier-ignore

describe.each(THEMES.map((t) => [t.id, t] as const))('theme %s', (id, def) => {
  const t = block(id);
  const pair = (fg: string, bg: string, min: number) => {
    const r = ratio(t[fg]!, t[bg]!);
    expect(r, `${fg} on ${bg} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(min);
  };

  it('defines every token', () => {
    expect(TOKENS.filter((k) => !t[k])).toEqual([]);
  });

  it('registry matches the CSS', () => {
    expect(def.chrome.toLowerCase()).toMatch(/^#[0-9a-f]{6}$/);
    if (/^#/.test(t.bg!)) expect(def.chrome).toBe(t.bg);
    expect(t['fg']).toBeTruthy();
    // Mode is reflected in lightness of the background.
    expect(lum(t.bg!) > 0.25).toBe(def.mode === 'light');
    expect(css).toContain(def.mode === 'dark' ? 'color-scheme: dark' : 'color-scheme: light');
    expect(def.swatch).toHaveLength(5);
  });

  it('body text is AA on bg, surfaces and panels', () => {
    for (const bg of ['bg', 'surface', 'surface-2', 'surface-3']) pair('fg', bg, 4.5);
    pair('fg-2', 'bg', 4.5);
    pair('fg-2', 'surface', 4.5);
  });

  it('muted text (fg-3) is at least 3:1 and in practice AA', () => {
    for (const bg of ['bg', 'surface', 'surface-2']) pair('fg-3', bg, 3);
  });

  it('accent button and link text are readable', () => {
    pair('accent-fg', 'accent', 4.5);
    pair('accent-fg', 'accent-hover', 4.5);
    for (const bg of ['bg', 'surface', 'accent-soft']) pair('accent-text', bg, 4.5);
    pair('fg', 'accent-soft', 4.5);
    // Focus ring / outline uses --wf-accent against the page.
    pair('accent', 'bg', 3);
  });

  it('status text is readable on bg, surface and its soft background', () => {
    for (const s of ['ok', 'warn', 'bad']) {
      for (const bg of ['bg', 'surface', `${s}-soft`]) pair(`${s}-text`, bg, 4.5);
      pair('fg', `${s}-soft`, 4.5);
    }
    // Danger buttons: white (light themes) or accent-fg (dark themes) text on the bad colour.
    const on = def.mode === 'light' ? '#ffffff' : t['accent-fg']!;
    expect(ratio(on, t.bad!)).toBeGreaterThanOrEqual(4.5);
  });

  it('every palette -soft background takes normal text; strong colours are visible markers', () => {
    for (const k of KEYS) {
      pair('fg', `${k}-soft`, 4.5);
      pair('fg-2', `${k}-soft`, 4);
      // Dots, edges and chips (not body text). Official Latte yellow/peach/sky sit near 2.3.
      pair(k, 'surface', 2.2);
    }
  });
});
