import { describe, expect, it } from 'vitest';
import { diffLines, diffStats, diffWords, lcsMatches } from './diff';
import { CONFLICT_MARKERS, merge3 } from './diff3';

const L = (...lines: string[]) => lines.join('\n');

describe('lcsMatches', () => {
  it('finds a longest common subsequence', () => {
    const a = 'ABCABBA'.split('');
    const b = 'CBABAC'.split('');
    const m = lcsMatches(a, b);
    expect(m).toHaveLength(4);
    for (let i = 1; i < m.length; i++) {
      expect(m[i]![0]).toBeGreaterThan(m[i - 1]![0]);
      expect(m[i]![1]).toBeGreaterThan(m[i - 1]![1]);
    }
    for (const [i, j] of m) expect(a[i]).toBe(b[j]);
  });

  it('handles empty inputs', () => {
    expect(lcsMatches([], [])).toEqual([]);
    expect(lcsMatches(['a'], [])).toEqual([]);
    expect(lcsMatches([], ['a'])).toEqual([]);
  });

  it('degrades to a valid (non-minimal) diff past the cost cap', () => {
    const a = Array.from({ length: 300 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 300 }, (_, i) => `b${i}`);
    const m = lcsMatches([...a, 'same'], [...b, 'same'], 10);
    expect(m).toEqual([[300, 300]]);
  });
});

describe('diffLines / diffWords', () => {
  it('reports inserted and deleted lines', () => {
    const ops = diffLines(L('a', 'b', 'c'), L('a', 'x', 'c', 'd'));
    expect(ops).toEqual([
      { type: 'equal', lines: ['a'] },
      { type: 'delete', lines: ['b'] },
      { type: 'insert', lines: ['x'] },
      { type: 'equal', lines: ['c'] },
      { type: 'insert', lines: ['d'] },
    ]);
    expect(diffStats(L('a', 'b', 'c'), L('a', 'x', 'c', 'd'))).toEqual({ added: 2, removed: 1 });
  });

  it('word diff reconstructs both sides', () => {
    const ops = diffWords('the quick brown fox', 'the slow brown cat');
    expect(
      ops
        .filter((o) => o.type !== 'insert')
        .map((o) => o.text)
        .join(''),
    ).toBe('the quick brown fox');
    expect(
      ops
        .filter((o) => o.type !== 'delete')
        .map((o) => o.text)
        .join(''),
    ).toBe('the slow brown cat');
  });
});

