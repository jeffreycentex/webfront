import { cx } from '../lib/cx';

/** Webfront mark: four tiles of different heights, like bookmark columns. Fixed colours. */
export function Logo({ className, size = 20 }: { className?: string; size?: number }) {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={cx('shrink-0', className)}
    >
      <rect width="32" height="32" rx="7" fill="#1d1b30" />
      <rect x="5" y="5" width="10" height="15" rx="2" fill="#f0609a" />
      <rect x="17" y="5" width="10" height="8" rx="2" fill="#f5b23d" />
      <rect x="5" y="22" width="10" height="5" rx="2" fill="#2cc0a6" />
      <rect x="17" y="15" width="10" height="12" rx="2" fill="#7f72f5" />
    </svg>
  );
}
