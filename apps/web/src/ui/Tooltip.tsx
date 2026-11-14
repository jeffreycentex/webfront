import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { cx } from '../lib/cx';
import { Portal, useFloating, type Placement } from './floating';
import { Shortcut } from './Kbd';

export interface TooltipProps {
  label: ReactNode;
  /** Shortcut spec shown as keycaps, e.g. 'mod+k' or 'g b'. */
  shortcut?: string;
  placement?: Placement;
  /** Hover delay in ms (focus shows it immediately). */
  delay?: number;
  disabled?: boolean;
  children: ReactElement<{ 'aria-describedby'?: string }>;
}

/**
 * Tooltip for a single child element (hover, keyboard focus). The tooltip is described-by the
 * child. It never takes focus and disappears on Escape, scroll or leave. Disabled on touch.
 */
export function Tooltip({
  label,
  shortcut,
  placement = 'bottom',
  delay = 450,
  disabled,
  children,
}: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const getAnchor = useCallback(
    () => (wrapRef.current?.firstElementChild as HTMLElement | null) ?? wrapRef.current,
    [],
  );
  const { ref, style } = useFloating<HTMLDivElement>({ open, anchor: getAnchor, placement });

  const show = (immediate: boolean) => {
    if (disabled) return;
    if (timer.current) clearTimeout(timer.current);
    if (immediate) setOpen(true);
    else timer.current = setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
  };
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <span
        ref={wrapRef}
        className="contents"
        onPointerOver={(e) => e.pointerType === 'mouse' && show(false)}
        onPointerOut={(e) => e.pointerType === 'mouse' && hide()}
        onPointerDown={hide}
        onFocus={(e) => e.target.matches(':focus-visible') && show(true)}
        onBlur={hide}
      >
        {cloneElement(children, { 'aria-describedby': open ? id : undefined })}
      </span>
      {open && (
        <Portal>
          <div
            ref={ref}
            id={id}
            role="tooltip"
            style={{ ...style, zIndex: 80 }}
            className={cx(
              'pointer-events-none flex max-w-[260px] items-center gap-2 rounded-md border border-line-strong bg-fg px-2 py-1 text-xs font-medium text-bg shadow-pop',
            )}
          >
            <span>{label}</span>
            {shortcut && (
              <span className="inline-flex scale-90 opacity-90 [&_kbd]:border-bg/30 [&_kbd]:bg-bg/15 [&_kbd]:text-bg">
                <Shortcut spec={shortcut} />
              </span>
            )}
          </div>
        </Portal>
      )}
    </>
  );
}
