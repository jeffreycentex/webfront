import { Copy } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/ui';
import { buildBookmarklet } from './model';

/** Settings panel: the draggable save-this-page bookmarklet and how to install it. */
export default function BookmarkletSettings() {
  const code = useMemo(() => buildBookmarklet(window.location.origin), []);
  const link = useRef<HTMLAnchorElement>(null);
  const [copied, setCopied] = useState(false);

  // React refuses `javascript:` hrefs, so set it on the element directly.
  useEffect(() => {
    link.current?.setAttribute('href', code);
  }, [code]);

  return (
    <div className="flex flex-col gap-2 text-sm">
      <p>
        Drag this button to your browser&apos;s bookmarks bar. Click it on any page to open a small
        Webfront window with that page&apos;s title and address, pick a category and save.
      </p>
      <p>
        <a
          ref={link}
          draggable
          onClick={(e) => e.preventDefault()}
          className="inline-flex h-(--control-h) cursor-grab items-center gap-1.5 rounded-md border border-accent bg-accent-soft px-3 font-medium text-accent-text"
        >
          Save to Webfront
        </a>
      </p>
      <ol className="list-decimal space-y-0.5 pl-5 text-fg-2">
        <li>Show your bookmarks bar (Ctrl/Cmd+Shift+B in most browsers).</li>
        <li>Drag the button above onto it.</li>
        <li>Open any page and click the new bookmark. Allow the pop-up if asked.</li>
      </ol>
      <p className="text-fg-3">
        If dragging does not work, create a bookmark by hand and paste this as its address. The link
        only works for this address ({window.location.origin}).
      </p>
      <div className="flex items-start gap-2">
        <code className="max-h-20 min-w-0 flex-1 overflow-auto break-all rounded-md bg-surface-2 p-1.5 font-mono text-xs">
          {code}
        </code>
        <Button
          size="sm"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(code)
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
              .catch(() => undefined);
          }}
        >
          <Copy aria-hidden className="size-3.5" /> {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}
