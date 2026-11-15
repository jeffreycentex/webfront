import { Upload } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { Button } from '@/ui';

const ImportDialog = lazy(() => import('./ImportDialog'));

/** Settings panel: how to export bookmarks from each browser, and the import button. */
export default function ImportSettings() {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p>
        Bring your bookmarks over from another browser. Export them to an HTML file there, then
        import that file here. The file is read on this device and never uploaded; you preview
        everything before anything is saved, and the import can be undone.
      </p>
      <ul className="list-disc space-y-0.5 pl-5 text-fg-2">
        <li>
          <strong className="text-fg">Chrome, Brave, Vivaldi:</strong> Bookmark manager
          (Ctrl/Cmd+Shift+O), the three-dot menu, Export bookmarks.
        </li>
        <li>
          <strong className="text-fg">Edge:</strong> Favorites (Ctrl+Shift+O), the &hellip; menu,
          Export favorites.
        </li>
        <li>
          <strong className="text-fg">Firefox:</strong> Library (Ctrl/Cmd+Shift+O), Import and
          Backup, Export Bookmarks to HTML.
        </li>
        <li>
          <strong className="text-fg">Safari:</strong> File menu, Export, Bookmarks.
        </li>
      </ul>
      <p>
        <Button onClick={() => setOpen(true)}>
          <Upload aria-hidden className="size-3.5" /> Import from browser&hellip;
        </Button>
      </p>
      {open && (
        <Suspense fallback={null}>
          <ImportDialog open onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}
