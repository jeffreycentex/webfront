// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearLocalData, put, reader } from '@/data';
import { ToastProvider } from '@/ui';
import { addDays, todayISO, weekdayOf } from './dates';
import { formatNextDate, nextDueDate } from './recurrence';
import TasksWidget from './TasksWidget';
import { TasksPage } from './TasksPage';

beforeEach(clearLocalData);
afterEach(cleanup);

const renderPage = () =>
  render(
    <ToastProvider>
      <TasksPage />
    </ToastProvider>,
  );

const get = async (title: string) => {
  const t = (await reader.list('tasks')).find((x) => x.title === title);
  if (!t) throw new Error(`no task ${title}`);
  return t;
};

const daily: { unit: 'day'; interval: number; weekdays: number[]; day: null } = {
  unit: 'day',
  interval: 1,
  weekdays: [],
  day: null,
};

describe('completing a recurring task', () => {
  it('rolls the due date forward, confirms with the next date, and Undo restores it', async () => {
    const user = userEvent.setup();
    const today = todayISO();
    const due = addDays(today, -3);
    await put('tasks', { title: 'water plants', dueDate: due, repeat: daily, sortKey: 'a0' });
    renderPage();

    await user.click(await screen.findByRole('checkbox', { name: 'Complete water plants' }));
    const next = nextDueDate(due, daily, today);
    expect(next).toBe(addDays(today, 1)); // skipped the missed cycles
    expect(
      await screen.findByText(`Done. Next: ${formatNextDate(next, today)}`),
    ).toBeInTheDocument();

    const t = await get('water plants');
    expect(t).toMatchObject({ dueDate: next, completedAt: null, completionCount: 1 });
    expect(t.lastCompletedAt).toBeTruthy();
    // It is now upcoming, not completed or overdue.
    expect(
      within(await screen.findByRole('region', { name: 'Upcoming' })).getByText('water plants'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Overdue' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () =>
      expect(await get('water plants')).toMatchObject({
        dueDate: due,
        completedAt: null,
        completionCount: 0,
        lastCompletedAt: null,
      }),
    );
  });

  it('x completes a recurring task from the keyboard', async () => {
    const user = userEvent.setup();
    const today = todayISO();
    await put('tasks', { title: 'stretch', dueDate: today, repeat: daily, sortKey: 'a0' });
    renderPage();
    await screen.findByText('stretch');
    await user.keyboard('{ArrowDown}x');
    await waitFor(async () => expect((await get('stretch')).dueDate).toBe(addDays(today, 1)));
    expect((await get('stretch')).completedAt).toBeNull();
  });

  it('a one-off task still completes normally', async () => {
    const user = userEvent.setup();
    await put('tasks', { title: 'once', dueDate: todayISO(), sortKey: 'a0' });
    renderPage();
    await user.click(await screen.findByRole('checkbox', { name: 'Complete once' }));
    await waitFor(async () => expect((await get('once')).completedAt).toBeTruthy());
    expect((await get('once')).completionCount).toBe(0);
  });
});

describe('complete and stop repeating', () => {
  it('from the row menu', async () => {
    const user = userEvent.setup();
    await put('tasks', {
      title: 'water plants',
      dueDate: todayISO(),
      repeat: daily,
      sortKey: 'a0',
    });
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'water plants actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Complete and stop repeating' }));
    await waitFor(async () =>
      expect(await get('water plants')).toMatchObject({ repeat: null, completionCount: 1 }),
    );
    expect((await get('water plants')).completedAt).toBeTruthy();
    // Undo brings the series back.
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(async () =>
      expect(await get('water plants')).toMatchObject({ repeat: daily, completedAt: null }),
    );
  });

  it('from the editor', async () => {
    const user = userEvent.setup();
    await put('tasks', {
      title: 'water plants',
      dueDate: todayISO(),
      repeat: daily,
      sortKey: 'a0',
    });
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'water plants' }));
    await user.click(await screen.findByRole('button', { name: 'Complete and stop repeating' }));
    await waitFor(async () => expect((await get('water plants')).repeat).toBeNull());
    expect((await get('water plants')).completedAt).toBeTruthy();
  });
});

