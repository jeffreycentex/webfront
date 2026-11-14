/**
 * A deliberately tiny code highlighter for fenced blocks: comments, strings, numbers and a
 * shared keyword list for C-like, shell, Python and SQL-ish code. Output is HTML-escaped with
 * `<span class="hl-*">` wrappers only. Unknown languages and very long blocks are escaped as is.
 */

const KEYWORDS = new Set(
  (
    'abstract as async await break case catch class const continue def default del do elif else enum export extends ' +
    'false final finally fn for from func function go if impl import in interface is let match mod module mut new nil ' +
    'none not null or and package pass private protected pub public raise return self static struct super switch ' +
    'this throw true try type typeof undefined use var void while with yield select insert update delete where join ' +
    'create table alter drop into values set echo then fi done esac local'
  ).split(' '),
);

const NO_HIGHLIGHT = new Set(['', 'text', 'txt', 'plain', 'markdown', 'md']);

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

const TOKEN_RE =
  /(\/\/[^\n]*|#[^\n]*|--[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?\b|\b0x[\da-f]+\b)|([A-Za-z_][\w]*)/gi;

export function highlightCode(code: string, lang: string): string {
  const l = (lang || '').trim().toLowerCase().split(/\s+/)[0] ?? '';
  if (NO_HIGHLIGHT.has(l) || code.length > 50_000) return escapeHtml(code);
  const hashComments = [
    'sh',
    'bash',
    'zsh',
    'shell',
    'python',
    'py',
    'yaml',
    'yml',
    'toml',
    'ruby',
    'rb',
    'conf',
    'ini',
    'dockerfile',
    'nix',
  ].includes(l);
  const dashComments = ['sql', 'lua', 'haskell', 'hs'].includes(l);
  let out = '';
  let last = 0;
  for (const m of code.matchAll(TOKEN_RE)) {
    const [text, comment, str, num, word] = m;
    let cls: string | null = null;
    if (comment) {
      if (comment.startsWith('#') && !hashComments) cls = null;
      else if (comment.startsWith('--') && !dashComments) cls = null;
      else cls = 'hl-comment';
    } else if (str) cls = 'hl-string';
    else if (num) cls = 'hl-number';
    else if (word && KEYWORDS.has(word.toLowerCase())) cls = 'hl-keyword';
    if (!cls) continue;
    out +=
      escapeHtml(code.slice(last, m.index)) + `<span class="${cls}">${escapeHtml(text)}</span>`;
    last = m.index + text.length;
  }
  return out + escapeHtml(code.slice(last));
}
