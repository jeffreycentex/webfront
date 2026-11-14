import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';
import { cx } from '../lib/cx';
import { Portal, useDismiss, useFloating, type Placement } from './floating';
import { Shortcut } from './Kbd';

type TriggerProps = {
  ref?: Ref<HTMLElement>;
  onClick?: (e: unknown) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
  'aria-expanded'?: boolean;
  'aria-haspopup'?: 'menu' | 'dialog';
  'aria-controls'?: string;
};

export interface PopoverProps {
  /** The element that toggles the popover (a Button or IconButton). It must accept `ref`. */
  trigger: ReactElement<TriggerProps>;
  /** Content, or a render function receiving `close`. */
  children: ReactNode | ((api: { close: () => void }) => ReactNode);
  placement?: Placement;
  /** Controlled open state (optional). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Accessible name of the popup. */
  label?: string;
  className?: string;
  matchWidth?: boolean;
}

function mergeRefs<T>(...refs: Array<Ref<T> | undefined>) {
  return (node: T | null) => {
    for (const r of refs) {
      if (typeof r === 'function') r(node);
      else if (r) (r as { current: T | null }).current = node;
    }
  };
}

/** Anchored panel for arbitrary content (forms, pickers). Escape and outside click close it. */
export function Popover({
  trigger,
  children,
  placement = 'bottom-start',
  open: openProp,
  onOpenChange,
  label,
  className,
  matchWidth,
}: PopoverProps) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = useCallback(
    (v: boolean) => {
      if (openProp === undefined) setOpenState(v);
      onOpenChange?.(v);
    },
    [openProp, onOpenChange],
  );
  const triggerRef = useRef<HTMLElement | null>(null);
  const id = useId();
  const { ref, style } = useFloating<HTMLDivElement>({
    open,
    anchor: triggerRef,
    placement,
    matchWidth: matchWidth ?? false,
  });
  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, [setOpen]);
  useDismiss(open, () => setOpen(false), [ref, triggerRef]);
  // Escape returns focus to the trigger.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) =>
      e.key === 'Escape' && triggerRef.current?.focus();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const el = cloneElement(trigger, {
    ref: mergeRefs(triggerRef, trigger.props.ref),
    onClick: (e: unknown) => {
      trigger.props.onClick?.(e);
      setOpen(!open);
    },
    'aria-expanded': open,
    'aria-haspopup': 'dialog',
    'aria-controls': open ? id : undefined,
  });
  return (
    <>
      {el}
      {open && (
        <Portal>
          <div
            ref={ref}
            id={id}
            role="dialog"
            aria-label={label}
            style={{ ...style, zIndex: 60 }}
            className={cx(
              'scroll-thin max-w-[calc(100vw-12px)] overflow-auto rounded-md border border-line-strong bg-surface p-2 text-fg shadow-pop animate-[wf-pop-in_100ms_ease-out]',
              className,
            )}
          >
            {typeof children === 'function' ? children({ close }) : children}
          </div>
        </Portal>
      )}
    </>
  );
}

export type MenuItem =
  | 'separator'
  | {
      label: string;
      onSelect: () => void;
      icon?: ReactNode;
      /** Shortcut spec shown at the right, e.g. 'mod+e'. */
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
      /** Show a check mark (menuitemcheckbox). */
      checked?: boolean;
    };

export interface DropdownMenuProps {
  trigger: ReactElement<TriggerProps>;
  items: MenuItem[];
  placement?: Placement;
  label?: string;
  className?: string;
}

/**
 * Action menu (role="menu"): ArrowUp/Down, Home/End, type-ahead, Enter/Space select, Escape or
 * Tab close. Opens from the trigger on click or ArrowDown.
 */
export function DropdownMenu({
  trigger,
  items,
  placement = 'bottom-start',
  label,
  className,
}: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const menuId = useId();
  const { ref, style } = useFloating<HTMLDivElement>({ open, anchor: triggerRef, placement });
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const typeahead = useRef({ text: '', at: 0 });
  const [active, setActive] = useState(0);

  const actionable = items
    .map((it, i) => (it !== 'separator' && !it.disabled ? i : -1))
    .filter((i) => i >= 0);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);
  useDismiss(open, () => close(true), [ref, triggerRef]);

  useEffect(() => {
    if (open) {
      setActive(actionable[0] ?? 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (open) itemRefs.current[active]?.focus();
  }, [open, active, style.visibility]);

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const pos = actionable.indexOf(active);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(actionable[(pos + 1) % actionable.length] ?? 0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(actionable[(pos - 1 + actionable.length) % actionable.length] ?? 0);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(actionable[0] ?? 0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(actionable[actionable.length - 1] ?? 0);
    } else if (e.key === 'Tab') {
      close(false);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' ') {
      const now = Date.now();
      const t = typeahead.current;
      t.text = now - t.at > 700 ? e.key.toLowerCase() : t.text + e.key.toLowerCase();
      t.at = now;
      const hit = actionable.find((i) => {
        const it = items[i];
        return it && it !== 'separator' && it.label.toLowerCase().startsWith(t.text);
      });
      if (hit !== undefined) setActive(hit);
    }
  };

  const el = cloneElement(trigger, {
    ref: mergeRefs(triggerRef, trigger.props.ref),
    onClick: (e: unknown) => {
      trigger.props.onClick?.(e);
      setOpen(!open);
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      trigger.props.onKeyDown?.(e);
      if (e.key === 'ArrowDown' && !open) {
        e.preventDefault();
        setOpen(true);
      }
    },
    'aria-expanded': open,
    'aria-haspopup': 'menu',
    'aria-controls': open ? menuId : undefined,
  });

  return (
    <>
      {el}
      {open && (
        <Portal>
          <div
            ref={ref}
            id={menuId}
            role="menu"
            aria-label={label}
            onKeyDown={onMenuKey}
            style={{ ...style, zIndex: 60 }}
            className={cx(
              'scroll-thin min-w-40 max-w-[calc(100vw-12px)] overflow-auto rounded-md border border-line-strong bg-surface p-0.5 text-fg shadow-pop animate-[wf-pop-in_100ms_ease-out]',
              className,
            )}
          >
            {items.map((it, i) =>
              it === 'separator' ? (
                <div key={`sep-${i}`} role="separator" className="my-0.5 h-px bg-line" />
              ) : (
                <button
                  key={`${it.label}-${i}`}
                  ref={(el) => {
                    itemRefs.current[i] = el;
                  }}
                  type="button"
                  role={it.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                  aria-checked={it.checked}
                  disabled={it.disabled}
                  tabIndex={i === active ? 0 : -1}
                  onMouseEnter={() => !it.disabled && setActive(i)}
                  onClick={() => {
                    close(true);
                    it.onSelect();
                  }}
                  className={cx(
                    'flex h-(--row-h) w-full items-center gap-2 rounded-sm px-2 text-left text-sm outline-none disabled:opacity-45',
                    i === active && !it.disabled && (it.danger ? 'bg-bad-soft' : 'bg-accent-soft'),
                    it.danger ? 'text-bad-text' : 'text-fg',
                  )}
                >
                  <span
                    aria-hidden
                    className="inline-flex size-4 shrink-0 items-center justify-center text-fg-3 [&>svg]:size-3.5"
                  >
                    {it.checked ? '✓' : it.icon}
                  </span>
                  <span className="flex-1 truncate">{it.label}</span>
                  {it.shortcut && <Shortcut spec={it.shortcut} />}
                </button>
              ),
            )}
          </div>
        </Portal>
      )}
    </>
  );
}
