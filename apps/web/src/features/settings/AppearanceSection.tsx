import {
  coreSettings,
  resolveDashboardSections,
  sectionsToSetting,
  type ColourKey,
} from '@webfront/shared';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useCollection } from '@/data';
import { useFeatures } from '../context';
import {
  ColourPicker,
  IconButton,
  Select,
  Switch,
  TagChip,
  cx,
  useTheme,
  type ThemePreference,
} from '@/ui';
import { THEMES, type ThemeDef, type ThemeId } from '../../lib/theme';
import { useSetting } from './useSetting';
import { safeGet, safeSet } from './deviceStorage';

export default function AppearanceSection() {
  return (
    <div className="flex flex-col gap-4 text-sm">
      <ThemePicker />
      <DeviceChoices />
      <SectionsEditor />
      <TagColours />
    </div>
  );
}

/** Swatch card grid (radio group) plus the light / dark themes used when following the system. */
function ThemePicker() {
  const theme = useTheme();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const options: { value: ThemePreference; def?: ThemeDef }[] = [
    ...THEMES.map((def) => ({ value: def.id as ThemePreference, def })),
    { value: 'system' },
  ];
  const selected = Math.max(
    0,
    options.findIndex((o) => o.value === theme.preference),
  );
  const onKey = (e: KeyboardEvent, i: number) => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0;
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : i + step;
    if (!step && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const n = (to + options.length) % options.length;
    theme.setPreference(options[n]!.value);
    refs.current[n]?.focus();
  };
  const pick = (mode: 'light' | 'dark') => THEMES.filter((t) => t.mode === mode);
  return (
    <div>
      <h3 className="label-caps mb-1 text-fg-3" id="theme-picker-label">
        Theme
      </h3>
      <div
        role="radiogroup"
        aria-labelledby="theme-picker-label"
        className="grid max-w-xl grid-cols-2 gap-2 sm:grid-cols-4"
      >
        {options.map((o, i) => {
          const on = i === selected;
          const name = o.def?.name ?? 'Match system';
          return (
            <button
              key={o.value}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              onClick={() => theme.setPreference(o.value)}
              onKeyDown={(e) => onKey(e, i)}
              className={cx(
                'flex min-h-[var(--row-h)] flex-col gap-1 rounded-md border bg-surface p-1.5 text-left text-xs',
                on ? 'border-accent ring-1 ring-accent' : 'border-line hover:border-line-strong',
              )}
            >
              <span
                aria-hidden
                className="flex h-5 items-center gap-1 rounded-sm border border-line px-1"
                style={
                  o.def
                    ? { background: o.def.chrome }
                    : {
                        background: `linear-gradient(90deg, ${THEMES[0].chrome} 50%, ${THEMES[1].chrome} 50%)`,
                      }
                }
              >
                {(o.def
                  ? o.def.swatch
                  : [...THEMES[0].swatch.slice(0, 2), ...THEMES[1].swatch.slice(1, 3)]
                ).map((c, k) => (
                  <span key={k} className="size-2.5 rounded-full" style={{ background: c }} />
                ))}
              </span>
              <span className={cx('font-medium', on ? 'text-fg' : 'text-fg-2')}>{name}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-2 grid max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-medium text-fg-2">
          When the system is light
          <Select
            value={theme.systemLight}
            onChange={(e) => theme.setSystemLight(e.target.value as ThemeId)}
          >
            {pick('light').map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-fg-2">
          When the system is dark
          <Select
            value={theme.systemDark}
            onChange={(e) => theme.setSystemDark(e.target.value as ThemeId)}
          >
            {pick('dark').map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </label>
        <p className="text-xs text-fg-3 sm:col-span-2">
          These apply when the theme is Match system, so you can pair a light theme by day with a
          dark one at night.
        </p>
      </div>
    </div>
  );
}

function DeviceChoices() {
  const [sidebar, setSidebar] = useState(() =>
    safeGet('wf.sidebar') === 'collapsed' ? 'collapsed' : 'expanded',
  );
  const [density, setDensity] = useState(() =>
    safeGet('wf.density') === 'comfortable' ? 'comfortable' : 'compact',
  );
  return (
    <div className="grid max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
      <label className="flex flex-col gap-1 text-xs font-medium text-fg-2">
        Sidebar
        <Select
          value={sidebar}
          onChange={(e) => {
            setSidebar(e.target.value);
            safeSet('wf.sidebar', e.target.value);
            window.dispatchEvent(new StorageEvent('storage', { key: 'wf.sidebar' }));
          }}
        >
          <option value="expanded">Expanded</option>
          <option value="collapsed">Collapsed</option>
        </Select>
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium text-fg-2">
        Dashboard density
        <Select
          value={density}
          onChange={(e) => {
            setDensity(e.target.value);
            safeSet('wf.density', e.target.value);
          }}
        >
          <option value="compact">Compact</option>
          <option value="comfortable">Comfortable</option>
        </Select>
      </label>
      <p className="text-xs text-fg-3 sm:col-span-2">
        Theme, sidebar and density are remembered on this device only. Week start is on the Calendar
        page.
      </p>
    </div>
  );
}

function SectionsEditor() {
  const { dashboardWidgets } = useFeatures();
  const [saved, setSaved] = useSetting(coreSettings.dashboardSections);
  const { searchHidden, sections } = useMemo(
    () => resolveDashboardSections(dashboardWidgets, saved),
    [dashboardWidgets, saved],
  );
  const write = (next: typeof sections, hideSearch = searchHidden) =>
    void setSaved(sectionsToSetting(next, hideSearch));
  const move = (i: number, d: -1 | 1) => {
    const next = [...sections];
    const [item] = next.splice(i, 1);
    if (!item) return;
    next.splice(i + d, 0, item);
    write(next);
  };
  return (
    <div>
      <h3 className="label-caps mb-1 text-fg-3">Dashboard sections</h3>
      <ul className="max-w-md divide-y divide-line rounded-md border border-line">
        <li className="flex items-center gap-2 px-2 py-1">
          <span className="flex-1">Search bar</span>
          <Switch
            aria-label="Show Search bar"
            checked={!searchHidden}
            onCheckedChange={(on) => write(sections, !on)}
          />
        </li>
        {sections.map((s, i) => (
          <li key={s.id} className="flex items-center gap-1 px-2 py-1">
            <span className={cx('flex-1', s.hidden && 'text-fg-3 line-through')}>{s.title}</span>
            <IconButton
              label={`Move ${s.title} up`}
              icon={<ArrowUp />}
              disabled={i === 0}
              onClick={() => move(i, -1)}
            />
            <IconButton
              label={`Move ${s.title} down`}
              icon={<ArrowDown />}
              disabled={i === sections.length - 1}
              onClick={() => move(i, 1)}
            />
            <Switch
              aria-label={`Show ${s.title}`}
              checked={!s.hidden}
              onCheckedChange={(on) =>
                write(sections.map((x) => (x.id === s.id ? { ...x, hidden: !on } : x)))
              }
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function TagColours() {
  const bookmarks = useCollection('bookmarks');
  const [colours, setColours] = useSetting(coreSettings.tagColours);
  const tags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const b of bookmarks ?? [])
      for (const t of b.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [bookmarks]);
  const set = (tag: string, colour: ColourKey | null) => {
    const next = { ...colours };
    if (colour) next[tag] = colour;
    else delete next[tag];
    void setColours(next);
  };
  return (
    <div>
      <h3 className="label-caps mb-1 text-fg-3">Tag colours</h3>
      {tags.length === 0 ? (
        <p className="text-fg-3">No bookmark tags yet.</p>
      ) : (
        <ul className="scroll-thin max-h-72 max-w-xl divide-y divide-line overflow-auto rounded-md border border-line">
          {tags.map(([tag, n]) => (
            <li key={tag} className="flex flex-wrap items-center gap-2 px-2 py-1">
              <span className="w-40 shrink-0">
                <TagChip label={tag} colour={colours[tag]} />
                <span className="ml-1 text-xs text-fg-3">{n}</span>
              </span>
              <ColourPicker
                label={`Colour for ${tag}`}
                value={colours[tag] ?? null}
                allowNone
                onChange={(c) => set(tag, c)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
