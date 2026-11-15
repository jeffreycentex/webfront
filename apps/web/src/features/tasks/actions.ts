import { patch } from '@/data';
import { formatNextDate, nextDueDate } from './recurrence';
import type { Task } from './logic';

/**
 * Completion actions shared by the Tasks page, the dashboard widget and anything else that can
 * tick a task off. A recurring task is never marked completed: it rolls `dueDate` forward (see
 * the convergence rule in recurrence.ts) and records the completion.
 */

export type CompleteResult =
  | { kind: 'rolled'; previous: Task; next: string; message: string }
  | { kind: 'completed'; previous: Task };

/** Complete `task`. Recurring and open: roll forward. Otherwise: set `completedAt`. */
export async function completeTask(task: Task, today: string): Promise<CompleteResult> {
  if (task.repeat && task.completedAt === null) {
    const next = nextDueDate(task.dueDate, task.repeat, today);
    await patch('tasks', task.id, {
      dueDate: next,
      lastCompletedAt: new Date().toISOString(),
      completionCount: task.completionCount + 1,
    });
    return {
      kind: 'rolled',
      previous: task,
      next,
      message: `Done. Next: ${formatNextDate(next, today)}`,
    };
  }
  await patch('tasks', task.id, { completedAt: new Date().toISOString() });
  return { kind: 'completed', previous: task };
}

/** Undo `completeTask`: restore the previous due date and completion bookkeeping. */
export async function undoComplete(result: CompleteResult): Promise<void> {
  const t = result.previous;
  if (result.kind === 'rolled') {
    await patch('tasks', t.id, {
      dueDate: t.dueDate,
      lastCompletedAt: t.lastCompletedAt,
      completionCount: t.completionCount,
    });
  } else {
    await patch('tasks', t.id, { completedAt: t.completedAt });
  }
}

/** Finish a recurring task for good: mark it completed and drop the rule in one write. */
export async function completeAndStop(task: Task): Promise<void> {
  const now = new Date().toISOString();
  await patch('tasks', task.id, {
    completedAt: now,
    repeat: null,
    ...(task.repeat ? { lastCompletedAt: now, completionCount: task.completionCount + 1 } : {}),
  });
}
