import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { useHotkeys } from './hotkeys';

/** Render children into document.body (overlays escape overflow and stacking contexts). */
export function Portal({ children }: { children: ReactNode }) {
  if (typeof document === 'undefined') return null;
  return createPortal(children, document.body);
}

export type Placement =
  | 'bottom'
  | 'bottom-start'
  | 'bottom-end'
  | 'top'
  | 'top-start'
  | 'top-end'
  | 'right'
  | 'right-start'
  | 'left'
  | 'left-start';

export interface Position {
  top: number;
  left: number;
  side: 'top' | 'bottom' | 'left' | 'right';
  /** Space available on the chosen side (for max-height). */
  maxHeight: number;
}

/** Pure placement maths, exported for tests. */
export function computePosition(
  anchor: DOMRect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  placement: Placement,
  offset = 4,
  margin = 6,
): Position {
  const [wantSide, align = 'center'] = placement.split('-') as [
    'top' | 'bottom' | 'left' | 'right',
    'start' | 'end' | 'center' | undefined,
  ];
  let side = wantSide;
  const spaceBelow = viewport.height - anchor.bottom - offset - margin;
  const spaceAbove = anchor.top - offset - margin;
  const spaceRight = viewport.width - anchor.right - offset - margin;
  const spaceLeft = anchor.left - offset - margin;
  if (side === 'bottom' && size.height > spaceBelow && spaceAbove > spaceBelow) side = 'top';
  else if (side === 'top' && size.height > spaceAbove && spaceBelow > spaceAbove) side = 'bottom';
  else if (side === 'right' && size.width > spaceRight && spaceLeft > spaceRight) side = 'left';
  else if (side === 'left' && size.width > spaceLeft && spaceRight > spaceLeft) side = 'right';

  let top: number;
  let left: number;
  if (side === 'top' || side === 'bottom') {
    top = side === 'bottom' ? anchor.bottom + offset : anchor.top - offset - size.height;
    left =
      align === 'start'
        ? anchor.left
        : align === 'end'
          ? anchor.right - size.width
          : anchor.left + anchor.width / 2 - size.width / 2;
  } else {
    left = side === 'right' ? anchor.right + offset : anchor.left - offset - size.width;
    top = align === 'start' ? anchor.top : anchor.top + anchor.height / 2 - size.height / 2;
  }
  left = Math.max(margin, Math.min(left, viewport.width - size.width - margin));
  top = Math.max(margin, Math.min(top, viewport.height - size.height - margin));
  const maxHeight =
    side === 'top' ? spaceAbove : side === 'bottom' ? spaceBelow : viewport.height - margin * 2;
  return { top, left, side, maxHeight: Math.max(120, maxHeight) };
}

/**
 * Position a floating element next to an anchor. Returns a ref for the floating element and the
 * style to apply. Re-measures on scroll and resize while open. Hidden until measured.
 */
export function useFloating<T extends HTMLElement>(options: {
  open: boolean;
  anchor: RefObject<HTMLElement | null> | (() => HTMLElement | null);
  placement?: Placement;
  offset?: number;
  matchWidth?: boolean;
}): { ref: RefObject<T | null>; style: CSSProperties; position: Position | null } {
  const { open, anchor, placement = 'bottom-start', offset = 4, matchWidth } = options;
  const ref = useRef<T | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [anchorWidth, setAnchorWidth] = useState<number | undefined>();

  const update = useCallback(() => {
    const a = typeof anchor === 'function' ? anchor() : anchor.current;
    const f = ref.current;
    if (!a || !f) return;
    const rect = a.getBoundingClientRect();
    setAnchorWidth(rect.width);
    const next = computePosition(
      rect,
      { width: f.offsetWidth, height: f.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
      placement,
      offset,
    );
    // Keep the previous object when nothing moved, or this layout effect would loop.
    setPosition((prev) =>
      prev &&
      prev.top === next.top &&
      prev.left === next.left &&
      prev.side === next.side &&
      prev.maxHeight === next.maxHeight
        ? prev
        : next,
    );
  }, [anchor, placement, offset]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    update();
  });

  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, update]);

  const style: CSSProperties = position
    ? {
        position: 'fixed',
        top: position.top,
        left: position.left,
        maxHeight: position.maxHeight,
        ...(matchWidth && anchorWidth ? { minWidth: anchorWidth } : null),
      }
    : { position: 'fixed', top: 0, left: 0, visibility: 'hidden' };
  return { ref, style, position };
}

/** Close on outside pointer-down and Escape. Escape goes to the most recently opened overlay. */
export function useDismiss(
  open: boolean,
  onClose: () => void,
  insideRefs: Array<RefObject<HTMLElement | null>>,
): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const refsRef = useRef(insideRefs);
  refsRef.current = insideRefs;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && refsRef.current.some((r) => r.current?.contains(t))) return;
      closeRef.current();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);
  useHotkeys({ escape: () => closeRef.current() }, { enabled: open, allowInInput: true });
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('inert') && el.getAttribute('aria-hidden') !== 'true',
  );
}

/**
 * Trap Tab inside `ref` while open, focus the first element (or `[data-autofocus]`) on open and
 * restore focus to the previously focused element on close. Also locks body scroll.
 */
export function useFocusTrap(open: boolean, ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return;
    const root = ref.current;
    if (!root) return;
    const previous = document.activeElement as HTMLElement | null;
    const target =
      root.querySelector<HTMLElement>('[data-autofocus]') ?? focusableIn(root)[0] ?? root;
    target.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = focusableIn(root);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !root.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !root.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    root.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      root.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [open, ref]);
}