describe('repeat editor', () => {
  it('setting a rule on a task without a date gives it a first due date', async () => {
    const user = userEvent.setup();
    await put('tasks', { title: 'gym', sortKey: 'a0' });
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'gym' }));
    await user.selectOptions(screen.getByLabelText('Repeat frequency'), 'week');
    await waitFor(async () => expect((await get('gym')).repeat?.unit).toBe('week'));
    const t = await get('gym');
    expect(t.dueDate).toBe(todayISO());
    expect(t.repeat?.weekdays).toEqual([weekdayOf(todayISO())]);
  });

  it('weekday chips, interval and the plain-language summary', async () => {
    const user = userEvent.setup();
    const today = todayISO();
    await put('tasks', {
      title: 'gym',
      dueDate: today,
      repeat: { unit: 'week', interval: 1, weekdays: [1], day: null },
      sortKey: 'a0',
    });
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'gym' }));
    const group = screen.getByRole('group', { name: 'Repeat on weekdays' });
    // Make the selection Mon + Thu; wait for each write to show before the next click.
    const setDay = async (name: string, on: boolean) => {
      const chip = within(group).getByRole('button', { name });
      if ((chip.getAttribute('aria-pressed') === 'true') === on) return;
      await user.click(chip);
      await waitFor(() => expect(chip).toHaveAttribute('aria-pressed', String(on)));
    };
    for (const d of ['Mon', 'Thu']) await setDay(d, true);
    for (const d of ['Tue', 'Wed', 'Fri', 'Sat', 'Sun']) await setDay(d, false);
    const interval = screen.getByLabelText('Repeat every');
    await user.clear(interval);
    await user.type(interval, '2');
    await user.tab();
    await waitFor(() =>
      expect(screen.getByTestId('repeat-summary')).toHaveTextContent('Every 2 weeks on Mon, Thu'),
    );
    await waitFor(async () =>
      expect((await get('gym')).repeat).toEqual({
        unit: 'week',
        interval: 2,
        weekdays: [1, 4],
        day: null,
      }),
    );
    // The last remaining day cannot be removed.
    await setDay('Thu', false);
    await user.click(within(group).getByRole('button', { name: 'Mon' }));
    expect(within(group).getByRole('button', { name: 'Mon' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect((await get('gym')).repeat?.weekdays).toEqual([1]);
  });

  it('Does not repeat removes the rule and keeps the date', async () => {
    const user = userEvent.setup();
    const today = todayISO();
    await put('tasks', { title: 'water plants', dueDate: today, repeat: daily, sortKey: 'a0' });
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'water plants' }));
    await user.selectOptions(screen.getByLabelText('Repeat frequency'), '');
    await waitFor(async () => expect((await get('water plants')).repeat).toBeNull());
    expect((await get('water plants')).dueDate).toBe(today);
    await waitFor(() => expect(screen.queryByTestId('repeat-summary')).toBeNull());
  });

  it('rows show a repeat icon with the summary', async () => {
    await put('tasks', {
      title: 'gym',
      dueDate: todayISO(),
      repeat: { unit: 'week', interval: 2, weekdays: [1, 4], day: null },
      lastCompletedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      sortKey: 'a0',
    });
    renderPage();
    const icon = await screen.findByTestId('repeat-icon');
    expect(icon).toHaveAttribute(
      'aria-label',
      expect.stringContaining('Every 2 weeks on Mon, Thu'),
    );
    expect(icon).toHaveAttribute('aria-label', expect.stringContaining('last done 3 days ago'));
  });
});

describe('quick add with repeat', () => {
  it('shows a removable chip and saves the rule', async () => {
    const user = userEvent.setup();
    renderPage();
    const input = await screen.findByLabelText('New task');
    await user.type(input, 'gym every mon and thu');
    expect(await screen.findByTestId('repeat-chip')).toHaveTextContent('Every week on Mon, Thu');
    await user.keyboard('{Enter}');
    await waitFor(async () => expect(await reader.list('tasks')).toHaveLength(1));
    const t = await get('gym');
    expect(t.repeat).toEqual({ unit: 'week', interval: 1, weekdays: [1, 4], day: null });
    expect(t.dueDate).toBeTruthy();
  });

  it('removing the chip keeps the full text as the title', async () => {
    const user = userEvent.setup();
    renderPage();
    const input = await screen.findByLabelText('New task');
    await user.type(input, 'water plants every 3 days');
    await user.click(await screen.findByRole('button', { name: 'Remove repeat' }));
    expect(screen.queryByTestId('repeat-chip')).toBeNull();
    await user.keyboard('{Enter}');
    await waitFor(async () => expect(await reader.list('tasks')).toHaveLength(1));
    const [t] = await reader.list('tasks');
    expect(t).toMatchObject({ title: 'water plants every 3 days', repeat: null, dueDate: null });
  });

  it('combines a repeat with a start date', async () => {
    const user = userEvent.setup();
    renderPage();
    const input = await screen.findByLabelText('New task');
    await user.type(input, 'water plants every 3 days starting tomorrow');
    expect(await screen.findByTestId('due-chip')).toHaveTextContent('Tomorrow');
    expect(screen.getByTestId('repeat-chip')).toHaveTextContent('Every 3 days');
    await user.keyboard('{Enter}');
    await waitFor(async () => expect(await reader.list('tasks')).toHaveLength(1));
    expect(await get('water plants')).toMatchObject({
      dueDate: addDays(todayISO(), 1),
      repeat: { unit: 'day', interval: 3 },
    });
  });
});

describe('dashboard widget', () => {
  it('completing a recurring task rolls it forward and shows a repeat icon', async () => {
    const user = userEvent.setup();
    const today = todayISO();
    await put('tasks', { title: 'water plants', dueDate: today, repeat: daily, sortKey: 'a0' });
    render(
      <ToastProvider>
        <MemoryRouter>
          <TasksWidget />
        </MemoryRouter>
      </ToastProvider>,
    );
    expect(await screen.findByRole('img', { name: 'Repeats: Every day' })).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Complete water plants' }));
    await waitFor(async () => expect((await get('water plants')).dueDate).toBe(addDays(today, 1)));
    expect((await get('water plants')).completedAt).toBeNull();
    expect(await screen.findByText(/Done\. Next:/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await get('water plants')).dueDate).toBe(today));
  });
});
