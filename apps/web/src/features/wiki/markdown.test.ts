// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { highlightCode } from './lib/highlight';
import { renderMarkdown, sanitizeHtml } from './markdown';

const resolveLink = (t: string) =>
  t === 'Home'
    ? { href: '/wiki/home', exists: true }
    : { href: `/wiki/new?title=${encodeURIComponent(t)}`, exists: false };

function dom(html: string): HTMLElement {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div;
}

describe('renderMarkdown', () => {
  it('renders GFM tables, task lists, strikethrough and fenced code', () => {
    const { html } = renderMarkdown(
      [
        '| a | b |',
        '|---|---|',
        '| 1 | 2 |',
        '',
        '- [ ] todo',
        '- [x] done',
        '',
        '~~gone~~',
        '',
        '```js',
        'const x = "s"; // c',
        '```',
      ].join('\n'),
    );
    const d = dom(html);
    expect(d.querySelectorAll('table td')).toHaveLength(2);
    const boxes = d.querySelectorAll('input[type=checkbox]');
    expect(boxes).toHaveLength(2);
    expect((boxes[1] as HTMLInputElement).checked).toBe(true);
    expect((boxes[0] as HTMLInputElement).disabled).toBe(true);
    expect(d.querySelector('li.task-item')?.textContent?.trim()).toBe('todo');
    expect(d.querySelector('s')?.textContent).toBe('gone');
    expect(d.querySelector('pre code .hl-keyword')?.textContent).toBe('const');
    expect(d.querySelector('pre code .hl-string')?.textContent).toBe('"s"');
  });

  it('adds unique heading anchors and returns a table of contents', () => {
    const { html, headings } = renderMarkdown(
      '# Intro\n\n## Setup\n\n## Setup\n\n### [[Home|Back home]]',
    );
    expect(headings).toEqual([
      { level: 1, text: 'Intro', id: 'h-intro' },
      { level: 2, text: 'Setup', id: 'h-setup' },
      { level: 2, text: 'Setup', id: 'h-setup-2' },
      { level: 3, text: 'Back home', id: 'h-back-home' },
    ]);
    expect(dom(html).querySelector('#h-setup-2')?.tagName).toBe('H2');
  });

  it('renders wiki links, missing ones distinctly, and not inside code', () => {
    const { html } = renderMarkdown('See [[Home]], [[Nowhere|a new page]] and `[[Code]]`.', {
      resolveLink,
    });
    const links = dom(html).querySelectorAll('a.wikilink');
    expect(links).toHaveLength(2);
    expect(links[0]!.getAttribute('href')).toBe('/wiki/home');
    expect(links[0]!.classList.contains('wikilink-missing')).toBe(false);
    expect(links[1]!.classList.contains('wikilink-missing')).toBe(true);
    expect(links[1]!.textContent).toBe('a new page');
    expect(links[1]!.getAttribute('data-wikilink')).toBe('Nowhere');
    expect(dom(html).querySelector('code')?.textContent).toBe('[[Code]]');
  });

  it('auto-links URLs and opens external links in a new tab safely', () => {
    const { html } = renderMarkdown('Visit https://example.com and [local](/wiki/home).', {
      origin: 'http://localhost:3000',
    });
    const [ext, local] = [...dom(html).querySelectorAll('a')];
    expect(ext!.getAttribute('href')).toBe('https://example.com');
    expect(ext!.getAttribute('target')).toBe('_blank');
    expect(ext!.getAttribute('rel')).toBe('noopener noreferrer');
    expect(local!.hasAttribute('target')).toBe(false);
  });

  it('swaps pending attachment placeholders for local object URLs', () => {
    const { html } = renderMarkdown('![shot](/api/attachments/pending/abc123)', {
      pendingImage: (id) => (id === 'abc123' ? 'blob:http://localhost/xyz' : undefined),
    });
    const img = dom(html).querySelector('img')!;
    expect(img.getAttribute('src')).toBe('blob:http://localhost/xyz');
    expect(img.getAttribute('loading')).toBe('lazy');
  });
});

describe('sanitising', () => {
  const attacks = [
    '<script>alert(1)</script>',
    '<img src=x onerror="alert(1)">',
    '<a href="javascript:alert(1)">x</a>',
    '[click](javascript:alert(1))',
    '[click](JaVaScRiPt:alert(1))',
    '[click](vbscript:msgbox(1))',
    '![img](javascript:alert(1))',
    '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    '<svg onload=alert(1)>',
    '<iframe src="https://evil.example"></iframe>',
    '<div style="background:url(javascript:alert(1))">x</div>',
    '[[Home" onmouseover="alert(1)]]',
    '[[<img src=x onerror=alert(1)>]]',
    '```\n</code></pre><script>alert(1)</script>\n```',
    '<details open ontoggle=alert(1)>',
  ];

  for (const src of attacks) {
    it(`neutralises ${JSON.stringify(src).slice(0, 60)}`, () => {
      const { html } = renderMarkdown(src, { resolveLink });
      const d = dom(html);
      expect(d.querySelector('script, iframe, svg, object, embed, style')).toBeNull();
      for (const el of d.querySelectorAll('*')) {
        for (const attr of el.attributes) {
          expect(attr.name.startsWith('on')).toBe(false);
          expect(attr.value.toLowerCase()).not.toMatch(/^\s*(javascript|vbscript|data:text\/html)/);
        }
      }
      expect(html.toLowerCase()).not.toContain('<script');
    });
  }

  it('sanitizeHtml strips handlers even from raw HTML input', () => {
    const out = sanitizeHtml(
      '<a href="https://x.example" onclick="evil()">x</a><input type="text" value="y">',
    );
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('type="text"');
    expect(out).toContain('rel="noopener noreferrer"');
  });
});

describe('highlightCode', () => {
  it('escapes everything it does not wrap', () => {
    expect(highlightCode('<b>&</b>', 'text')).toBe('&lt;b&gt;&amp;&lt;/b&gt;');
    expect(highlightCode('if (a < "<x>") return 1', 'js')).toBe(
      '<span class="hl-keyword">if</span> (a &lt; <span class="hl-string">&quot;&lt;x&gt;&quot;</span>) <span class="hl-keyword">return</span> <span class="hl-number">1</span>',
    );
  });
});
