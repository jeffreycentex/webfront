import { useCollection } from '@/data';
import { countDue } from './logic';
import { useToday } from './useToday';

/** Nav badge: open tasks that are overdue or due today. */
export function useDueBadge(): number | undefined {
  const tasks = useCollection('tasks');
  const today = useToday();
  return tasks ? countDue(tasks, today) : undefined;
}
