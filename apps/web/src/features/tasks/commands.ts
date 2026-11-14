import type { Command } from '../types';

export const commands: Command[] = [
  {
    id: 'tasks.new',
    title: 'New task',
    keywords: ['todo', 'add', 'task'],
    run: ({ navigate }) => {
      navigate('/tasks');
      // The page mounts lazily; focus its quick-add box once it exists.
      let tries = 0;
      const focus = () => {
        const el = document.querySelector<HTMLInputElement>('input[aria-label="New task"]');
        if (el) el.focus();
        else if (tries++ < 20) setTimeout(focus, 50);
      };
      setTimeout(focus, 0);
    },
  },
];
