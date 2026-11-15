// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/ui';

const data = vi.hoisted(() => ({ store: {} as Record<string, unknown[]>, patch: vi.fn() }));
vi.mock('@/data', () => ({
  useCollection: (name: string) => data.store[name],
  useRecord: () => null,
  put: vi.fn(),
  patch: data.patch,
}));

import AgendaWidget from './AgendaWidget';

const FEED = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-14T15:00:00'));
  data.patch.mockReset().mockResolvedValue({});
  data.store = {
    calendarFeeds: [{ id: FEED, name: 'Work', colour: 'blue', enabled: true }],
    calendarEvents: [
      {
        id: 'e1',
        feedId: FEED,
        title: 'Planning',
        allDay: true,
        start: '2026-11-14',
        end: '2026-11-15',
        location: null,
        description: null,
        url: null,
        recurring: false,
        tz: null,
      },
      {
        id: 'e2',
        feedId: FEED,
        title: 'Far away',
        allDay: true,
        start: '2026-12-25',
        end: '2026-12-26',
        location: null,
        description: null,
        url: null,
        recurring: false,
        tz: null,
      },
    ],
    tasks: [
      { id: 't1', title: 'File taxes', dueDate: '2026-11-10', completedAt: null },
      { id: 't2', title: 'Buy milk', dueDate: '2026-11-14', completedAt: null },
      {
        id: 't3',
        title: 'Done already',
        dueDate: '2026-11-14',
        completedAt: '2026-11-13T10:00:00.000Z',
      },
      { id: 't4', title: 'No date', dueDate: null, completedAt: null },
    ],
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const renderWidget = () =>
  render(
    <MemoryRouter>
      <ToastProvider>
        <AgendaWidget />
      </ToastProvider>
    </MemoryRouter>,
  );

describe('AgendaWidget', () => {
  it('merges events with due and overdue tasks and hides the rest', () => {
    renderWidget();
    expect(screen.getByText('Planning')).toBeTruthy();
    expect(screen.getByText('Buy milk')).toBeTruthy();
    expect(screen.queryByText('Far away')).toBeNull();
    expect(screen.queryByText('Done already')).toBeNull();
    expect(screen.queryByText('No date')).toBeNull();
    const overdue = screen.getByRole('region', { name: 'Overdue' });
    expect(within(overdue).getByText('File taxes')).toBeTruthy();
    expect(screen.getByText('1 overdue')).toBeTruthy();
  });

  it('completes a task from the agenda', async () => {
    renderWidget();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Complete Buy milk' }));
    await waitFor(() => expect(data.patch).toHaveBeenCalled());
    const [collection, id, changes] = data.patch.mock.calls[0]!;
    expect(collection).toBe('tasks');
    expect(id).toBe('t2');
    expect(typeof changes.completedAt).toBe('string');
  });

  it('rolls a recurring task forward instead of ending the series', async () => {
    data.store.tasks = [
      {
        id: 'r1',
        title: 'Water plants',
        dueDate: '2026-11-14',
        completedAt: null,
        repeat: { unit: 'day', interval: 3, weekdays: [], day: null },
        lastCompletedAt: null,
        completionCount: 0,
      },
    ];
    renderWidget();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Complete Water plants' }));
    await waitFor(() => expect(data.patch).toHaveBeenCalled());
    const changes = data.patch.mock.calls[0]![2];
    expect(changes.dueDate).toBe('2026-11-17');
    expect(changes.completedAt).toBeUndefined();
    expect(changes.completionCount).toBe(1);
  });
});
