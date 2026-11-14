import type { ReactNode } from 'react';
import { cx } from '../lib/cx';
import { formatShortcut } from './hotkeys';

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cx(
        'inline-flex h-4 min-w-4 items-center justify-center rounded-sm border border-line-strong border-b-2 bg-surface-2 px-1 font-mono text-2xs font-medium leading-none text-fg-2',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/** Renders a shortcut spec ('mod+k', 'g b') as keycaps; sequences are separated by "then". */
export function Shortcut({ spec, className }: { spec: string; className?: string }) {
  const steps = formatShortcut(spec);
  return (
    <span className={cx('inline-flex items-center gap-1', className)}>
      {steps.map((keys, i) => (
        <span key={i} className="inline-flex items-center gap-0.5">
          {i > 0 && <span className="px-0.5 text-2xs text-fg-3">then</span>}
          {keys.map((k, j) => (
            <Kbd key={j}>{k}</Kbd>
          ))}
        </span>
      ))}
    </span>
  );
}
