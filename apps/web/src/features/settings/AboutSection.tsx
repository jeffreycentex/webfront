import { API, healthResponseSchema } from '@webfront/shared';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { Button, useShellActions } from '@/ui';

export default function AboutSection() {
  const { openShortcuts } = useShellActions();
  const [version, setVersion] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    apiFetch(API.health, { schema: healthResponseSchema })
      .then((h) => live && setVersion(h.version))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <p>
        Webfront server version:{' '}
        <strong>{version ?? (failed ? 'unavailable (offline?)' : '…')}</strong>
      </p>
      <p className="text-fg-3">
        Your data lives on your own server and in this browser. No telemetry.
      </p>
      <div>
        <Button size="sm" onClick={openShortcuts}>
          Keyboard shortcuts (?)
        </Button>
      </div>
    </div>
  );
}
