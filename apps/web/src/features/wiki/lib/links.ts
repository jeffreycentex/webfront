import { titleKey } from './text';

/**
 * `[[Page title]]` and `[[Page title|label]]` wiki links: parsing, renaming and backlinks.
 * Links inside fenced code blocks and inline code are ignored.
 */

export interface WikiLink {
  /** Target title as written (trimmed). */
  target: string;
  /** Display text (the label, or the target). */
  label: string;
  /** Offsets of the whole `[[...]]` in the text. */
  start: number;
  end: number;
}

/** Matches one wiki link; target cannot contain [ ] | or newlines. */
export const WIKI_LINK_RE = /\[\[([^[\]|\n]+?)(?:\|([^[\]\n]+?))?\]\]/g;

/** Ranges [start, end) of fenced code blocks and inline code spans. */
export function codeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let pos = 0;
  let open: { start: number; char: string; len: number } | null = null;
  for (const line of text.split('\n')) {
    const lineEnd = pos + line.length + 1;
    if (!open) {
      const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (m) open = { start: pos, char: m[1]![0]!, len: m[1]!.length };
    } else {
      const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (m && m[1]![0] === open.char && m[1]!.length >= open.len) {
        ranges.push([open.start, Math.min(lineEnd, text.length)]);
        open = null;
      }
    }
    pos = lineEnd;
  }
  if (open) ranges.push([open.start, text.length]);
  const inline = /(`+)(?!`)[^\n]*?[^`\n]\1(?!`)/g;
  for (const m of text.matchAll(inline)) {
    const s = m.index;
    if (!ranges.some(([a, b]) => s >= a && s < b)) ranges.push([s, s + m[0].length]);
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

function inRanges(pos: number, ranges: Array<[number, number]>): boolean {
  for (const [a, b] of ranges) {
    if (pos < a) return false;
    if (pos < b) return true;
  }
  return false;
}

export function parseWikiLinks(text: string): WikiLink[] {
  if (!text.includes('[[')) return [];
  const code = codeRanges(text);
  const out: WikiLink[] = [];
  for (const m of text.matchAll(WIKI_LINK_RE)) {
    if (inRanges(m.index, code)) continue;
    const target = m[1]!.trim();
    if (!target) continue;
    out.push({
      target,
      label: (m[2] ?? m[1]!).trim(),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

/** Distinct normalised target keys a text links to. */
export function linkTargets(text: string): Set<string> {
  return new Set(parseWikiLinks(text).map((l) => titleKey(l.target)));
}

/** True if `text` links to a page titled `title`. */
export function linksTo(text: string, title: string): boolean {
  const key = titleKey(title);
  return parseWikiLinks(text).some((l) => titleKey(l.target) === key);
}

/**
 * Rewrite links pointing at `oldTitle` to `newTitle`. A bare link `[[Old]]` becomes
 * `[[New]]`; a labelled link keeps its label. Returns the new text and the number of links
 * rewritten.
 */
export function renameLinks(
  text: string,
  oldTitle: string,
  newTitle: string,
): { text: string; count: number } {
  const key = titleKey(oldTitle);
  const links = parseWikiLinks(text).filter((l) => titleKey(l.target) === key);
  if (links.length === 0) return { text, count: 0 };
  let out = '';
  let pos = 0;
  for (const l of links) {
    const raw = text.slice(l.start, l.end);
    const hasLabel = raw.includes('|');
    out += text.slice(pos, l.start);
    out += hasLabel ? `[[${newTitle}|${l.label}]]` : `[[${newTitle}]]`;
    pos = l.end;
  }
  out += text.slice(pos);
  return { text: out, count: links.length };
}

export interface LinkablePage {
  id: string;
  title: string;
  body: string;
}

/** Pages (other than the target) whose body links to `title`, in input order. */
export function findBacklinks<P extends LinkablePage>(
  pages: readonly P[],
  target: { id: string; title: string },
): P[] {
  const key = titleKey(target.title);
  return pages.filter(
    (p) => p.id !== target.id && p.body.includes('[[') && linkTargets(p.body).has(key),
  );
}

/** A short excerpt of `body` around the first link to `title` (for the backlinks panel). */
export function backlinkContext(body: string, title: string, radius = 60): string {
  const key = titleKey(title);
  const link = parseWikiLinks(body).find((l) => titleKey(l.target) === key);
  if (!link) return '';
  const start = Math.max(0, link.start - radius);
  const end = Math.min(body.length, link.end + radius);
  return `${start > 0 ? '…' : ''}${body.slice(start, end).replace(/\s+/g, ' ').trim()}${end < body.length ? '…' : ''}`;
}
