import DOMPurify from 'dompurify';
import MarkdownIt, { type StateCore, type StateInline, type Token } from 'markdown-it';
import { escapeHtml, highlightCode } from './lib/highlight';
import { PENDING_IMAGE_PREFIX, slugify } from './lib/text';

/**
 * Markdown rendering for the reading view and live preview (lazy chunk only: markdown-it and
 * DOMPurify never reach the main bundle).
 *
 * markdown-it with raw HTML disabled, GFM tables and strikethrough, linkified URLs, task
 * lists, heading anchors, fenced code with a tiny highlighter and `[[wiki links]]`; the HTML
 * is then sanitised with DOMPurify. External links open in a new tab with
 * `rel="noopener noreferrer"`.
 */

export interface WikiLinkTarget {
  href: string;
  exists: boolean;
}

export interface RenderOptions {
  /** Resolve `[[target]]` to a page URL; `exists: false` renders it as a missing link. */
  resolveLink?: (target: string) => WikiLinkTarget;
  /** Object URL for a locally pending (not yet uploaded) attachment. */
  pendingImage?: (localId: string) => string | undefined;
  /** Origin treated as internal (defaults to the page's). */
  origin?: string;
}

export interface Heading {
  level: number;
  text: string;
  id: string;
}

export interface Rendered {
  html: string;
  headings: Heading[];
}

interface Env {
  [key: string]: unknown;
  resolveLink?: RenderOptions['resolveLink'];
  headings: Heading[];
}

export { PENDING_IMAGE_PREFIX };

/* --------------------------------------------------------------------- markdown-it */

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
  breaks: false,
  highlight: (code, lang) => {
    const html = highlightCode(code, lang);
    return `<pre class="wf-code"><code${lang ? ` class="language-${escapeHtml(lang)}"` : ''}>${html}</code></pre>`;
  },
});

// [[Target]] / [[Target|label]] as an inline rule (before links; code spans are consumed earlier).
md.inline.ruler.before('link', 'wikilink', (state: StateInline, silent: boolean) => {
  const src = state.src;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x5b || src.charCodeAt(start + 1) !== 0x5b) return false;
  const end = src.indexOf(']]', start + 2);
  if (end < 0) return false;
  const inner = src.slice(start + 2, end);
  if (!inner || inner.includes('[') || inner.includes(']') || inner.includes('\n')) return false;
  const bar = inner.indexOf('|');
  const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
  const label = (bar >= 0 ? inner.slice(bar + 1) : inner).trim();
  if (!target || !label) return false;
  if (!silent) {
    const token = state.push('wikilink', '', 0);
    token.meta = { target, label };
  }
  state.pos = end + 2;
  return true;
});

md.renderer.rules.wikilink = (tokens, idx, _opts, rawEnv) => {
  const env = (rawEnv ?? {}) as Partial<Env>;
  const { target, label } = tokens[idx]!.meta as { target: string; label: string };
  const resolved = env.resolveLink?.(target) ?? { href: '#', exists: false };
  const esc = escapeHtml;
  const cls = resolved.exists ? 'wikilink' : 'wikilink wikilink-missing';
  const title = resolved.exists ? target : `Create page “${target}”`;
  return `<a href="${esc(resolved.href)}" class="${cls}" data-wikilink="${esc(target)}" title="${esc(title)}">${esc(label)}</a>`;
};

function inlineText(token: Token | undefined): string {
  if (!token) return '';
  if (!token.children) return token.content;
  return token.children
    .map((c) =>
      c.type === 'wikilink'
        ? (c.meta as { label: string }).label
        : c.type === 'text' || c.type === 'code_inline'
          ? c.content
          : '',
    )
    .join('');
}

// Heading anchors (unique ids) and the table of contents.
md.core.ruler.push('heading_ids', (state: StateCore) => {
  const env = state.env as unknown as Env;
  const used = new Map<string, number>();
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type !== 'heading_open') continue;
    const text = inlineText(tokens[i + 1]).trim();
    const base = `h-${slugify(text)}`;
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    const id = n === 0 ? base : `${base}-${n + 1}`;
    t.attrSet('id', id);
    env.headings?.push({ level: Number(t.tag.slice(1)), text, id });
  }
});

// GFM task lists: "- [ ] x" / "- [x] x".
md.core.ruler.push('task_lists', (state: StateCore) => {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (
      t.type !== 'inline' ||
      tokens[i - 1]?.type !== 'paragraph_open' ||
      tokens[i - 2]?.type !== 'list_item_open'
    ) {
      continue;
    }
    const m = /^\[([ xX])\][ \t]/.exec(t.content);
    const first = t.children?.[0];
    if (!m || !first || first.type !== 'text' || !first.content.startsWith(m[0])) continue;
    first.content = first.content.slice(m[0].length);
    const box = new state.Token('html_inline', '', 0);
    box.content = `<input type="checkbox" disabled${m[1] === ' ' ? '' : ' checked'}> `;
    t.children!.unshift(box);
    tokens[i - 2]!.attrJoin('class', 'task-item');
  }
});

/* ------------------------------------------------------------------------ DOMPurify */

let currentOptions: RenderOptions = {};
let hooksInstalled = false;

function installHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  DOMPurify.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'input') {
      const el = node as Element;
      if (el.getAttribute('type') !== 'checkbox') el.parentNode?.removeChild(el);
    }
  });
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    if (el.tagName === 'A') {
      const href = el.getAttribute('href') ?? '';
      if (/^https?:\/\//i.test(href)) {
        let external = true;
        try {
          external = new URL(href).origin !== (currentOptions.origin ?? location.origin);
        } catch {
          // keep external
        }
        if (external) {
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener noreferrer');
        }
      } else {
        el.removeAttribute('target');
      }
    } else if (el.tagName === 'IMG') {
      el.setAttribute('loading', 'lazy');
      const src = el.getAttribute('src') ?? '';
      if (src.startsWith(PENDING_IMAGE_PREFIX)) {
        const url = currentOptions.pendingImage?.(src.slice(PENDING_IMAGE_PREFIX.length));
        if (url) el.setAttribute('src', url);
        el.setAttribute('data-pending', 'true');
      }
    } else if (el.tagName === 'INPUT') {
      el.setAttribute('disabled', '');
    }
  });
}

export function sanitizeHtml(html: string, options: RenderOptions = {}): string {
  installHooks();
  currentOptions = options;
  try {
    return DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ['target', 'data-wikilink', 'loading', 'data-pending'],
      FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'iframe', 'object', 'embed'],
      FORBID_ATTR: ['style'],
    });
  } finally {
    currentOptions = {};
  }
}

export function renderMarkdown(src: string, options: RenderOptions = {}): Rendered {
  const env: Env = {
    headings: [],
    ...(options.resolveLink ? { resolveLink: options.resolveLink } : {}),
  };
  const raw = md.render(src, env as unknown as Record<string, unknown>);
  return { html: sanitizeHtml(raw, options), headings: env.headings };
}
