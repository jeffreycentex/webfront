import type { Command } from '../types';

export const commands: Command[] = [
  {
    id: 'postits.new',
    title: 'New post-it',
    keywords: ['note', 'capture', 'jot', 'sticky'],
    run: ({ navigate }) => {
      navigate('/postits');
      // The page is lazy: focus its capture box once it has mounted.
      let tries = 0;
      const focus = () => {
        const el = document.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="New post-it"]',
        );
        if (el) el.focus();
        else if (tries++ < 20) setTimeout(focus, 50);
      };
      setTimeout(focus, 0);
    },
  },
];
