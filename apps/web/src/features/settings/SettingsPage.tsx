import { lazy, useEffect, type ComponentType } from 'react';
import { useLocation } from 'react-router';
import { Panel, PageHeader } from '@/ui';
import { useFeatures } from '../context';
import { PanelBoundary } from './Boundary';

const AccountSection = lazy(() => import('./AccountSection'));
const AppearanceSection = lazy(() => import('./AppearanceSection'));
const SearchSection = lazy(() => import('./SearchSection'));
const SecuritySection = lazy(() => import('./SecuritySection'));
const NotificationsSection = lazy(() => import('./NotificationsSection'));
const DataSection = lazy(() => import('./DataSection'));
const DeletedSection = lazy(() => import('./DeletedSection'));
const AboutSection = lazy(() => import('./AboutSection'));

interface Entry {
  id: string;
  title: string;
  component: ComponentType;
  colour: Parameters<typeof Panel>[0]['colour'];
}

const BEFORE: Entry[] = [
  { id: 'account', title: 'Account', component: AccountSection, colour: 'blue' },
  { id: 'appearance', title: 'Appearance', component: AppearanceSection, colour: 'violet' },
  { id: 'search', title: 'Search', component: SearchSection, colour: 'teal' },
  {
    id: 'security',
    title: 'Security on this device',
    component: SecuritySection,
    colour: 'orange',
  },
];
const AFTER: Entry[] = [
  {
    id: 'notifications',
    title: 'Notifications',
    component: NotificationsSection,
    colour: 'red',
  },
  { id: 'data', title: 'Data', component: DataSection, colour: 'green' },
  { id: 'deleted', title: 'Recently deleted', component: DeletedSection, colour: null },
  { id: 'about', title: 'About', component: AboutSection, colour: null },
];

export function SettingsPage() {
  const { settingsPanels } = useFeatures();
  const { hash } = useLocation();
  const entries: Entry[] = [
    ...BEFORE,
    ...settingsPanels.map((p) => ({
      id: `panel-${p.id}`,
      title: p.title,
      component: p.component,
      colour: null,
    })),
    ...AFTER,
  ];

  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(hash.slice(1));
    el?.scrollIntoView?.({ block: 'start' });
  }, [hash]);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-2">
      <PageHeader title="Settings" />
      <nav aria-label="Settings sections" className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
        {entries.map((e) => (
          <a key={e.id} href={`#${e.id}`} className="text-accent-text hover:underline">
            {e.title}
          </a>
        ))}
      </nav>
      {entries.map((e) => {
        const Body = e.component;
        return (
          <Panel
            key={e.id}
            id={e.id}
            title={e.title}
            colour={e.colour}
            flush={false}
            className="scroll-mt-2"
          >
            <PanelBoundary title={e.title}>
              <Body />
            </PanelBoundary>
          </Panel>
        );
      })}
    </div>
  );
}
