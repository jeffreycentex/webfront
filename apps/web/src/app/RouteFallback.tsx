import { Spinner } from '../ui';

export function RouteFallback() {
  return (
    <div className="flex min-h-dvh items-center justify-center text-fg-3">
      <Spinner label="Loading" />
    </div>
  );
}
