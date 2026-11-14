import { X } from 'lucide-react';
import { useId, useRef, type ReactNode } from 'react';
import { cx } from '../lib/cx';
import { useIsPhone } from '../lib/online';
import { IconButton, Button } from './Button';
import { Portal, useFocusTrap } from './floating';
import { useHotkeys } from './hotkeys';

interface OverlayBase {
  open: boolean;
  onClose: () => void;
  /** Visible title (also the accessible name). */
  title: ReactNode;
  /** Short description under the title (also aria-describedby). */
  description?: ReactNode;
  children?: ReactNode;
  /** Footer content, usually buttons, right-aligned. */
  footer?: ReactNode;
  /** Prevent closing via backdrop click (Escape and the close button still work). */
  persistent?: boolean;
  className?: string;
  /** Hide the visible title bar text (kept for screen readers). */
  hideTitle?: boolean;
}

function Backdrop({ onClick }: { onClick?: () => void }) {
  return (
    <div
      aria-hidden
      onMouseDown={onClick}
      className="absolute inset-0 animate-[wf-fade-in_120ms_ease-out] bg-overlay"
    />
  );
}

function Header({
  titleId,
  title,
  onClose,
  hide,
}: {
  titleId: string;
  title: ReactNode;
  onClose: () => void;
  hide?: boolean;
}) {
  return (
    <div className="flex min-h-9 shrink-0 items-center justify-between gap-2 border-b border-line px-3 py-1">
      <h2 id={titleId} className={cx('text-base font-semibold', hide && 'sr-only')}>
        {title}
      </h2>
      <IconButton label="Close" shortcut="escape" icon={<X />} size="sm" onClick={onClose} />
    </div>
  );
}

export interface ModalProps extends OverlayBase {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Render as a bottom sheet on phones (default true). */
  sheetOnPhone?: boolean;
  /** role="alertdialog" for confirmations. */
  alert?: boolean;
  /** Place near the top (palette-style) instead of centred. */
  top?: boolean;
}

const sizes = {
  sm: 'max-w-[380px]',
  md: 'max-w-[520px]',
  lg: 'max-w-[720px]',
  xl: 'max-w-[960px]',
} as const;

/**
 * Modal dialog: focus-trapped, Escape and backdrop close, restores focus. On phones it becomes
 * a bottom sheet. Put `data-autofocus` on the element that should take initial focus.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  persistent,
  className,
  hideTitle,
  size = 'md',
  sheetOnPhone = true,
  alert,
  top,
}: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const phone = useIsPhone() && sheetOnPhone;
  useFocusTrap(open, ref);
  useHotkeys({ escape: () => onClose() }, { enabled: open, allowInInput: true });
  if (!open) return null;
  return (
    <Portal>
      <div
        className={cx(
          'fixed inset-0 z-50 flex justify-center',
          phone ? 'items-end' : top ? 'items-start pt-[12vh]' : 'items-center p-4',
        )}
      >
        <Backdrop {...(persistent ? {} : { onClick: onClose })} />
        <div
          ref={ref}
          role={alert ? 'alertdialog' : 'dialog'}
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description ? descId : undefined}
          tabIndex={-1}
          className={cx(
            'relative flex max-h-[85dvh] w-full flex-col overflow-hidden border border-line-strong bg-surface text-fg shadow-pop',
            phone
              ? 'animate-[wf-slide-up_160ms_ease-out] rounded-t-lg pb-safe'
              : 'animate-[wf-pop-in_120ms_ease-out] rounded-lg',
            !phone && sizes[size],
            className,
          )}
        >
          <Header titleId={titleId} title={title} onClose={onClose} hide={hideTitle} />
          {description && (
            <p id={descId} className="px-3 pt-2 text-sm text-fg-2">
              {description}
            </p>
          )}
          <div className="scroll-thin min-h-0 flex-1 overflow-auto px-3 py-2.5">{children}</div>
          {footer && (
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 border-t border-line bg-surface-2 px-3 py-2">
              {footer}
            </div>
          )}
        </div>
      </div>
    </Portal>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button for destructive actions. */
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  busy?: boolean;
}

/** Confirmation prompt. Focus starts on the safe (cancel) button for destructive actions. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger,
  onConfirm,
  onCancel,
  busy,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      description={description}
      size="sm"
      alert
      footer={
        <>
          <Button data-autofocus={danger ? '' : undefined} onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            data-autofocus={danger ? undefined : ''}
            disabled={busy}
            onClick={() => void onConfirm()}
          >
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}

export interface DrawerProps extends OverlayBase {
  side?: 'right' | 'left' | 'bottom';
  /** Width on desktop for left/right drawers. */
  width?: string;
}

/** Side panel (desktop) or sheet (`side="bottom"`). Same behaviour as Modal. */
export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  persistent,
  className,
  hideTitle,
  side = 'right',
  width = 'max-w-[420px]',
}: DrawerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(open, ref);
  useHotkeys({ escape: () => onClose() }, { enabled: open, allowInInput: true });
  if (!open) return null;
  return (
    <Portal>
      <div className="fixed inset-0 z-50">
        <Backdrop {...(persistent ? {} : { onClick: onClose })} />
        <div
          ref={ref}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className={cx(
            'absolute flex flex-col border-line-strong bg-surface text-fg shadow-pop',
            side === 'right' &&
              cx(
                'inset-y-0 right-0 w-full animate-[wf-slide-in-right_160ms_ease-out] border-l',
                width,
              ),
            side === 'left' &&
              cx(
                'inset-y-0 left-0 w-full animate-[wf-slide-in-left_160ms_ease-out] border-r',
                width,
              ),
            side === 'bottom' &&
              'inset-x-0 bottom-0 max-h-[85dvh] animate-[wf-slide-up_160ms_ease-out] rounded-t-lg border-t pb-safe',
            className,
          )}
        >
          <Header titleId={titleId} title={title} onClose={onClose} hide={hideTitle} />
          {description && <p className="px-3 pt-2 text-sm text-fg-2">{description}</p>}
          <div className="scroll-thin min-h-0 flex-1 overflow-auto px-3 py-2.5">{children}</div>
          {footer && (
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 border-t border-line bg-surface-2 px-3 py-2">
              {footer}
            </div>
          )}
        </div>
      </div>
    </Portal>
  );
}

/** Alias of `Drawer` for call sites that think in "sheets". */
export const Sheet = Drawer;
