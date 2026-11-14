import { coreSettings, resolveDashboardSections, type ResolvedSection } from '@webfront/shared';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Panel, cx, useIsPhone, useMediaQuery } from '@/ui';
import { useFeatures } from '../context';
import type { DashboardWidget } from '../types';
import { useDensity } from './density';
import { isoWeek } from './dates';
import { SearchBar } from './SearchBar';
import { useSetting } from './useSetting';
import { WidgetBoundary } from './WidgetBoundary';

/**
 * Widgets drawn in the narrow side column on wide screens (agenda, shopping, wiki); everything
 * else (bookmarks, services, post-its, widgets from future features) uses the wide main column.
 */
const SIDE_IDS = new Set(['agenda', 'shopping', 'wiki']);

/** On phones these come right after the search bar. */
const PHONE_FIRST = ['shopping', 'agenda'];

/**
 * How a widget is framed. `none`: the widget draws its own titled panel (bookmarks columns,
 * agenda, post-its, wiki). `plain`: it has its own header but no outer border (shopping).
 * `panel`: the dashboard adds the titled Panel (services, and any unknown widget).
 */
const FRAME: Record<string, 'none' | 'plain' | 'panel'> = {
  bookmarks: 'none',
  agenda: 'none',
  postits: 'none',
  wiki: 'none',
  shopping: 'plain',
  services: 'panel',
};

export function DashboardPage() {
  const { dashboardWidgets } = useFeatures();
  const [saved] = useSetting(coreSettings.dashboardSections);
  const [density] = useDensity();
  const [query, setQuery] = useState('');
  const [engine] = useSetting(coreSettings.searchEngine);
  const wide = useMediaQuery('(min-width: 1024px)');
  const phone = useIsPhone();

  const { searchHidden, visible } = useMemo(
    () => orderSections(dashboardWidgets, saved, phone),
    [dashboardWidgets, saved, phone],
  );
  const widgetById = useMemo(
    () => new Map(dashboardWidgets.map((w) => [w.id, w])),
    [dashboardWidgets],
  );

  const render = (s: ResolvedSection) => {
    const w = widgetById.get(s.id);
    return w ? <Section key={s.id} widget={w} query={query} /> : null;
  };
  const side = visible.filter((s) => SIDE_IDS.has(s.id));
  const main = visible.filter((s) => !SIDE_IDS.has(s.id));
  const gap = density === 'compact' ? 'gap-2' : 'gap-3.5';

  return (
    <div className={cx('mx-auto flex w-full max-w-[1800px] flex-col', gap)}>
      <div className="flex items-center gap-3">
        {!searchHidden && <SearchBar query={query} onQueryChange={setQuery} engine={engine} />}
        <DateLine className={cx(searchHidden ? 'block' : 'max-md:hidden')} />
      </div>
      {wide && side.length > 0 && main.length > 0 ? (
        <div className={cx('grid items-start grid-cols-[minmax(0,1fr)_minmax(300px,24rem)]', gap)}>
          <div className={cx('flex min-w-0 flex-col', gap)}>{main.map(render)}</div>
          <div className={cx('flex min-w-0 flex-col', gap)}>{side.map(render)}</div>
        </div>
      ) : (
        <div className={cx('flex min-w-0 flex-col', gap)}>{visible.map(render)}</div>
      )}
    </div>
  );
}

/** Saved order and visibility applied to the registered widgets (phone: shopping, agenda first). */
export function orderSections(
  widgets: readonly DashboardWidget[],
  saved: Parameters<typeof resolveDashboardSections>[1],
  phone: boolean,
): { searchHidden: boolean; visible: ResolvedSection[] } {
  const { searchHidden, sections } = resolveDashboardSections(widgets, saved);
  let visible = sections.filter((s) => !s.hidden);
  if (phone) {
    const first = PHONE_FIRST.flatMap((id) => visible.filter((s) => s.id === id));
    visible = [...first, ...visible.filter((s) => !PHONE_FIRST.includes(s.id))];
  }
  return { searchHidden, visible };
}

function Section({ widget, query }: { widget: DashboardWidget; query: string }) {
  const Widget = widget.component;
  const frame = FRAME[widget.id] ?? 'panel';
  let body: ReactNode = <Widget query={query} />;
  if (frame === 'panel') {
    body = (
      <Panel title={widget.title} flush={false}>
        {body}
      </Panel>
    );
  } else if (frame === 'plain') {
    body = (
      <div className="overflow-hidden rounded-md border border-line bg-surface shadow-sm">
        {body}
      </div>
    );
  }
  return (
    <section aria-label={widget.title} data-section={widget.id} className="min-w-0">
      <WidgetBoundary title={widget.title}>{body}</WidgetBoundary>
    </section>
  );
}

/** "Fri 14 Nov · week 46" in the user's locale; no extra vertical space next to the search bar. */
function DateLine({ className }: { className?: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  const day = now.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  return (
    <p
      className={cx(
        'shrink-0 whitespace-nowrap text-right text-xs leading-tight text-fg-3',
        className,
      )}
    >
      <span className="block font-medium text-fg-2">{day}</span>
      <span className="block">Week {isoWeek(now)}</span>
    </p>
  );
}
