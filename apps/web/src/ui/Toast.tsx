import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { cx } from '../lib/cx';
import { Portal } from './floating';

export type ToastTone = 'neutral' | 'success' | 'error' | 'warning';

export interface ToastOptions {
  title: ReactNode;
  description?: ReactNode;
  tone?: ToastTone;
  /** Optional action button, e.g. Undo. */
  action?: { label: string; onClick: () => void };
  /** ms before auto dismiss; 0 keeps it until dismissed. Default 5000 (8000 with an action). */
  duration?: number;
}

interface ToastItem extends ToastOptions {
  id: number;
}

export interface ToastApi {
  /** Show a toast; returns its id. */
  toast: (options: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const Ctx = createContext<ToastApi>({ toast: () => -1, dismiss: () => {} });

/** `const { toast } = useToast(); toast({ title: 'Deleted', action: { label: 'Undo', onClick } })` */
export function useToast(): ToastApi {
  return useContext(Ctx);
}

const icons: Record<ToastTone, ReactNode> = {
  neutral: <Info aria-hidden className="size-4 text-accent" />,
  success: <CircleCheck aria-hidden className="size-4 text-ok" />,
  error: <CircleAlert aria-hidden className="size-4 text-bad" />,
  warning: <CircleAlert aria-hidden className="size-4 text-warn" />,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);
  const toast = useCallback((options: ToastOptions) => {
    const id = nextId.current++;
    setItems((l) => [...l.slice(-4), { ...options, id }]);
    return id;
  }, []);
  const api = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <Portal>
        <div
          aria-live="polite"
          aria-relevant="additions"
          className="pointer-events-none fixed inset-x-0 bottom-0 z-[70] flex flex-col items-center gap-1.5 p-3 max-sm:bottom-[calc(3.5rem+env(safe-area-inset-bottom))] sm:items-end"
        >
          {items.map((t) => (
            <ToastView key={t.id} item={t} onDismiss={() => dismiss(t.id)} />
          ))}
        </div>
      </Portal>
    </Ctx.Provider>
  );
}

function ToastView({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const duration = item.duration ?? (item.action ? 8000 : 5000);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!duration || paused) return;
    const t = setTimeout(onDismiss, duration);
    return () => clearTimeout(t);
  }, [duration, paused, onDismiss]);
  const tone = item.tone ?? 'neutral';
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className={cx(
        'pointer-events-auto flex w-full max-w-[380px] animate-[wf-toast-in_160ms_ease-out] items-start gap-2 rounded-md border border-line-strong border-l-[3px] bg-surface px-2.5 py-2 text-sm shadow-pop',
        tone === 'neutral' && 'border-l-accent',
        tone === 'success' && 'border-l-ok',
        tone === 'error' && 'border-l-bad',
        tone === 'warning' && 'border-l-warn',
      )}
    >
      <span className="mt-0.5">{icons[tone]}</span>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{item.title}</p>
        {item.description && <p className="text-xs text-fg-2">{item.description}</p>}
      </div>
      {item.action && (
        <button
          type="button"
          onClick={() => {
            item.action?.onClick();
            onDismiss();
          }}
          className="rounded-sm px-1.5 py-0.5 text-xs font-semibold text-accent-text hover:bg-accent-soft"
        >
          {item.action.label}
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="rounded-sm p-0.5 text-fg-3 hover:bg-surface-2 hover:text-fg"
      >
        <X aria-hidden className="size-3.5" />
      </button>
    </div>
  );
}
