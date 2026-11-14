import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';

/**
 * Markdown notes -> sanitised HTML. Only imported from lazily loaded files, so markdown-it and
 * DOMPurify stay out of the main bundle. Raw HTML in the source is disabled, and the output is
 * sanitised again; links open in a new tab with `rel="noopener noreferrer"`.
 */

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

/**
 * A private DOMPurify instance: hooks are per instance, and the wiki's renderer installs its
 * own hooks on the default one. Sharing would make this "every link opens a new tab" hook
 * apply to wiki pages (and the wiki's hooks apply here).
 */
let purify: ReturnType<typeof DOMPurify> | null = null;
function ensureHook() {
  if (purify) return purify;
  purify = DOMPurify(window);
  purify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.getAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
  return purify;
}

export function renderMarkdown(source: string): string {
  return ensureHook().sanitize(md.render(source), {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['style', 'form', 'input', 'img'],
  });
}
