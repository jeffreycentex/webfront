/**
 * Small, dependency-free diff (Myers O(ND) with common prefix/suffix trimming) over token
 * arrays. Used by the three-way merge (`diff3.ts`) and the revision history view.
 *
 * Tokens are compared by identity after interning to integers, so lines and words both work.
 * For pathological inputs (huge, almost completely different texts) the search is capped:
 * past `maxCost` edits the middle is reported as one replaced block, which is still a correct
 * (if not minimal) diff. Callers treat that as "everything changed", never as "nothing changed".
 */

export type Match = [aIndex: number, bIndex: number];

const DEFAULT_MAX_COST = 2000;

/** Intern tokens of both sequences to small integers (equal tokens get equal ids). */
function intern(a: readonly string[], b: readonly string[]): [Int32Array, Int32Array] {
  const ids = new Map<string, number>();
  const map = (xs: readonly string[]) => {
    const out = new Int32Array(xs.length);
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i]!;
      let id = ids.get(x);
      if (id === undefined) {
        id = ids.size;
        ids.set(x, id);
      }
      out[i] = id;
    }
    return out;
  };
  return [map(a), map(b)];
}

/**
 * Matched index pairs of a longest common subsequence (in increasing order on both sides).
 * Exact (minimal) unless the edit distance exceeds `maxCost`.
 */
export function lcsMatches(
  a: readonly string[],
  b: readonly string[],
  maxCost = DEFAULT_MAX_COST,
): Match[] {
  const [A, B] = intern(a, b);
  const out: Match[] = [];
  let start = 0;
  let endA = A.length;
  let endB = B.length;
  while (start < endA && start < endB && A[start] === B[start]) {
    out.push([start, start]);
    start++;
  }
  const suffix: Match[] = [];
  while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) {
    endA--;
    endB--;
    suffix.push([endA, endB]);
  }
  const middle = myers(A, start, endA, B, start, endB, maxCost);
  for (const m of middle) out.push(m);
  for (let i = suffix.length - 1; i >= 0; i--) out.push(suffix[i]!);
  return out;
}

/** Myers' greedy algorithm on A[a0,a1) x B[b0,b1); returns matches or [] if over budget. */
function myers(
  A: Int32Array,
  a0: number,
  a1: number,
  B: Int32Array,
  b0: number,
  b1: number,
  maxCost: number,
): Match[] {
  const n = a1 - a0;
  const m = b1 - b0;
  if (n === 0 || m === 0) return [];
  const max = Math.min(n + m, maxCost);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max; d++) {
    // Only the diagonals reachable at this depth are needed for the backtrack (O(D²) memory).
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && A[a0 + x] === B[b0 + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) return []; // over budget: treat the middle as fully replaced

  // Backtrack through the saved V arrays.
  const matches: Match[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const vPrev = trace[d]!;
    const at = (kk: number) => vPrev[kk + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      matches.push([a0 + x, b0 + y]);
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    matches.push([a0 + x, b0 + y]);
  }
  matches.reverse();
  return matches;
}

/* ------------------------------------------------------------------------- tokenising */

/** Normalise line endings to LF. */
export function normaliseEol(text: string): string {
  return text.indexOf('\r') === -1 ? text : text.replace(/\r\n?/g, '\n');
}

/** Lines without terminators ("a\n" → ["a", ""]); join with "\n" to get the text back. */
export function splitLines(text: string): string[] {
  return normaliseEol(text).split('\n');
}

/** Words, runs of whitespace and single punctuation characters; join with "" to restore. */
export function splitWords(text: string): string[] {
  return text.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) ?? [];
}

/* ------------------------------------------------------------------------ display diff */

export type DiffOp =
  | { type: 'equal'; lines: string[] }
  | { type: 'insert'; lines: string[] }
  | { type: 'delete'; lines: string[] };

/** Line diff of two texts as runs of equal / deleted / inserted lines. */
export function diffLines(oldText: string, newText: string): DiffOp[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const matches = lcsMatches(a, b);
  const ops: DiffOp[] = [];
  const push = (type: DiffOp['type'], line: string) => {
    const last = ops[ops.length - 1];
    if (last && last.type === type) last.lines.push(line);
    else ops.push({ type, lines: [line] } as DiffOp);
  };
  let i = 0;
  let j = 0;
  for (const [mi, mj] of [...matches, [a.length, b.length] as Match]) {
    while (i < mi) push('delete', a[i++]!);
    while (j < mj) push('insert', b[j++]!);
    if (mi < a.length && mj < b.length) {
      push('equal', a[mi]!);
      i = mi + 1;
      j = mj + 1;
    }
  }
  return ops;
}

/** Counts of inserted and deleted lines between two texts. */
export function diffStats(oldText: string, newText: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const op of diffLines(oldText, newText)) {
    if (op.type === 'insert') added += op.lines.length;
    else if (op.type === 'delete') removed += op.lines.length;
  }
  return { added, removed };
}

export type WordOp = { type: 'equal' | 'insert' | 'delete'; text: string };

/** Word-level diff of two short strings (for highlighting changed words inside a line). */
export function diffWords(oldText: string, newText: string): WordOp[] {
  const a = splitWords(oldText);
  const b = splitWords(newText);
  const matches = lcsMatches(a, b, 500);
  const ops: WordOp[] = [];
  const push = (type: WordOp['type'], text: string) => {
    const last = ops[ops.length - 1];
    if (last && last.type === type) last.text += text;
    else ops.push({ type, text });
  };
  let i = 0;
  let j = 0;
  for (const [mi, mj] of [...matches, [a.length, b.length] as Match]) {
    while (i < mi) push('delete', a[i++]!);
    while (j < mj) push('insert', b[j++]!);
    if (mi < a.length && mj < b.length) {
      push('equal', a[mi]!);
      i = mi + 1;
      j = mj + 1;
    }
  }
  return ops;
}
