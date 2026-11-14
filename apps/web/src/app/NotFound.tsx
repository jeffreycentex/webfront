import { Compass } from 'lucide-react';
import { Link, useLocation } from 'react-router';
import { EmptyState, Kbd } from '../ui';

export function NotFound() {
  const { pathname } = useLocation();
  return (
    <div className="mx-auto max-w-md p-4">
      <EmptyState
        icon={<Compass />}
        title="Page not found"
        action={
          <Link
            to="/"
            className="inline-flex h-(--control-h) items-center rounded-md border border-accent bg-accent px-2.5 text-sm font-medium text-accent-fg no-underline hover:bg-accent-hover"
          >
            Go home
          </Link>
        }
      >
        <code className="font-mono">{pathname}</code> does not exist. Press <Kbd>g</Kbd>{' '}
        <Kbd>h</Kbd> to jump home.
      </EmptyState>
    </div>
  );
}
