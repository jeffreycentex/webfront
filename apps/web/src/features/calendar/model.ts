import { defineSetting, readSetting, type ColourKey, type RecordOf } from '@webfront/shared';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { z } from 'zod';
import { put, useCollection, useRecord } from '@/data';
import { todayYmd, type WeekStart } from './dates';

export type CalendarEvent = RecordOf<'calendarEvents'>;
export type CalendarFeed = RecordOf<'calendarFeeds'>;

export const weekStartSetting = defineSetting(
  'calendar.weekStart',
  z.enum(['monday', 'sunday']),
  'monday' as WeekStart,
);

/** Week start preference (synced setting). Monday until the setting loads or when unset. */
export function useWeekStart(): [WeekStart, (value: WeekStart) => void] {
  const record = useRecord('settings', weekStartSetting.key);
  const value = record
    ? readSetting(weekStartSetting, record.value)
    : weekStartSetting.defaultValue;
  return [value, (next) => void put('settings', { value: next }, { id: weekStartSetting.key })];
}

/* ---- Legend visibility: a per-device convenience, kept in localStorage (never required). ---- */

const HIDDEN_KEY = 'webfront.calendar.hiddenFeeds';
const listeners = new Set<() => void>();

function readHidden(): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

let hiddenFeeds: ReadonlySet<string> = readHidden();

export function getHiddenFeeds(): ReadonlySet<string> {
  return hiddenFeeds;
}

export function toggleFeedHidden(id: string): void {
  const next = new Set(hiddenFeeds);
  if (!next.delete(id)) next.add(id);
  hiddenFeeds = next;
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next]));
  } catch {
    // Storage unavailable (private window): the toggle still works for this session.
  }
  for (const l of listeners) l();
}

function subscribeHidden(fn: () => void): () => void {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key === HIDDEN_KEY) {
      hiddenFeeds = readHidden();
      fn();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}

export function useHiddenFeeds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeHidden, getHiddenFeeds, getHiddenFeeds);
}

/** Feeds, events and the visibility rules shared by the page, widget and search. */
export function useCalendar() {
  const feeds = useCollection('calendarFeeds');
  const events = useCollection('calendarEvents');
  const hidden = useHiddenFeeds();

  const sortedFeeds = useMemo(
    () =>
      [...(feeds ?? [])].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    [feeds],
  );
  const feedById = useMemo(() => new Map(sortedFeeds.map((f) => [f.id, f])), [sortedFeeds]);
  const visibleEvents = useMemo(
    () =>
      (events ?? []).filter((e) => {
        const f = feedById.get(e.feedId);
        return f !== undefined && f.enabled && !hidden.has(e.feedId);
      }),
    [events, feedById, hidden],
  );
  return {
    feeds: sortedFeeds,
    feedById,
    visibleEvents,
    hidden,
    loading: feeds === undefined || events === undefined,
  };
}

export function feedColour(feed: CalendarFeed | undefined): ColourKey {
  return feed?.colour ?? 'blue';
}

/** Current time, refreshed every 30 seconds and when the tab becomes visible. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const id = setInterval(tick, intervalMs);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [intervalMs]);
  return now;
}

export function useToday(): string {
  const now = useNow();
  return todayYmd(now);
}
