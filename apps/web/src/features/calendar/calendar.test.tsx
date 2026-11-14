// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgendaView } from './AgendaView';
import { MonthView } from './MonthView';
import type { CalendarEvent, CalendarFeed } from './model';

afterEach(cleanup);

const FEED = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const feed = { id: FEED, name: 'Work', colour: 'indigo', enabled: true } as CalendarFeed;
const feedById = new Map([[FEED, feed]]);

let n = 0;
const ev = (title: string, start: string, end: string | null, allDay = false) =>
  ({
    id: `e${++n}`,
    feedId: FEED,
    title,
    start,
    end,
    allDay,
    location: null,
    description: null,
    url: null,
    recurring: false,
    tz: null,
  }) as unknown as CalendarEvent;

const noop = () => {};

describe('AgendaView', () => {
  const events = [
    ev('Late call', '2026-11-14T23:30:00Z', '2026-11-15T00:30:00Z'),
    ev('Trip', '2026-11-16', '2026-11-18', true),
  ];
  const props = {
    events,
    feedById,
    today: '2026-11-14',
    now: Date.parse('2026-11-14T12:00:00Z'),
    onOpen: noop,
  };

  const dayOf = (container: HTMLElement, title: string) =>
    [...container.querySelectorAll('[data-day]')]
      .filter((s) => within(s as HTMLElement).queryByText(title))
      .map((s) => s.getAttribute('data-day'));

  it('groups the same event under different days for different zones', () => {
    const la = render(<AgendaView {...props} zone="America/Los_Angeles" />);
    expect(dayOf(la.container, 'Late call')).toEqual(['2026-11-14']);
    la.unmount();
    const akl = render(<AgendaView {...props} zone="Pacific/Auckland" />);
    expect(dayOf(akl.container, 'Late call')).toEqual(['2026-11-15']);
  });

  it('shows a multi-day all-day event on each day it covers, with an exclusive end', () => {
    const { container } = render(<AgendaView {...props} zone="America/Los_Angeles" />);
    expect(dayOf(container, 'Trip')).toEqual(['2026-11-16', '2026-11-17']);
    expect(screen.getAllByText('Day 1/2').length).toBe(1);
  });

  it('always shows today, even when empty, and labels it', () => {
    const { container } = render(<AgendaView {...props} events={[]} zone="America/Los_Angeles" />);
    const today = container.querySelector('[data-day="2026-11-14"]')!;
    expect(today).toBeTruthy();
    expect(within(today as HTMLElement).getByText('Today')).toBeTruthy();
  });

  it('opens an event with the clicked element', () => {
    const onOpen = vi.fn();
    render(<AgendaView {...props} onOpen={onOpen} zone="America/Los_Angeles" />);
    fireEvent.click(screen.getByText('Late call'));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen.mock.calls[0]![0].title).toBe('Late call');
  });
});

describe('MonthView', () => {
  const base = {
    feedById,
    today: '2026-11-14',
    zone: 'UTC',
    weekStart: 'monday' as const,
    cursor: '2026-11-14',
    onCursor: noop,
    onOpenEvent: noop,
    onOpenDay: noop,
    onToday: noop,
  };

  it('renders weeks, coloured chips and "+n more"', () => {
    const events = [1, 2, 3, 4, 5].map((i) => ev(`Meeting ${i}`, `2026-11-18T1${i}:00:00Z`, null));
    render(<MonthView {...base} events={events} />);
    const cells = screen.getAllByRole('gridcell');
    expect(cells).toHaveLength(42); // November 2026 needs six Monday-first weeks
    const wed = cells.find((c) => c.getAttribute('data-day') === '2026-11-18')!;
    expect(within(wed).getAllByRole('button')).toHaveLength(4); // 3 chips + "+2 more"
    expect(within(wed).getByText('+2 more')).toBeTruthy();
    expect(screen.getAllByRole('columnheader')).toHaveLength(7);
  });

  it('puts a multi-day event on every covered cell', () => {
    render(<MonthView {...base} events={[ev('Trip', '2026-11-20', '2026-11-23', true)]} />);
    const days = screen
      .getAllByRole('gridcell')
      .filter((c) => within(c).queryByText('Trip'))
      .map((c) => c.getAttribute('data-day'));
    expect(days).toEqual(['2026-11-20', '2026-11-21', '2026-11-22']);
  });

  it('starts the week on Sunday when configured', () => {
    render(<MonthView {...base} weekStart="sunday" events={[]} />);
    const cells = screen.getAllByRole('gridcell');
    expect(cells[0]!.getAttribute('data-day')).toBe('2026-11-01');
    expect(cells).toHaveLength(35);
  });

  it('moves the cursor with the keyboard', () => {
    const onCursor = vi.fn();
    const onOpenDay = vi.fn();
    render(<MonthView {...base} events={[]} onCursor={onCursor} onOpenDay={onOpenDay} />);
    const cell = screen
      .getAllByRole('gridcell')
      .find((c) => c.getAttribute('data-day') === '2026-11-14')!;
    expect(cell.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(cell, { key: 'ArrowRight' });
    expect(onCursor).toHaveBeenLastCalledWith('2026-11-15');
    fireEvent.keyDown(cell, { key: 'ArrowDown' });
    expect(onCursor).toHaveBeenLastCalledWith('2026-11-21');
    fireEvent.keyDown(cell, { key: 'PageDown' });
    expect(onCursor).toHaveBeenLastCalledWith('2026-12-14');
    fireEvent.keyDown(cell, { key: 'Enter' });
    expect(onOpenDay).toHaveBeenCalledWith('2026-11-14', cell);
  });
});
