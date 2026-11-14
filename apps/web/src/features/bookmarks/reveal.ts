import { useEffect, useState } from 'react';

/** Mask for a hidden hint (fixed length, so it leaks nothing about the real one). */
export const MASK = '••••••••';

export function displayHint(hint: string | null, revealed: boolean): string {
  if (!hint) return '';
  return revealed ? hint : MASK;
}

/**
 * Reveal state for a masked value. It always starts masked and re-masks whenever `open` becomes
 * false or `resetKey` changes (e.g. a different bookmark is shown).
 */
export function useReveal(open: boolean, resetKey?: unknown): [boolean, () => void] {
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    setRevealed(false);
  }, [open, resetKey]);
  return [open && revealed, () => setRevealed((r) => !r)];
}
