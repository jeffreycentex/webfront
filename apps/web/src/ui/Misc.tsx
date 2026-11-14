import { GripVertical, Inbox } from 'lucide-react';
import type { ButtonHTMLAttributes, CSSProperties, HTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from '../lib/cx';

export function Spinner({ label = 'Loading', className }: { label?: string; className?: string }) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cx(
        'inline-block size-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent',
        className,
      )}
    />
  );
}

/** Loading placeholder block. Size it with classes (`h-3 w-24`). */
export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <span
      aria-hidden
      style={style}
      className={cx(
        'block animate-[wf-shimmer_1.4s_linear_infinite] rounded-sm bg-[linear-gradient(90deg,var(--wf-surface-2)_25%,var(--wf-surface-3)_50%,var(--wf-surface-2)_75%)] bg-[length:200%_100%]',
        className,
      )}
    />
  );
}

export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className="sr-only">{children}</span>;
}

export function EmptyState({
  title,
  children,
  icon,
  action,
  className,
}: {
  title: string;
  children?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('flex flex-col items-center gap-1 px-3 py-6 text-center', className)}>
      <span aria-hidden className="text-fg-3 [&>svg]:size-5">
        {icon ?? <Inbox />}
      </span>
      <p className="text-sm font-medium text-fg">{title}</p>
      {children && <div className="max-w-xs text-xs text-fg-3">{children}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

/** Placeholder page used by feature stubs until the feature is built. */
export function PlaceholderPage({ title, owner }: { title: string; owner: string }) {
  return (
    <div className="p-3">
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="text-sm text-fg-3">Not built yet ({owner}).</p>
    </div>
  );
}

/** Page title row with optional actions: the standard top of a feature page. */
export function PageHeader({
  title,
  icon,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  /** Secondary row content (filters, counts) shown under the title. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cx('mb-2 flex flex-wrap items-center gap-x-3 gap-y-1', className)}>
      <h1 className="flex min-w-0 items-center gap-1.5 text-lg font-semibold tracking-tight [&>svg]:size-4 [&>svg]:text-fg-3">
        {icon}
        <span className="truncate">{title}</span>
      </h1>
      {children && <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>}
      {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
    </header>
  );
}

/** Horizontal strip of controls (`role="toolbar"`). Arrow keys are not captured; Tab moves. */
export function Toolbar({
  label,
  children,
  className,
  ...rest
}: { label: string; children: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="toolbar"
      aria-label={label}
      className={cx('flex flex-wrap items-center gap-1', className)}
      {...rest}
    >
      {children}
    </div>
  );
}

export function ToolbarSeparator({ className }: { className?: string }) {
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      className={cx('mx-0.5 h-4 w-px bg-line-strong', className)}
    />
  );
}

/** Dense list container. Rows divide with 1px lines. */
export function List({ children, className, ...rest }: HTMLAttributes<HTMLUListElement>) {
  return (
    <ul className={cx('divide-y divide-line', className)} {...rest}>
      {children}
    </ul>
  );
}

export interface ListRowProps extends Omit<HTMLAttributes<HTMLLIElement>, 'onClick'> {
  /** Leading element (checkbox, icon, ColourDot, favicon). */
  leading?: ReactNode;
  /** Trailing element (tags, date, actions). */
  trailing?: ReactNode;
  selected?: boolean;
  /** Dim (completed, archived). */
  muted?: boolean;
  /** Makes the main area a button. For links, render an `<a>` inside `children` instead. */
  onActivate?: () => void;
  /** Reveal `trailing` only on hover / focus-within (desktop). */
  revealTrailing?: boolean;
}

/**
 * One dense row: 24px high on desktop, 44px on phones. The main content area is a button when
 * `onActivate` is given; otherwise it is plain content (put your own link or input inside).
 */
export function ListRow({
  leading,
  trailing,
  selected,
  muted,
  onActivate,
  revealTrailing,
  children,
  className,
  ...rest
}: ListRowProps) {
  const main = (
    <>
      {leading && <span className="flex shrink-0 items-center">{leading}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </>
  );
  return (
    <li
      aria-current={selected ? 'true' : undefined}
      className={cx(
        'group/row flex min-h-(--row-h) items-center gap-1.5 px-2 text-sm max-sm:px-3',
        selected ? 'bg-accent-soft' : 'hover:bg-surface-2',
        muted && 'text-fg-3',
        className,
      )}
      {...rest}
    >
      {onActivate ? (
        <button
          type="button"
          onClick={onActivate}
          className="flex min-h-[inherit] min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          {main}
        </button>
      ) : (
        <div className="flex min-h-[inherit] min-w-0 flex-1 items-center gap-1.5">{main}</div>
      )}
      {trailing && (
        <span
          className={cx(
            'flex shrink-0 items-center gap-1 text-xs text-fg-3',
            revealTrailing &&
              'sm:opacity-0 sm:group-focus-within/row:opacity-100 sm:group-hover/row:opacity-100',
          )}
        >
          {trailing}
        </span>
      )}
    </li>
  );
}

export interface DragHandleProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  ref?: Ref<HTMLButtonElement>;
}

/**
 * Grip button for sortable rows. Spread dnd-kit's `attributes` and `listeners` (and `ref` =
 * `setActivatorNodeRef`) onto it. It is a real button, so keyboard sorting works (Space to pick
 * up, arrows to move) when the sortable context uses the keyboard sensor.
 */
export function DragHandle({ className, ...rest }: DragHandleProps) {
  return (
    <button
      type="button"
      aria-label="Drag to reorder"
      className={cx(
        'inline-flex h-5 w-4 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-fg-3 hover:bg-surface-3 hover:text-fg active:cursor-grabbing max-sm:h-10 max-sm:w-8',
        className,
      )}
      {...rest}
    >
      <GripVertical aria-hidden className="size-3.5" />
    </button>
  );
}
