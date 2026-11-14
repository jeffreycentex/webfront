import type { ColourKey } from '@webfront/shared';
import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../lib/cx';
import { colourStyle } from './colour';

export interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: ReactNode;
  colour?: ColourKey | null;
  /** Right-aligned header content (buttons, counts). */
  actions?: ReactNode;
  /** Small leading element in the header (icon, ColourDot). */
  icon?: ReactNode;
  /** Remove body padding rules: children render edge to edge (lists). Default true. */
  flush?: boolean;
  headingLevel?: 2 | 3 | 4;
}

/**
 * Compact section with a tinted header and a coloured left edge (bookmark categories, shopping
 * lists, feeds, dashboard widgets). Colour comes from `colourStyle`, which sets --c / --c-soft.
 */
export function Panel({
  title,
  colour,
  actions,
  icon,
  children,
  className,
  style,
  flush = true,
  headingLevel = 2,
  ...rest
}: PanelProps) {
  const Heading = `h${headingLevel}` as 'h2';
  return (
    <section
      className={cx(
        'flex min-w-0 flex-col overflow-hidden rounded-md border border-line border-l-[3px] border-l-[color:var(--c,var(--wf-line-strong))] bg-surface shadow-sm',
        className,
      )}
      style={{ ...colourStyle(colour), ...style }}
      {...rest}
    >
      <header className="flex min-h-(--row-h) items-center justify-between gap-2 border-b border-line bg-[var(--c-soft,var(--wf-surface-2))] px-2 py-0.5 max-sm:px-3">
        <Heading className="label-caps flex min-w-0 items-center gap-1.5 truncate text-fg">
          {icon}
          <span className="truncate">{title}</span>
        </Heading>
        {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
      </header>
      <div className={cx('min-h-0 flex-1', !flush && 'p-2')}>{children}</div>
    </section>
  );
}
