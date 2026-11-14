/**
 * Plain-text note rendering helpers. Notes are plain text: we never produce HTML. `linkify`
 * splits text into text and link segments that React renders as nodes (so there is no HTML
 * injection path), and only http(s) URLs become links.
 */

export type Segment =
  { type: 'text'; value: string } | { type: 'link'; value: string; href: string };

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
const count = (s: string, ch: string) => s.split(ch).length - 1;

/** Drop sentence punctuation after a URL, keeping a ")" that balances a "(" inside it. */
function trimUrl(url: string): string {
  let u = url;
  while (u) {
    const last = u[u.length - 1]!;
    if (/[.,;:!?'"\]}>]/.test(last)) u = u.slice(0, -1);
    else if (last === ')' && count(u, ')') > count(u, '(')) u = u.slice(0, -1);
    else break;
  }
  return u;
}

/** Split `text` into text and link segments, keeping all whitespace and line breaks. */
export function linkify(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    const url = trimUrl(m[0]);
    // Needs a host with a dot after the scheme ("https://localhost" is fine, "www." alone is not).
    const host = url.replace(/^(?:https?:\/\/|www\.)/i, '');
    if (!host || (/^www\./i.test(url) && !host.includes('.'))) continue;
    if (start > last) out.push({ type: 'text', value: text.slice(last, start) });
    out.push({ type: 'link', value: url, href: /^www\./i.test(url) ? `https://${url}` : url });
    last = start + url.length;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out;
}

/** First non-empty line, shortened, for titles in search results and toasts. */
export function firstLine(text: string, max = 80): string {
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  const t = line.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
