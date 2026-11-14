import { useEffect, useState } from 'react';
import { todayISO } from './dates';

/** The viewer's local date (`YYYY-MM-DD`), refreshed so lists regroup after midnight. */
export function useToday(): string {
  const [today, setToday] = useState(() => todayISO());
  useEffect(() => {
    const tick = () =>
      setToday((prev) => {
        const next = todayISO();
        return next === prev ? prev : next;
      });
    const id = setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);
  return today;
}
