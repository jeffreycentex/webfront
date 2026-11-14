/** Safe text helpers for event descriptions (rendered as React text nodes, never as HTML). */

export type TextPart =
  { type: 'text'; value: string } | { type: 'link'; value: string; href: string };

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * Descriptions from some feeds (Google) contain HTML. Reduce it to plain text: line breaks for
 * block tags, link targets kept in parentheses, other tags dropped, common entities decoded.
 */
export function plainText(input: string): string {
  if (!/[<&]/.test(input)) return input.trim();
  let s = input.replace(
    /<a\s[^>]*href=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href, label) => {
      const text = String(label)
        .replace(/<[^>]*>/g, '')
        .trim();
      return !text || text === href ? String(href) : `${text} (${href})`;
    },
  );
  s = s.replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '• ').replace(/<[^>]*>/g, '');
  s = s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, name: string) => {
    if (name[0] === '#') {
      const code =
        name[1]?.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[name.toLowerCase()] ?? m;
  });
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

/** Split text into plain and http(s) link parts. Trailing punctuation is not part of the link. */
export function linkify(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    let url = match[0];
    const index = match.index ?? 0;
    // Trim trailing punctuation and unbalanced closing brackets.
    for (;;) {
      const tail = url.at(-1) ?? '';
      if (/[.,;:!?'"]/.test(tail)) url = url.slice(0, -1);
      else if (tail === ')' && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0))
        url = url.slice(0, -1);
      else if (tail === ']' || tail === '}') url = url.slice(0, -1);
      else break;
    }
    let href: string;
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      href = u.toString();
    } catch {
      continue;
    }
    if (index > last) parts.push({ type: 'text', value: text.slice(last, index) });
    parts.push({ type: 'link', value: url, href });
    last = index + url.length;
  }
  if (last < text.length) parts.push({ type: 'text', value: text.slice(last) });
  return parts;
}

/** `https://calendar.google.com/••••` for a stored feed URL. */
export function maskUrl(raw: string): string {
  try {
    const u = new URL(raw.replace(/^webcals?:\/\//i, 'https://'));
    return `${raw.toLowerCase().startsWith('webcal') ? 'webcal' : u.protocol.slice(0, -1)}://${u.host}/••••••`;
  } catch {
    return '••••••';
  }
}
