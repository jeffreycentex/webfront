import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type {
  Command,
  DashboardWidget,
  FeatureDescriptor,
  NavEntry,
  SearchProvider,
  SettingsPanel,
} from './types';

/** Derived, sorted views over the registered features. */
export interface FeatureRegistry {
  features: readonly FeatureDescriptor[];
  nav: NavEntry[];
  dashboardWidgets: DashboardWidget[];
  searchProviders: SearchProvider[];
  settingsPanels: SettingsPanel[];
  commands: Command[];
}

export function buildRegistry(features: readonly FeatureDescriptor[]): FeatureRegistry {
  const byOrder = <T extends { order: number }>(a: T, b: T) => a.order - b.order;
  return {
    features,
    nav: features.flatMap((f) => (f.nav ? [f.nav] : [])).sort(byOrder),
    dashboardWidgets: features.flatMap((f) => f.dashboardWidgets ?? []).sort(byOrder),
    searchProviders: features.flatMap((f) => (f.searchProvider ? [f.searchProvider] : [])),
    settingsPanels: features.flatMap((f) => f.settingsPanels ?? []).sort(byOrder),
    commands: features.flatMap((f) => f.commands ?? []),
  };
}

const FeatureRegistryContext = createContext<FeatureRegistry | null>(null);

export function FeatureRegistryProvider({
  features,
  children,
}: {
  features: readonly FeatureDescriptor[];
  children: ReactNode;
}) {
  const value = useMemo(() => buildRegistry(features), [features]);
  return (
    <FeatureRegistryContext.Provider value={value}>{children}</FeatureRegistryContext.Provider>
  );
}

/** Access nav entries, dashboard widgets, search providers, settings panels and commands. */
export function useFeatures(): FeatureRegistry {
  const value = useContext(FeatureRegistryContext);
  if (!value) throw new Error('useFeatures must be used inside <FeatureRegistryProvider>');
  return value;
}
