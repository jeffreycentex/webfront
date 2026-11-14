import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from '../lib/cx';
import { Tooltip } from './Tooltip';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
  size?: 'sm' | 'md';
  ref?: Ref<HTMLButtonElement>;
}

const base =
  'inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md border font-medium transition-colors disabled:pointer-events-none disabled:opacity-45';

export function buttonClasses(
  variant: ButtonProps['variant'] = 'secondary',
  size: ButtonProps['size'] = 'md',
) {
  return cx(
    base,
    size === 'sm'
      ? 'h-[calc(var(--control-h)-4px)] px-2 text-xs max-sm:h-[36px] max-sm:px-3 max-sm:text-sm'
      : 'h-(--control-h) px-2.5 text-sm',
    variant === 'primary' &&
      'border-accent bg-accent text-accent-fg hover:bg-accent-hover hover:border-accent-hover',
    variant === 'secondary' &&
      'border-line-strong bg-surface text-fg shadow-sm hover:bg-surface-2 active:bg-surface-3',
    variant === 'subtle' && 'border-transparent bg-surface-2 text-fg hover:bg-surface-3',
    variant === 'ghost' &&
      'border-transparent bg-transparent text-fg-2 hover:bg-surface-2 hover:text-fg',
    variant === 'danger' && 'border-bad bg-bad text-white hover:brightness-110 dark:text-accent-fg',
  );
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  return <button type={type} className={cx(buttonClasses(variant, size), className)} {...rest} />;
}

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'aria-label'> {
  /** Accessible name; also shown as the tooltip. */
  label: string;
  /** Shortcut spec shown in the tooltip, e.g. 'mod+k'. */
  shortcut?: string;
  icon: ReactNode;
  /** Square hit area on phones stays 40px; set false for a smaller inline button. */
  tooltip?: boolean;
}

/** Square icon-only button with a tooltip. */
export function IconButton({
  label,
  shortcut,
  icon,
  variant = 'ghost',
  size = 'md',
  className,
  tooltip = true,
  type = 'button',
  ...rest
}: IconButtonProps) {
  const button = (
    <button
      type={type}
      aria-label={label}
      aria-keyshortcuts={shortcut}
      className={cx(
        buttonClasses(variant, size),
        '!px-0',
        size === 'sm' ? 'w-[calc(var(--control-h)-4px)] max-sm:w-[36px]' : 'w-(--control-h)',
        className,
      )}
      {...rest}
    >
      <span aria-hidden className="inline-flex items-center justify-center [&>svg]:size-4">
        {icon}
      </span>
    </button>
  );
  return tooltip ? (
    <Tooltip label={label} shortcut={shortcut}>
      {button}
    </Tooltip>
  ) : (
    button
  );
}
