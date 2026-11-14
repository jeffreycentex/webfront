import type { ColourKey } from '@webfront/shared';
import { cx, colourStyle } from '@/ui';
import type { DayItem, EventLike } from './dates';
import { timeLabel } from './format';
import type { CalendarEvent } from './model';
import { linkify } from './text';

/** Text with http(s) links made clickable. Everything is rendered as React text nodes. */
export function Linkified({ text }: { text: string }) {
  return (
    <>
      {linkify(text).map((part, i) =>
        part.type === 'link' ? (
          <a
            key={i}
            href={part.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-accent-text underline underline-offset-2 hover:no-underline"
          >
            {part.value}
          </a>
        ) : (
          <span key={i}>{part.value}</span>
        ),
      )}
    </>
  );
}

export interface AgendaRowProps {
  item: DayItem<CalendarEvent>;
  colour: ColourKey;
  feedName?: string;
  zone: string;
  /** Dim events that already ended. */
  past?: boolean;
  compact?: boolean;
  onOpen: (event: CalendarEvent, el: HTMLElement) => void;
}

/** One event line: coloured left edge, time, title, location. All-day events get a tinted fill. */
export function AgendaRow({ item, colour, feedName, zone, past, compact, onOpen }: AgendaRowProps) {
  const { event, span } = item;
  return (
    <li>
      <button
        type="button"
        onClick={(e) => onOpen(event, e.currentTarget)}
        style={colourStyle(colour)}
        className={cx(
          'flex min-h-(--row-h) w-full items-center gap-2 border-l-[3px] border-[color:var(--c)] px-2 text-left text-sm hover:brightness-95 focus-visible:outline-2 focus-visible:-outline-offset-2 max-sm:px-3',
          span.allDay ? 'bg-[var(--c-soft)]' : 'hover:bg-surface-2',
          past && 'opacity-60',
        )}
      >
        <span
          className={cx(
            'shrink-0 text-xs tabular-nums text-fg-2',
            compact ? 'w-[4.25rem]' : 'w-[5.25rem]',
          )}
        >
          {timeLabel(item, zone)}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{event.title}</span>
        {!compact && event.location && (
          <span className="hidden max-w-[30%] shrink truncate text-xs text-fg-3 sm:inline">
            {event.location}
          </span>
        )}
        {!compact && feedName && (
          <span className="hidden max-w-[10rem] shrink-0 truncate text-2xs text-[color:var(--c)] lg:inline">
            {feedName}
          </span>
        )}
      </button>
    </li>
  );
}

export type { EventLike };
