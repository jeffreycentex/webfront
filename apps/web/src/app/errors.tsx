import { TriangleAlert } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { Button, EmptyState } from '../ui';

function isChunkError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /dynamically imported module|Importing a module script failed|Loading chunk|Failed to fetch dynamically/i.test(
    msg,
  );
}

export function ErrorView({ error, reset }: { error: unknown; reset?: () => void }) {
  const chunk = isChunkError(error);
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : String(error);
  return (
    <div className="mx-auto max-w-md p-4">
      <EmptyState
        icon={<TriangleAlert className="text-bad" />}
        title={chunk ? 'This page could not be loaded' : 'Something went wrong'}
        action={
          <div className="flex gap-1.5">
            <Button variant="primary" onClick={() => (reset ? reset() : window.location.reload())}>
              {reset ? 'Try again' : 'Reload'}
            </Button>
            <Link
              to="/"
              className="inline-flex h-(--control-h) items-center rounded-md border border-line-strong px-2.5 text-sm text-fg no-underline hover:bg-surface-2"
            >
              Home
            </Link>
          </div>
        }
      >
        {chunk
          ? 'Part of the app is not cached yet and you appear to be offline. Reconnect and reload.'
          : 'The rest of the app is unaffected; your data is safe on this device.'}
        <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap rounded-sm bg-surface-2 p-1.5 text-left font-mono text-2xs text-fg-2">
          {message}
        </pre>
      </EmptyState>
    </div>
  );
}

/** react-router `ErrorBoundary` element for routes. */
export function RouteError() {
  return <ErrorView error={useRouteError()} />;
}

/** Last-resort boundary around the whole app (outside the router). */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  override state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Unhandled UI error', error, info.componentStack);
  }
  override render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-dvh items-center justify-center bg-bg">
          <ErrorView error={this.state.error} reset={() => this.setState({ error: null })} />
        </div>
      );
    }
    return this.props.children;
  }
}
