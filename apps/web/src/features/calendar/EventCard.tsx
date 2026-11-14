import type { ColourKey } from '@webfront/shared';
import { ExternalLink, MapPin, Repeat, X } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import {
  Badge,
  ColourDot,
  IconButton,
  Modal,
  Portal,
  cx,
  colourStyle,
  useDismiss,
  useFloating,
  useIsPhone,
} from '@/ui';
import { deviceZone, type DayItem } from './dates';
import { formatDay, whenLabel } from './format';
import type { CalendarEvent, CalendarFeed } from './model';
import { AgendaRow, Linkified } from './rows';
import { plainText } from './text';

/**
 * Popover card anchored to an element (desktop) or a bottom sheet (phone). One instance lives at
 * page level, so chips and rows only need to report the element that was clicked.
 */
export function FloatingCard({
  anchor,
  onClose,
  title,
  colour,
  children,
  label,
}: {
  anchor: HTMLElement;
  onClose: () => void;
  title: ReactNode;
  colour?: ColourKey;
  children: ReactNode;
  label: string;
}) {
  const phone = useIsPhone();
  const close = () => {
    onClose();
    if (document.contains(anchor)) anchor.focus({ preventScroll: true });
  };
  const { ref, style } = useFloating<HTMLDivElement>({
    open: !phone,
    anchor: () => anchor,
    placement: 'bottom-start',
  });
  useDismiss(!phone, close, [ref]);

  if (phone) {
    return (
      <Modal open onClose={close} title={title} size="sm">
        {children}
      </Modal>
    );
  }
  return (
    <Portal>
      <div
        ref={ref}
        role="dialog"
        aria-label={label}
        style={{ ...style, zIndex: 60, ...colourStyle(colour) }}
        className={cx(
          'scroll-thin w-[22rem] max-w-[calc(100vw-12px)] overflow-auto rounded-md border border-line-strong border-l-[4px] border-l-[color:var(--c,var(--wf-line-strong))] bg-surface text-fg shadow-pop animate-[wf-pop-in_100ms_ease-out]',
        )}
      >
        <div className="flex items-start gap-1 border-b border-line bg-[var(--c-soft,var(--wf-surface-2))] px-2.5 py-1.5">
          <h2 className="min-w-0 flex-1 break-words text-sm font-semibold leading-snug">{title}</h2>
          <IconButton label="Close" size="sm" icon={<X />} onClick={close} />
        </div>
        <div className="p-2.5">{children}</div>
      </div>
    </Portal>
  );
}

export function EventDetails({
  event,
  feed,
  colour,
  anchor,
  onClose,
  zone = deviceZone(),
}: {
  event: CalendarEvent;
  feed: CalendarFeed | undefined;
  colour: ColourKey;
  anchor: HTMLElement;
  onClose: () => void;
  zone?: string;
}) {
  const description = event.description ? plainText(event.description) : '';
  const link = event.url && /^https?:\/\//i.test(event.url) ? event.url : null;
  const originalZone = !event.allDay && event.tz && event.tz !== zone ? event.tz : null;
  return (
    <FloatingCard
      anchor={anchor}
      onClose={onClose}
      title={event.title}
      colour={colour}
      label={`Event: ${event.title}`}
    >
      <div className="flex flex-col gap-1.5 text-sm">
        <p className="text-fg">{whenLabel(event, zone)}</p>
        {originalZone && <p className="text-xs text-fg-3">Scheduled in {originalZone}</p>}
        {event.recurring && (
          <p className="inline-flex items-center gap-1 text-xs text-fg-3">
            <Repeat className="size-3" aria-hidden /> Repeats
          </p>
        )}
        {event.location && (
          <p className="flex items-start gap-1 break-words text-fg-2">
            <MapPin className="mt-0.5 size-3.5 shrink-0 text-fg-3" aria-hidden />
            <span className="min-w-0">
              <Linkified text={plainText(event.location)} />
            </span>
          </p>
        )}
        {description && (
          <div className="scroll-thin max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-surface-2 p-1.5 text-xs text-fg-2">
            <Linkified
              text={description.length > 4000 ? `${description.slice(0, 4000)}…` : description}
            />
          </div>
        )}
        <div className="flex items-center gap-2 pt-0.5 text-xs text-fg-3">
          <span className="inline-flex min-w-0 items-center gap-1">
            <ColourDot colour={colour} />
            <span className="truncate">{feed?.name ?? 'Calendar'}</span>
          </span>
          {link && (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto inline-flex shrink-0 items-center gap-1 text-accent-text hover:underline"
            >
              Open in calendar <ExternalLink className="size-3" aria-hidden />
            </a>
          )}
        </div>
      </div>
    </FloatingCard>
  );
}

/** All events of one day (the month view's "+n more" popover and the phone day list). */
export function DayList({
  items,
  feedById,
  zone,
  onOpen,
  emptyText = 'Nothing scheduled.',
}: {
  items: DayItem<CalendarEvent>[];
  feedById: Map<string, CalendarFeed>;
  zone: string;
  onOpen: (event: CalendarEvent, el: HTMLElement) => void;
  emptyText?: string;
}) {
  if (items.length === 0) return <p className="px-2 py-1.5 text-xs text-fg-3">{emptyText}</p>;
  return (
    <ul className="divide-y divide-line">
      {items.map((item) => {
        const feed = feedById.get(item.event.feedId);
        return (
          <AgendaRow
            key={item.event.id}
            item={item}
            colour={feed?.colour ?? 'blue'}
            zone={zone}
            compact
            onOpen={onOpen}
            {...(feed ? { feedName: feed.name } : {})}
          />
        );
      })}
    </ul>
  );
}

export function DayDetails({
  day,
  items,
  feedById,
  anchor,
  onClose,
  onOpen,
  zone,
}: {
  day: string;
  items: DayItem<CalendarEvent>[];
  feedById: Map<string, CalendarFeed>;
  anchor: HTMLElement;
  onClose: () => void;
  onOpen: (event: CalendarEvent, el: HTMLElement) => void;
  zone: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <FloatingCard
      anchor={anchor}
      onClose={onClose}
      title={formatDay(day, 'long')}
      label={`Events on ${formatDay(day, 'long')}`}
    >
      <div ref={ref} className="-m-2.5 flex flex-col">
        <DayList items={items} feedById={feedById} zone={zone} onOpen={onOpen} />
        {items.length > 0 && (
          <div className="border-t border-line px-2.5 py-1 text-right">
            <Badge>{items.length}</Badge>
          </div>
        )}
      </div>
    </FloatingCard>
  );
}
