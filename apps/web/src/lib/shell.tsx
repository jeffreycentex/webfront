import { createContext, useContext } from 'react';

/**
 * Actions owned by the app shell that feature code may trigger. Features cannot import `@/app`,
 * so the shell provides them through this context (defaults are no-ops outside the shell).
 */
export interface ShellActions {
  /** Open the global command palette (Ctrl/Cmd+K). Optionally prefill the query. */
  openPalette(query?: string): void;
  /** Open the `?` keyboard shortcut cheat sheet. */
  openShortcuts(): void;
}

export const ShellContext = createContext<ShellActions>({
  openPalette: () => {},
  openShortcuts: () => {},
});

export function useShellActions(): ShellActions {
  return useContext(ShellContext);
}
