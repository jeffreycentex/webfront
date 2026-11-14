import {
  createContext,
  useContext,
  useId,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { cx } from '../lib/cx';

export interface TabItem {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  /** Small count shown after the label. */
  count?: number;
  disabled?: boolean;
}

interface TabsCtx {
  value: string;
  prefix: string;
}
const Ctx = createContext<TabsCtx | null>(null);

export interface TabsProps {
  value: string;
  onValueChange: (id: string) => void;
  items: TabItem[];
  label?: string;
  /** Panels (`TabPanel`) rendered below the strip. */
  children?: ReactNode;
  className?: string;
  /** `underline` (default) or `pill`. */
  variant?: 'underline' | 'pill';
}

/** Tab strip with roving focus (ArrowLeft/Right, Home/End; selection follows focus). */
export function Tabs({
  value,
  onValueChange,
  items,
  label,
  children,
  className,
  variant = 'underline',
}: TabsProps) {
  const prefix = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = items.map((t, i) => (t.disabled ? -1 : i)).filter((i) => i >= 0);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const current = items.findIndex((t) => t.id === value);
    const pos = enabled.indexOf(current);
    let next: number | undefined;
    if (e.key === 'ArrowRight') next = enabled[(pos + 1) % enabled.length];
    else if (e.key === 'ArrowLeft') next = enabled[(pos - 1 + enabled.length) % enabled.length];
    else if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled[enabled.length - 1];
    if (next === undefined) return;
    e.preventDefault();
    const item = items[next];
    if (item) {
      onValueChange(item.id);
      refs.current[next]?.focus();
    }
  };

  return (
    <Ctx.Provider value={{ value, prefix }}>
      <div className={className}>
        <div
          role="tablist"
          aria-label={label}
          onKeyDown={onKeyDown}
          className={cx(
            'flex items-end gap-0.5 overflow-x-auto',
            variant === 'underline' ? 'border-b border-line' : 'rounded-md bg-surface-2 p-0.5',
          )}
        >
          {items.map((t, i) => {
            const selected = t.id === value;
            return (
              <button
                key={t.id}
                ref={(el) => {
                  refs.current[i] = el;
                }}
                role="tab"
                type="button"
                id={`${prefix}-tab-${t.id}`}
                aria-selected={selected}
                aria-controls={`${prefix}-panel-${t.id}`}
                tabIndex={selected ? 0 : -1}
                disabled={t.disabled}
                onClick={() => onValueChange(t.id)}
                className={cx(
                  'inline-flex h-(--control-h) shrink-0 items-center gap-1.5 whitespace-nowrap px-2.5 text-sm font-medium transition-colors disabled:opacity-45',
                  variant === 'underline'
                    ? cx(
                        '-mb-px border-b-2',
                        selected
                          ? 'border-accent text-fg'
                          : 'border-transparent text-fg-3 hover:text-fg',
                      )
                    : cx(
                        'rounded-sm',
                        selected ? 'bg-surface text-fg shadow-sm' : 'text-fg-3 hover:text-fg',
                      ),
                )}
              >
                {t.icon && (
                  <span aria-hidden className="[&>svg]:size-3.5">
                    {t.icon}
                  </span>
                )}
                {t.label}
                {t.count !== undefined && (
                  <span className="rounded-full bg-surface-3 px-1.5 font-mono text-2xs tabular-nums text-fg-2">
                    {t.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {children}
      </div>
    </Ctx.Provider>
  );
}

/** Content for one tab; rendered only while its tab is selected. */
export function TabPanel({
  id,
  children,
  className,
}: {
  id: string;
  children: ReactNode;
  className?: string;
}) {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('TabPanel must be inside <Tabs>');
  if (ctx.value !== id) return null;
  return (
    <div
      role="tabpanel"
      id={`${ctx.prefix}-panel-${id}`}
      aria-labelledby={`${ctx.prefix}-tab-${id}`}
      tabIndex={0}
      className={cx('pt-2', className)}
    >
      {children}
    </div>
  );
}