describe('merge3', () => {
  it('merges non-overlapping edits cleanly', () => {
    const base = L('one', 'two', 'three', 'four', 'five');
    const mine = L('ONE', 'two', 'three', 'four', 'five');
    const theirs = L('one', 'two', 'three', 'four', 'FIVE');
    const r = merge3(base, mine, theirs);
    expect(r.clean).toBe(true);
    expect(r.merged).toBe(L('ONE', 'two', 'three', 'four', 'FIVE'));
  });

  it('merges insertions at different places', () => {
    const base = L('a', 'b', 'c');
    const r = merge3(base, L('a', 'mine', 'b', 'c'), L('a', 'b', 'c', 'theirs'));
    expect(r.clean).toBe(true);
    expect(r.merged).toBe(L('a', 'mine', 'b', 'c', 'theirs'));
  });

  it('takes the only changed side', () => {
    const base = L('a', 'b');
    expect(merge3(base, base, L('a', 'B')).merged).toBe(L('a', 'B'));
    expect(merge3(base, L('A', 'b'), base).merged).toBe(L('A', 'b'));
  });

  it('identical edits on both sides merge once', () => {
    const base = L('a', 'b', 'c');
    const both = L('a', 'B!', 'c', 'd');
    const r = merge3(base, both, both);
    expect(r).toMatchObject({ clean: true, merged: both });
    // Same change plus different non-overlapping changes.
    const r2 = merge3(base, L('x', 'B!', 'c'), L('a', 'B!', 'c', 'y'));
    expect(r2).toMatchObject({ clean: true, merged: L('x', 'B!', 'c', 'y') });
  });

  it('applies deletions from either side', () => {
    const base = L('keep1', 'drop-mine', 'keep2', 'drop-theirs', 'keep3');
    const mine = L('keep1', 'keep2', 'drop-theirs', 'keep3');
    const theirs = L('keep1', 'drop-mine', 'keep2', 'keep3');
    const r = merge3(base, mine, theirs);
    expect(r).toMatchObject({ clean: true, merged: L('keep1', 'keep2', 'keep3') });
  });

  it('both deleting the same line is clean', () => {
    const base = L('a', 'b', 'c');
    expect(merge3(base, L('a', 'c'), L('a', 'c'))).toMatchObject({
      clean: true,
      merged: L('a', 'c'),
    });
  });

  it('delete vs edit of the same line conflicts and keeps both', () => {
    const base = L('a', 'b', 'c');
    const r = merge3(base, L('a', 'c'), L('a', 'b edited', 'c'));
    expect(r.clean).toBe(false);
    expect(r.conflicts).toBe(1);
    expect(r.merged).toContain('b edited');
  });

  it('overlapping edits conflict, with both sides between markers', () => {
    const base = L('title', 'the cat sat', 'end');
    const mine = L('title', 'the dog sat', 'end');
    const theirs = L('title', 'the bird sat', 'end');
    const r = merge3(base, mine, theirs);
    expect(r.clean).toBe(false);
    expect(r.merged).toBe(
      L(
        'title',
        CONFLICT_MARKERS.mine,
        'the dog sat',
        CONFLICT_MARKERS.separator,
        'the bird sat',
        CONFLICT_MARKERS.theirs,
        'end',
      ),
    );
    expect(r.chunks.find((c) => c.kind === 'conflict')).toEqual({
      kind: 'conflict',
      base: ['the cat sat'],
      mine: ['the dog sat'],
      theirs: ['the bird sat'],
    });
  });

  it('falls back to a word-level merge inside a conflicting line', () => {
    const base = 'The quick brown fox jumps over the lazy dog.';
    const mine = 'The quick red fox jumps over the lazy dog.';
    const theirs = 'The quick brown fox jumps over the sleepy dog.';
    const r = merge3(base, mine, theirs);
    expect(r).toMatchObject({
      clean: true,
      merged: 'The quick red fox jumps over the sleepy dog.',
    });
  });

  it('both inserting different text at the same point conflicts', () => {
    const r = merge3(L('a', 'b'), L('a', 'x', 'b'), L('a', 'y', 'b'));
    expect(r.clean).toBe(false);
    expect(r.merged).toContain('x');
    expect(r.merged).toContain('y');
  });

  it('handles an empty base', () => {
    expect(merge3('', 'hello', '')).toMatchObject({ clean: true, merged: 'hello' });
    expect(merge3('', '', 'hello')).toMatchObject({ clean: true, merged: 'hello' });
    expect(merge3('', 'same', 'same')).toMatchObject({ clean: true, merged: 'same' });
    const r = merge3('', 'mine text', 'their text');
    expect(r.clean).toBe(false);
    expect(r.merged).toContain('mine text');
    expect(r.merged).toContain('their text');
  });

  it('handles empty sides (everything deleted)', () => {
    expect(merge3(L('a', 'b'), '', L('a', 'b'))).toMatchObject({ clean: true, merged: '' });
    const r = merge3(L('a', 'b'), '', L('a', 'B'));
    expect(r.clean).toBe(false);
    expect(r.merged).toContain('B');
  });

  it('normalises CRLF and keeps the local line-ending style', () => {
    const base = 'a\r\nb\r\nc';
    const mine = 'A\r\nb\r\nc';
    const theirs = 'a\nb\nC'; // other device saved with LF
    const r = merge3(base, mine, theirs);
    expect(r).toMatchObject({ clean: true, merged: 'A\r\nb\r\nC' });
    expect(merge3('a\nb', 'a\nb\nc', 'x\r\nb')).toMatchObject({ clean: true, merged: 'x\nb\nc' });
  });

  it('handles trailing newlines', () => {
    const r = merge3('a\nb\n', 'a\nb\nc\n', 'A\nb\n');
    expect(r).toMatchObject({ clean: true, merged: 'A\nb\nc\n' });
  });

  it('merges large texts quickly and correctly', () => {
    const base = Array.from({ length: 20000 }, (_, i) => `line ${i} lorem ipsum dolor sit amet`);
    const mine = [...base];
    const theirs = [...base];
    for (let i = 0; i < 20000; i += 997) mine[i] = `mine ${i}`;
    for (let i = 500; i < 20000; i += 1009) theirs[i] = `theirs ${i}`;
    mine.splice(10000, 0, 'inserted by mine');
    theirs.splice(15000, 5);
    const started = performance.now();
    const r = merge3(base.join('\n'), mine.join('\n'), theirs.join('\n'));
    const elapsed = performance.now() - started;
    expect(r.clean).toBe(true);
    const lines = r.merged.split('\n');
    expect(lines).toContain('inserted by mine');
    expect(lines).toContain('mine 997');
    expect(lines).toContain('theirs 500');
    expect(lines).not.toContain('line 15001 lorem ipsum dolor sit amet');
    expect(lines.length).toBe(20000 + 1 - 5);
    expect(elapsed).toBeLessThan(2000);
  });

  it('never loses text: every changed line of either side survives', () => {
    // Pseudo-random fuzz over small alphabets of lines.
    let seed = 42;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 300; round++) {
      const base = Array.from({ length: rnd(8) }, () => `b${rnd(5)}`);
      const edit = (tag: string) => {
        const out = [...base];
        const n = rnd(4);
        for (let k = 0; k < n; k++) {
          const op = rnd(3);
          const at = rnd(out.length + 1);
          if (op === 0) out.splice(at, 0, `${tag}${round}-${k}`);
          else if (op === 1 && out.length > 0) out.splice(Math.min(at, out.length - 1), 1);
          else if (out.length > 0) out[Math.min(at, out.length - 1)] = `${tag}${round}-${k}`;
        }
        return out;
      };
      const mine = edit('m');
      const theirs = edit('t');
      const r = merge3(base.join('\n'), mine.join('\n'), theirs.join('\n'));
      const merged = r.merged.split('\n');
      const baseSet = new Set(base);
      for (const line of [...mine, ...theirs]) {
        if (!baseSet.has(line)) expect(merged).toContain(line);
      }
    }
  });
});
