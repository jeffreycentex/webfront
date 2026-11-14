import { TriangleAlert } from 'lucide-react';
import { Component, Suspense, type ErrorInfo, type ReactNode } from 'react';
import { Button, Skeleton } from '@/ui';

interface State {
  error: Error | null;
}

/** Catches render errors (and failed lazy imports) of ONE widget so the rest of the page lives. */
export class WidgetErrorBoundary extends Component<{ title: string; children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`dashboard widget "${this.props.title}" crashed`, error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        role="alert"
        className="flex items-center gap-2 rounded-md border border-bad/40 bg-bad-soft px-2 py-1.5 text-xs text-bad-text"
      >
        <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1">
          {this.props.title} could not be shown. The rest of the page is unaffected.
        </span>
        <Button size="sm" variant="secondary" onClick={() => this.setState({ error: null })}>
          Retry
        </Button>
      </div>
    );
  }
}

/** Error boundary + Suspense around a lazily loaded widget. */
export function WidgetBoundary({ title, children }: { title: string; children: ReactNode }) {
  return (
    <WidgetErrorBoundary title={title}>
      <Suspense fallback={<Skeleton className="h-16 w-full" />}>{children}</Suspense>
    </WidgetErrorBoundary>
  );
}
