import { cx } from '@/ui';
import type { Heading } from '../markdown';

/** On-page table of contents (shown for pages with several headings). */
export function Toc({ headings, className }: { headings: readonly Heading[]; className?: string }) {
  if (headings.length < 3) return null;
  const min = Math.min(...headings.map((h) => h.level));
  return (
    <nav aria-label="On this page" className={cx('text-xs', className)}>
      <p className="label-caps mb-1 text-fg-3">On this page</p>
      <ul className="flex flex-col gap-px border-l border-line">
        {headings.map((h) => (
          <li key={h.id}>
            <a
              href={`#${h.id}`}
              onClick={(e) => {
                e.preventDefault();
                document
                  .getElementById(h.id)
                  ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
              }}
              className="-ml-px block truncate border-l border-transparent py-px text-fg-2 hover:border-accent hover:text-fg"
              style={{ paddingLeft: `${8 + (h.level - min) * 10}px` }}
            >
              {h.text || '(untitled)'}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
