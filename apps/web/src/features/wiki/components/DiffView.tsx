import { useMemo, type ReactNode } from 'react';
import { cx } from '@/ui';
import { diffLines, diffWords, type DiffOp } from '../lib/diff';

export interface DiffViewProps {
  from: string;
  to: string;
  fromLabel?: string;
  toLabel?: string;
  /** Unchanged lines shown around each change. */
  context?: number;
  className?: string;
}

type Row =
  | { kind: 'equal' | 'insert' | 'delete'; text: ReactNode; key: string }
  | { kind: 'gap'; count: number; key: string };

function wordPair(oldLine: string, newLine: string): [ReactNode, ReactNode] {
  const ops = diffWords(oldLine, newLine);
  const del: ReactNode[] = [];
  const ins: ReactNode[] = [];
  ops.forEach((o, i) => {
    if (o.type !== 'insert') {
      del.push(
        o.type === 'delete' ? (
          <mark key={i} className="rounded-sm bg-bad/25 text-inherit">
            {o.text}
          </mark>
        ) : (
          o.text
        ),
      );
    }
    if (o.type !== 'delete') {
      ins.push(
        o.type === 'insert' ? (
          <mark key={i} className="rounded-sm bg-ok/25 text-inherit">
            {o.text}
          </mark>
        ) : (
          o.text
        ),
      );
    }
  });
  return [del, ins];
}

function toRows(ops: DiffOp[], context: number): Row[] {
  const rows: Row[] = [];
  ops.forEach((op, oi) => {
    if (op.type === 'equal') {
      const n = op.lines.length;
      const first = oi === 0;
      const last = oi === ops.length - 1;
      const head = first ? 0 : context;
      const tail = last ? 0 : context;
      if (n <= head + tail + 1) {
        op.lines.forEach((l, i) => rows.push({ kind: 'equal', text: l, key: `${oi}-${i}` }));
      } else {
        op.lines
          .slice(0, head)
          .forEach((l, i) => rows.push({ kind: 'equal', text: l, key: `${oi}-h${i}` }));
        rows.push({ kind: 'gap', count: n - head - tail, key: `${oi}-gap` });
        op.lines
          .slice(n - tail)
          .forEach((l, i) => rows.push({ kind: 'equal', text: l, key: `${oi}-t${i}` }));
      }
      return;
    }
    if (op.type === 'delete') {
      const next = ops[oi + 1];
      if (
        next?.type === 'insert' &&
        next.lines.length === op.lines.length &&
        op.lines.length <= 20
      ) {
        // Paired replacement: highlight changed words. The insert run is emitted here too.
        const ins: Row[] = [];
        op.lines.forEach((l, i) => {
          const [d, n] = wordPair(l, next.lines[i]!);
          rows.push({ kind: 'delete', text: d, key: `${oi}-d${i}` });
          ins.push({ kind: 'insert', text: n, key: `${oi}-i${i}` });
        });
        rows.push(...ins);
        (next as DiffOp & { done?: boolean }).done = true;
        return;
      }
    }
    if ((op as DiffOp & { done?: boolean }).done) return;
    op.lines.forEach((l, i) => rows.push({ kind: op.type, text: l, key: `${oi}-${i}` }));
  });
  return rows;
}

/** Unified line diff with word highlights, collapsing long unchanged runs. */
export function DiffView({
  from,
  to,
  fromLabel = 'Before',
  toLabel = 'After',
  context = 2,
  className,
}: DiffViewProps) {
  const rows = useMemo(
    () =>
      toRows(
        diffLines(from, to).map((o) => ({ ...o })),
        context,
      ),
    [from, to, context],
  );
  const changed = rows.some((r) => r.kind === 'insert' || r.kind === 'delete');
  return (
    <div
      className={cx('overflow-hidden rounded-md border border-line bg-surface text-xs', className)}
    >
      <div className="flex gap-3 border-b border-line bg-surface-2 px-2 py-0.5 text-fg-3">
        <span>
          <span className="font-mono text-bad-text">−</span> {fromLabel}
        </span>
        <span>
          <span className="font-mono text-ok-text">+</span> {toLabel}
        </span>
      </div>
      {!changed ? (
        <p className="px-2 py-1.5 text-fg-3">No differences.</p>
      ) : (
        <div className="max-h-[60vh] overflow-auto font-mono leading-[1.45]">
          {rows.map((r) =>
            r.kind === 'gap' ? (
              <div key={r.key} className="bg-surface-2 px-2 text-[11px] text-fg-3">
                ⋯ {r.count} unchanged line{r.count === 1 ? '' : 's'}
              </div>
            ) : (
              <div
                key={r.key}
                className={cx(
                  'flex whitespace-pre-wrap break-words px-1',
                  r.kind === 'insert' && 'bg-ok-soft text-ok-text',
                  r.kind === 'delete' && 'bg-bad-soft text-bad-text',
                )}
              >
                <span aria-hidden className="w-3 shrink-0 select-none text-center opacity-70">
                  {r.kind === 'insert' ? '+' : r.kind === 'delete' ? '−' : ' '}
                </span>
                <span className="sr-only">
                  {r.kind === 'insert' ? 'added' : r.kind === 'delete' ? 'removed' : ''}
                </span>
                <span className="min-w-0 flex-1">{r.text === '' ? ' ' : r.text}</span>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
