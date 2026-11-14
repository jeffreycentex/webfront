/**
 * Tiny scorer for the command palette: 0 = no match, up to 1 = prefix match.
 * Matches against the title first, then keywords at a discount.
 */
export function scoreText(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0.5;
  if (t === q) return 1;
  if (t.startsWith(q)) return 0.95;
  if (t.split(/[\s/_-]+/).some((w) => w.startsWith(q))) return 0.85;
  if (t.includes(q)) return 0.7;
  // All query words appear (in any order).
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every((w) => t.includes(w))) return 0.6;
  // Subsequence ("gsc" -> "Go to Shopping Cart").
  let i = 0;
  for (const ch of t) if (ch === q[i]) i++;
  return i === q.length && q.length >= 2 ? 0.3 : 0;
}

export function scoreCommand(
  query: string,
  title: string,
  keywords: readonly string[] = [],
): number {
  const base = scoreText(query, title);
  if (base > 0 || !query.trim()) return base;
  let best = 0;
  for (const k of keywords) best = Math.max(best, scoreText(query, k) * 0.8);
  return best;
}
