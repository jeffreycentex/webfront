// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearLocalData, put, reader } from '@/data';
import { ToastProvider } from '@/ui';
import { addDays, todayISO } from './dates';
import TasksWidget from './TasksWidget';

beforeEach(clearLocalData);
afterEach(cleanup);

const renderWidget = (query?: string) =>
  render(
    <ToastProvider>
      <MemoryRouter>
        <TasksWidget query={query} />
      </MemoryRouter>
    </ToastProvider>,
  );

const titles = () => screen.getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'));

describe('tasks dashboard widget', () => {
  it('lists overdue, today, upcoming and undated tasks in that order', async () => {
    const today = todayISO();
    await put('tasks', { title: 'someday', sortKey: 'a0' });
    await put('tasks', { title: 'later', dueDate: addDays(today, 3), sortKey: 'a1' });
    await put('tasks', { title: 'now', dueDate: today, sortKey: 'a2' });
    await put('tasks', { title: 'late', dueDate: addDays(today, -1), sortKey: 'a3' });
    await put('tasks', { title: 'finished', completedAt: new Date().toISOString(), sortKey: 'a4' });
    renderWidget();
    await screen.findByText('someday');
    expect(titles()).toEqual([
      'Complete late',
      'Complete now',
      'Complete later',
      'Complete someday',
    ]);
  });

  it('quick add creates a task with a parsed date', async () => {
    const user = userEvent.setup();
    renderWidget();
    await user.type(await screen.findByLabelText('New task'), 'pay rent tomorrow{Enter}');
    await waitFor(async () => expect(await reader.list('tasks')).toHaveLength(1));
    const [t] = await reader.list('tasks');
    expect(t).toMatchObject({ title: 'pay rent', dueDate: addDays(todayISO(), 1) });
    expect(await screen.findByText('pay rent')).toBeInTheDocument();
  });

  it('completes with the checkbox and offers Undo', async () => {
    const user = userEvent.setup();
    await put('tasks', { title: 'walk dog', sortKey: 'a0' });
    renderWidget();
    await user.click(await screen.findByRole('checkbox', { name: 'Complete walk dog' }));
    await waitFor(() => expect(screen.queryByText('Complete walk dog')).toBeNull());
    expect((await reader.list('tasks'))[0]!.completedAt).not.toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await reader.list('tasks'))[0]!.completedAt).toBeNull());
    expect(await screen.findByRole('checkbox', { name: 'Complete walk dog' })).toBeInTheDocument();
  });

  it('caps rows and links "+n more"; query filters titles', async () => {
    for (let i = 0; i < 11; i++) await put('tasks', { title: `task ${i}`, sortKey: `a${i}` });
    const { unmount } = renderWidget();
    await screen.findByText('task 0');
    expect(screen.getAllByRole('checkbox')).toHaveLength(8);
    expect(screen.getByRole('link', { name: '+3 more' })).toHaveAttribute('href', '/tasks');
    unmount();
    renderWidget('task 10');
    await screen.findByText('task 10');
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.queryByText(/more$/)).toBeNull();
  });

  it('keeps the quick add visible when empty', async () => {
    renderWidget();
    expect(await screen.findByText('Nothing to do')).toBeInTheDocument();
    expect(screen.getByLabelText('New task')).toBeInTheDocument();
  });
});
