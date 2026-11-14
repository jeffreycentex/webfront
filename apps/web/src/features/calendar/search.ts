import { CalendarDays } from 'lucide-react';
import { reader } from '@/data';
import { addDays, deviceZone, spanOf, todayYmd } from './dates';
import { formatDay, timeLabel } from './format';
import { getHiddenFeeds } from './model';
import type { SearchProvider, SearchResult } from '../types';

/** Upcoming events (today onwards) whose title or location contains every search word. */
export const calendarSearchProvider: SearchProvider = {
  id: 'calendar',
  label: 'Calendar',
  async search(query, limit) {
    try {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      if (words.length === 0) return [];
      const zone = deviceZone();
      const today = todayYmd(Date.now(), zone);
      const horizon = addDays(today, 180);
      const [feeds, events] = await Promise.all([
        reader.list('calendarFeeds'),
        reader.list('calendarEvents'),
      ]);
      const hidden = getHiddenFeeds();
      const feedById = new Map(
        feeds.filter((f) => f.enabled && !hidden.has(f.id)).map((f) => [f.id, f]),
      );
      const hits: Array<{ result: SearchResult; sort: number }> = [];
      for (const e of events) {
        const feed = feedById.get(e.feedId);
        if (!feed) continue;
        const span = spanOf(e, zone);
        if (span.lastDay < today || span.startDay > horizon) continue;
        const title = e.title.toLowerCase();
        const hay = `${title} ${(e.location ?? '').toLowerCase()}`;
        if (!words.every((w) => hay.includes(w))) continue;
        const day = span.startDay < today ? today : span.startDay;
        const starts = title.startsWith(words[0]!);
        hits.push({
          sort: span.startMs,
          result: {
            id: e.id,
            title: e.title,
            subtitle: `${formatDay(day)} · ${timeLabel(
              {
                event: e,
                span,
                day,
                isFirstDay: day === span.startDay,
                isLastDay: true,
                dayNumber: 1,
                dayCount: 1,
              },
              zone,
            )} · ${feed.name}`,
            href: `/calendar?date=${day}`,
            score:
              (starts ? 0.55 : 0.4) -
              Math.min(0.2, Math.max(0, (span.startMs - Date.now()) / 86_400_000 / 900)),
            colour: feed.colour,
            icon: CalendarDays,
          },
        });
      }
      return hits
        .sort((a, b) => a.sort - b.sort)
        .slice(0, limit)
        .map((h) => h.result);
    } catch {
      return [];
    }
  },
};
