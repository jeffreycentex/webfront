// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearLocalData, put, reader } from '@/data';
import { ToastProvider } from '@/ui';
import { addDays, todayISO } from './dates';
import { tasksSearchProvider } from './search';
import { TasksPage } from './TasksPage';

beforeEach(clearLocalData);
afterEach(cleanup);

const renderPage = () =>
  render(
    <ToastProvider>
      <TasksPage />
    </ToastProvider>,
  );

describe('tasks page', () => {
  it('quick add parses a due date into a removable chip and saves a local date', async () => {
    const user = userEvent.setup();
    renderPage();
    const input = await screen.findByLabelText('New task');
    await user.type(input, 'pay rent tomorrow');
    expect(await screen.findByTestId('due-chip')).toHaveTextContent('Tomorrow');
    await user.keyboard('{Enter}');
    await waitFor(async () => expect(await reader.list('tasks')).toHaveLength(1));
    const [t] = await reader.list('tasks');
    expect(t).toMatchObject({ title: 'pay rent', dueDate: addDays(todayISO(), 1) });
    expect(input).toHaveValue('');

    await user.type(input, 'call mum fri');
    await user.click(await screen.findByRole('button', { name: 'Remove due date' }));
    expect(screen.queryByTestId('due-chip')).toBeNull();
    await user.keyboard('{Enter}');
    await waitFor(async () => expect(await reader.list('tasks')).toHaveLength(2));
    const titles = (await reader.list('tasks')).map((x) => [x.title, x.dueDate]);
    expect(titles).toContainEqual(['call mum fri', null]);
  });

  it('groups tasks and completes / reopens with the checkbox', async () => {
    const user = userEvent.setup();
    const today = todayISO();
    await put('tasks', { title: 'late one', dueDate: addDays(today, -2), sortKey: 'a0' });
    await put('tasks', { title: 'now one', dueDate: today, sortKey: 'a1' });
    await put('tasks', { title: 'someday', sortKey: 'a2' });
    renderPage();

    const overdue = await screen.findByRole('region', { name: 'Overdue' });
    expect(within(overdue).getByText('late one')).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Today' })).getByText('now one'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'No date' })).getByText('someday'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Complete someday' }));
    await waitFor(async () => {
      const t = (await reader.list('tasks')).find((x) => x.title === 'someday');
      expect(t?.completedAt).toBeTruthy();
    });
    // Completed is collapsed; expand and reopen.
    await user.click(await screen.findByRole('button', { name: /Completed/ }));
    await user.click(await screen.findByRole('checkbox', { name: 'Reopen someday' }));
    await waitFor(async () => {
      const t = (await reader.list('tasks')).find((x) => x.title === 'someday');
      expect(t?.completedAt).toBeNull();
    });
  });

  it('keyboard: arrows select, x toggles, delete removes', async () => {
    const user = userEvent.setup();
    await put('tasks', { title: 'one', sortKey: 'a0' });
    await put('tasks', { title: 'two', sortKey: 'a1' });
    renderPage();
    await screen.findByText('one');
    await user.keyboard('{ArrowDown}{ArrowDown}x');
    await waitFor(async () => {
      const t = (await reader.list('tasks')).find((x) => x.title === 'two');
      expect(t?.completedAt).toBeTruthy();
    });
    await user.keyboard('{ArrowUp}{Delete}');
    await waitFor(async () =>
      expect((await reader.list('tasks')).map((x) => x.title)).toEqual(['two']),
    );
  });
});

describe('search provider', () => {
  it('matches titles and notes', async () => {
    await put('tasks', { title: 'Pay rent', notes: 'landlord', sortKey: 'a0' });
    await put('tasks', { title: 'Other', sortKey: 'a1' });
    expect((await tasksSearchProvider.search('rent', 5)).map((r) => r.title)).toEqual(['Pay rent']);
    expect((await tasksSearchProvider.search('landlord', 5)).map((r) => r.title)).toEqual([
      'Pay rent',
    ]);
    expect(await tasksSearchProvider.search('zzz', 5)).toEqual([]);
  });
});
