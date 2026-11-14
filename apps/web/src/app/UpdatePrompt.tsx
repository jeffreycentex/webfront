import { RefreshCw, X } from 'lucide-react';
import { useEffect } from 'react';
import { Button, IconButton } from '../ui';
import { applyPwaUpdate, dismissPwaPrompt, setPwaState, usePwaState } from './pwaState';

/** "Update available" banner (and a one-off "ready for offline use" note). */
export function UpdatePrompt() {
  const { needRefresh, offlineReady } = usePwaState();
  useEffect(() => {
    if (!offlineReady) return;
    const t = setTimeout(() => setPwaState({ offlineReady: false }), 4000);
    return () => clearTimeout(t);
  }, [offlineReady]);
  if (!needRefresh && !offlineReady) return null;
  return (
    <div
      role="status"
      className="fixed bottom-3 left-3 z-[65] flex max-w-[calc(100vw-1.5rem)] items-center gap-2 rounded-md border border-line-strong border-l-[3px] border-l-accent bg-surface px-2.5 py-1.5 text-sm shadow-pop max-sm:bottom-[calc(4rem+env(safe-area-inset-bottom))]"
    >
      <RefreshCw aria-hidden className="size-4 text-accent" />
      {needRefresh ? (
        <>
          <span>A new version of Webfront is available.</span>
          <Button size="sm" variant="primary" onClick={applyPwaUpdate}>
            Reload
          </Button>
          <IconButton label="Later" size="sm" icon={<X />} onClick={dismissPwaPrompt} />
        </>
      ) : (
        <span>Ready to work offline.</span>
      )}
    </div>
  );
}
