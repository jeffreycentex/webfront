import { Component, Suspense, type ErrorInfo, type ReactNode } from 'react';
import { Button, Skeleton } from '@/ui';

class Catch extends Component<{ title: string; children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`settings panel "${this.props.title}" crashed`, error, info.componentStack);
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="flex items-center gap-2 text-xs text-bad-text">
        <span className="flex-1">{this.props.title} could not be shown.</span>
        <Button size="sm" onClick={() => this.setState({ error: null })}>
          Retry
        </Button>
      </div>
    );
  }
}

/** Error boundary + Suspense for one settings panel. */
export function PanelBoundary({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Catch title={title}>
      <Suspense fallback={<Skeleton className="h-12 w-full" />}>{children}</Suspense>
    </Catch>
  );
}
