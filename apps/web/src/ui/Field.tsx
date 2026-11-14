import { Check, ChevronDown, Minus } from 'lucide-react';
import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cx } from '../lib/cx';

const fieldBase =
  'w-full rounded-md border bg-surface px-2 text-sm text-fg shadow-sm placeholder:text-fg-3 transition-colors hover:border-fg-3 focus:border-accent focus:outline-2 focus:outline-accent/30 focus:outline-offset-0 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:opacity-60 read-only:bg-surface-2';

function fieldBorder(invalid?: boolean) {
  return invalid ? 'border-bad' : 'border-line-strong';
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  ref?: Ref<HTMLInputElement>;
}

export function Input({ className, invalid, ...rest }: InputProps) {
  return (
    <input
      aria-invalid={invalid || undefined}
      className={cx(fieldBase, fieldBorder(invalid), 'h-(--control-h)', className)}
      {...rest}
    />
  );
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
}

export function Textarea({ className, invalid, rows = 3, ...rest }: TextareaProps) {
  return (
    <textarea
      rows={rows}
      aria-invalid={invalid || undefined}
      className={cx(fieldBase, fieldBorder(invalid), 'resize-y py-1.5 leading-snug', className)}
      {...rest}
    />
  );
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
  ref?: Ref<HTMLSelectElement>;
}

/** Native select (best on phones and for accessibility), styled to match inputs. */
export function Select({ className, invalid, children, ...rest }: SelectProps) {
  return (
    <span className="relative inline-flex w-full items-center">
      <select
        aria-invalid={invalid || undefined}
        className={cx(
          fieldBase,
          fieldBorder(invalid),
          'h-(--control-h) appearance-none pr-6',
          className,
        )}
        {...rest}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute right-1.5 size-3.5 text-fg-3"
      />
    </span>
  );
}

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Render the control; receives the id and aria props to spread. */
  children: (props: {
    id: string;
    'aria-describedby': string | undefined;
    invalid: boolean;
  }) => ReactNode;
  className?: string;
}

/** Label + control + hint/error wiring: `<Field label="Name">{(p) => <Input {...p} />}</Field>`. */
export function Field({ label, hint, error, children, className }: FieldProps) {
  const id = useId();
  const descId = hint || error ? `${id}-desc` : undefined;
  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="text-xs font-medium text-fg-2">
        {label}
      </label>
      {children({ id, 'aria-describedby': descId, invalid: Boolean(error) })}
      {(hint || error) && (
        <p
          id={descId}
          className={cx('text-xs', error ? 'text-bad-text' : 'text-fg-3')}
          role={error ? 'alert' : undefined}
        >
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

export interface CheckboxProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'children'
> {
  label?: ReactNode;
  indeterminate?: boolean;
}

export function Checkbox({ label, indeterminate, className, id, ...rest }: CheckboxProps) {
  const auto = useId();
  const cid = id ?? auto;
  return (
    <label
      htmlFor={cid}
      className={cx(
        'group inline-flex min-h-(--row-h) items-center gap-2 text-sm text-fg',
        rest.disabled && 'opacity-50',
        className,
      )}
    >
      <span className="relative inline-flex size-4 shrink-0 items-center justify-center max-sm:size-[22px]">
        <input
          id={cid}
          type="checkbox"
          ref={(el) => {
            if (el) el.indeterminate = Boolean(indeterminate);
          }}
          className="peer absolute inset-0 m-0 size-full cursor-pointer appearance-none rounded-sm border border-line-strong bg-surface shadow-sm transition-colors checked:border-accent checked:bg-accent indeterminate:border-accent indeterminate:bg-accent hover:border-fg-3 disabled:cursor-not-allowed"
          {...rest}
        />
        <Check
          aria-hidden
          strokeWidth={3}
          className="pointer-events-none relative size-3 text-accent-fg opacity-0 peer-checked:opacity-100 peer-indeterminate:hidden"
        />
        <Minus
          aria-hidden
          strokeWidth={3}
          className="pointer-events-none absolute size-3 text-accent-fg opacity-0 peer-indeterminate:opacity-100"
        />
      </span>
      {label != null && <span>{label}</span>}
    </label>
  );
}

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
  'aria-label'?: string;
}

/** On/off switch (role="switch"). Space/Enter toggle. */
export function Switch({
  checked,
  onCheckedChange,
  label,
  disabled,
  id,
  className,
  ...rest
}: SwitchProps) {
  const auto = useId();
  const sid = id ?? auto;
  return (
    <span className={cx('inline-flex min-h-(--row-h) items-center gap-2 text-sm', className)}>
      <button
        id={sid}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={rest['aria-label']}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className={cx(
          'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50 max-sm:h-6 max-sm:w-[42px]',
          checked ? 'border-accent bg-accent' : 'border-line-strong bg-surface-3',
        )}
      >
        <span
          aria-hidden
          className={cx(
            'absolute left-0.5 size-3 rounded-full bg-white shadow-sm transition-transform max-sm:size-[18px]',
            checked ? 'translate-x-3 max-sm:translate-x-[18px]' : 'translate-x-0',
          )}
        />
      </button>
      {label != null && (
        <label htmlFor={sid} className="cursor-pointer">
          {label}
        </label>
      )}
    </span>
  );
}
