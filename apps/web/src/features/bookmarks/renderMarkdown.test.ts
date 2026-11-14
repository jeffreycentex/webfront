// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './renderMarkdown';

describe('renderMarkdown', () => {
  it('renders basic Markdown', () => {
    const html = renderMarkdown('**bold** and a [link](https://example.com)');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });

  it('strips scripts, event handlers and javascript: links', () => {
    const html = renderMarkdown(
      '<script>alert(1)</script><img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))\n\n<b onclick="x()">hi</b>',
    );
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelector('script, img, b, [onclick], [onerror]')).toBeNull();
    expect(doc.querySelector('a[href^="javascript"]')).toBeNull();
  });
});

describe('renderMarkdown isolation from the wiki renderer', () => {
  it('does not add its new-tab hook to the shared DOMPurify instance', async () => {
    renderMarkdown('[x](https://example.com)');
    const { default: DOMPurify } = await import('dompurify');
    const html = DOMPurify.sanitize('<a href="/wiki/page">in-app</a>');
    expect(html).not.toContain('target=');
  });
});
