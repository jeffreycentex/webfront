import { useEffect, useMemo, type MouseEvent } from 'react';
import { useNavigate } from 'react-router';
import { cx } from '@/ui';
import { pendingUrl, usePendingAttachmentsVersion } from '../attachments';
import type { WikiPage } from '../data';
import { renderMarkdown, type Heading } from '../markdown';
import { titleKey } from '../lib/text';
import '../wiki.css';

export interface MarkdownViewProps {
  source: string;
  pages: readonly WikiPage[];
  /** Called when a link to a missing page is clicked. */
  onCreatePage: (title: string) => void;
  onHeadings?: (headings: Heading[]) => void;
  className?: string;
}

/** Sanitised Markdown with live wiki links. */
export function MarkdownView({
  source,
  pages,
  onCreatePage,
  onHeadings,
  className,
}: MarkdownViewProps) {
  const navigate = useNavigate();
  const pendingVersion = usePendingAttachmentsVersion();
  const byTitle = useMemo(() => new Map(pages.map((p) => [titleKey(p.title), p])), [pages]);
  const rendered = useMemo(
    () =>
      renderMarkdown(source, {
        resolveLink: (target) => {
          const p = byTitle.get(titleKey(target));
          return p
            ? { href: `/wiki/${p.slug}`, exists: true }
            : { href: `/wiki?new=1&title=${encodeURIComponent(target)}`, exists: false };
        },
        pendingImage: pendingUrl,
      }),
    // pendingVersion: re-render when offline images get their object URLs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source, byTitle, pendingVersion],
  );

  useEffect(() => {
    onHeadings?.(rendered.headings);
  }, [rendered.headings, onHeadings]);

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    const wiki = a.getAttribute('data-wikilink');
    if (wiki !== null) {
      e.preventDefault();
      const p = byTitle.get(titleKey(wiki));
      if (p) void navigate(`/wiki/${p.slug}`);
      else onCreatePage(wiki);
      return;
    }
    const href = a.getAttribute('href') ?? '';
    if (href.startsWith('#')) {
      e.preventDefault();
      document
        .getElementById(decodeURIComponent(href.slice(1)))
        ?.scrollIntoView({ block: 'start' });
    } else if (
      href.startsWith('/') &&
      !href.startsWith('//') &&
      !href.startsWith('/api/') &&
      !a.target
    ) {
      e.preventDefault();
      void navigate(href);
    }
  };

  return (
    <div
      className={cx('wf-markdown', className)}
      onClick={onClick}
      // Sanitised by DOMPurify in renderMarkdown.
      dangerouslySetInnerHTML={{ __html: rendered.html }}
    />
  );
}
