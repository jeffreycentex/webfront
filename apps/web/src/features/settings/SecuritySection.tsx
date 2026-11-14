import { useAuth, useIdleLockMinutes } from '@/auth';
import { Button, Select } from '@/ui';

const PRESETS = [0, 1, 5, 10, 15, 30, 60, 120, 480];

export default function SecuritySection() {
  const [minutes, setMinutes] = useIdleLockMinutes();
  const auth = useAuth();
  const options = PRESETS.includes(minutes) ? PRESETS : [...PRESETS, minutes].sort((a, b) => a - b);
  return (
    <div className="flex max-w-xl flex-col gap-2 text-sm">
      <label className="flex flex-col gap-1 text-xs font-medium text-fg-2">
        Lock this device after being idle for
        <Select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
          {options.map((m) => (
            <option key={m} value={m}>
              {m === 0
                ? 'Never'
                : m >= 60 && m % 60 === 0
                  ? `${m / 60} hour${m === 60 ? '' : 's'}`
                  : `${m} minute${m === 1 ? '' : 's'}`}
            </option>
          ))}
        </Select>
      </label>
      <p className="text-fg-3">
        The lock screen is a convenience that hides the page from someone glancing at your screen.
        It is not encryption: your data is stored unencrypted in this browser, so protect the device
        itself with the operating system login and disk encryption. This setting applies to this
        device only.
      </p>
      <div>
        <Button size="sm" onClick={() => auth.lock()}>
          Lock now
        </Button>
      </div>
    </div>
  );
}
