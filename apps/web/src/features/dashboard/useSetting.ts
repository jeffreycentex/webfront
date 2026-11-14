import { put, useRecord } from '@/data';
import { readSetting, type SettingDef } from '@webfront/shared';
import { useCallback } from 'react';

/** A synced setting: its current value (the default while loading or unset) and a setter. */
export function useSetting<T>(def: SettingDef<T>): [T, (next: T) => Promise<void>] {
  const record = useRecord('settings', def.key);
  const value = readSetting(def, record?.value);
  const set = useCallback(
    async (next: T) => {
      await put('settings', { value: next as never }, { id: def.key });
    },
    [def.key],
  );
  return [value, set];
}
