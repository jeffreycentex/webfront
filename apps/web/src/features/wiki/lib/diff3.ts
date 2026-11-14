import { lcsMatches, normaliseEol, splitLines, splitWords } from './diff';

/**
 * Three-way merge (diff3) of plain text: line-based, with a word-level retry inside
 * conflicting hunks.
 *
 * Given a common ancestor `base` and two descendants `mine` and `theirs`, every region is
 * classified by comparing both sides against the base:
 *   - unchanged on both sides, or changed identically → kept once;
 *   - changed on one side only → that side's version;
 *   - changed differently on both sides → retried word by word; if that still overlaps it
 *     is a conflict (both versions are kept in `merged` between conflict markers).
 *
 * Nothing is ever dropped: in a clean merge every change from either side is applied, and a
 * conflicted merge keeps both sides verbatim. Line endings are normalised to LF for the
 * comparison; the result uses CRLF only if `mine` did.
 */

export interface MergeChunkOk {
  kind: 'ok';
  text: string[];
}
export interface MergeChunkConflict {
  kind: 'conflict';
  base: string[];
  mine: string[];
  theirs: string[];
}
export type MergeChunk = MergeChunkOk | MergeChunkConflict;

export interface MergeResult {
  /** True when every region merged without overlap. */
  clean: boolean;
  /** Number of conflicting regions. */
  conflicts: number;
  /** The merged text; conflicting regions are wrapped in git-style markers. */
  merged: string;
  chunks: MergeChunk[];
}

export const CONFLICT_MARKERS = {
  mine: '<<<<<<< mine',
  separator: '=======',
  theirs: '>>>>>>> theirs',
} as const;

function sameSeq(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

type RawChunk =
  | { kind: 'stable'; tokens: string[] }
  | { kind: 'unstable'; base: string[]; mine: string[]; theirs: string[] };

/** The classic diff3 chunking over token arrays (stable runs and unstable regions). */
function chunk3(base: string[], mine: string[], theirs: string[]): RawChunk[] {
  const toMine = new Int32Array(base.length).fill(-1);
  const toTheirs = new Int32Array(base.length).fill(-1);
  for (const [o, a] of lcsMatches(base, mine)) toMine[o] = a;
  for (const [o, b] of lcsMatches(base, theirs)) toTheirs[o] = b;

  const out: RawChunk[] = [];
  let io = 0;
  let ia = 0;
  let ib = 0;
  while (true) {
    // Stable run: base lines that sit at the cursor on both sides.
    let d = 0;
    while (io + d < base.length && toMine[io + d] === ia + d && toTheirs[io + d] === ib + d) {
      d++;
    }
    if (d > 0) {
      out.push({ kind: 'stable', tokens: base.slice(io, io + d) });
      io += d;
      ia += d;
      ib += d;
      continue;
    }
    // Unstable region: up to the next base line matched on both sides.
    let next = io;
    while (next < base.length && (toMine[next]! < 0 || toTheirs[next]! < 0)) next++;
    const endA = next < base.length ? toMine[next]! : mine.length;
    const endB = next < base.length ? toTheirs[next]! : theirs.length;
    if (next === io && endA === ia && endB === ib) {
      // Only possible at the very end.
      break;
    }
    out.push({
      kind: 'unstable',
      base: base.slice(io, next),
      mine: mine.slice(ia, endA),
      theirs: theirs.slice(ib, endB),
    });
    io = next;
    ia = endA;
    ib = endB;
    if (io >= base.length && ia >= mine.length && ib >= theirs.length) break;
  }
  return out;
}

/** Resolve one unstable region; null means it truly conflicts. */
function resolveRegion(base: string[], mine: string[], theirs: string[]): string[] | null {
  if (sameSeq(mine, theirs)) return mine; // identical change (or both unchanged)
  if (sameSeq(base, mine)) return theirs; // only theirs changed
  if (sameSeq(base, theirs)) return mine; // only mine changed
  return null;
}

/** Merge token arrays; returns the merged tokens or null if any region conflicts. */
function mergeTokensStrict(base: string[], mine: string[], theirs: string[]): string[] | null {
  const out: string[] = [];
  for (const c of chunk3(base, mine, theirs)) {
    if (c.kind === 'stable') out.push(...c.tokens);
    else {
      const r = resolveRegion(c.base, c.mine, c.theirs);
      if (!r) return null;
      out.push(...r);
    }
  }
  return out;
}

/** Retry a conflicting line region word by word (lines are rejoined with "\n" first). */
function wordLevelMerge(base: string[], mine: string[], theirs: string[]): string[] | null {
  // Insertions on both sides at the same point (empty base) are ambiguous in order: keep as conflict.
  if (base.length === 0) return null;
  const join = (xs: string[]) => xs.join('\n');
  const bw = splitWords(join(base));
  const mw = splitWords(join(mine));
  const tw = splitWords(join(theirs));
  // Word diffs over very long regions are slow and rarely meaningful.
  if (bw.length + mw.length + tw.length > 20000) return null;
  const merged = mergeTokensStrict(bw, mw, tw);
  if (!merged) return null;
  return merged.join('').split('\n');
}

export function merge3(base: string, mine: string, theirs: string): MergeResult {
  const crlf = /\r\n/.test(mine);
  const b = normaliseEol(base);
  const m = normaliseEol(mine);
  const t = normaliseEol(theirs);
  const finish = (text: string) => (crlf ? text.replace(/\n/g, '\r\n') : text);

  // Fast paths.
  if (m === t || t === b) {
    return {
      clean: true,
      conflicts: 0,
      merged: finish(m),
      chunks: [{ kind: 'ok', text: splitLines(m) }],
    };
  }
  if (m === b) {
    return {
      clean: true,
      conflicts: 0,
      merged: finish(t),
      chunks: [{ kind: 'ok', text: splitLines(t) }],
    };
  }

  const chunks: MergeChunk[] = [];
  const pushOk = (lines: string[]) => {
    if (lines.length === 0) return;
    const last = chunks[chunks.length - 1];
    if (last?.kind === 'ok') last.text.push(...lines);
    else chunks.push({ kind: 'ok', text: [...lines] });
  };
  let conflicts = 0;
  for (const c of chunk3(splitLines(b), splitLines(m), splitLines(t))) {
    if (c.kind === 'stable') {
      pushOk(c.tokens);
      continue;
    }
    const r = resolveRegion(c.base, c.mine, c.theirs) ?? wordLevelMerge(c.base, c.mine, c.theirs);
    if (r) pushOk(r);
    else {
      conflicts++;
      chunks.push({ kind: 'conflict', base: c.base, mine: c.mine, theirs: c.theirs });
    }
  }

  const lines: string[] = [];
  for (const c of chunks) {
    if (c.kind === 'ok') lines.push(...c.text);
    else {
      lines.push(
        CONFLICT_MARKERS.mine,
        ...c.mine,
        CONFLICT_MARKERS.separator,
        ...c.theirs,
        CONFLICT_MARKERS.theirs,
      );
    }
  }
  return { clean: conflicts === 0, conflicts, merged: finish(lines.join('\n')), chunks };
}
