import { Repeat } from 'lucide-react';
import { useEffect, useState } from 'react';
import { patch } from '@/data';
import { cx, Input, Select } from '@/ui';
import { SHORT_DAYS } from './dates';
import type { Task } from './logic';
import {
  describeRule,
  fillRuleForDate,
  formatLastDone,
  normaliseRule,
  startRule,
  type RepeatRule,
  type RepeatUnit,
} from './recurrence';

const FREQUENCIES: { value: '' | RepeatUnit; label: string }[] = [
  { value: '', label: 'Does not repeat' },
  { value: 'day', label: 'Days' },
  { value: 'week', label: 'Weeks' },
  { value: 'month', label: 'Months' },
  { value: 'year', label: 'Years' },
];
const CHIP_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Monday first

/**
 * Compact repeat control for the task editor: frequency, interval, weekday chips for weekly,
 * and a plain-language summary. Every change writes the whole `repeat` field at once (and, when
 * the task had no due date, its first due date), so devices never merge half a rule.
 */
export function RepeatEditor({ task, today }: { task: Task; today: string }) {
  const rule = task.repeat;
  const [interval, setInterval] = useState(String(rule?.interval ?? 1));
  useEffect(() => setInterval(String(rule?.interval ?? 1)), [rule?.interval]);

  const save = (next: RepeatRule | null) => {
    if (next === null) {
      void patch('tasks', task.id, { repeat: null });
    } else if (task.dueDate === null) {
      const started = startRule(next, today);
      void patch('tasks', task.id, { repeat: started.rule, dueDate: started.dueDate });
    } else {
      void patch('tasks', task.id, { repeat: fillRuleForDate(next, task.dueDate) });
    }
  };

  const setUnit = (unit: '' | RepeatUnit) => {
    if (unit === '') return save(null);
    if (rule && rule.unit === unit) return;
    // Switching unit starts a fresh rule (weekdays / day are re-derived from the due date).
    save({ unit, interval: rule?.interval ?? 1, weekdays: [], day: null });
  };

  const commitInterval = (raw: string) => {
    if (!rule) return;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 999) {
      setInterval(String(rule.interval));
      return;
    }
    if (n !== rule.interval) save({ ...rule, interval: n });
  };

  const toggleDay = (d: number) => {
    if (!rule) return;
    const has = rule.weekdays.includes(d);
    if (has && rule.weekdays.length === 1) return; // keep at least one day
    save(
      normaliseRule({
        ...rule,
        weekdays: has ? rule.weekdays.filter((x) => x !== d) : [...rule.weekdays, d],
      }),
    );
  };

  return (
    <div className="flex flex-col gap-1" data-testid="repeat-editor">
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-fg-3">
        <Repeat className="size-3.5" aria-hidden />
        <span>{rule ? 'Every' : 'Repeat'}</span>
        {rule && (
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={999}
            aria-label="Repeat every"
            value={interval}
            onChange={(e) => setInterval(e.target.value)}
            onBlur={(e) => commitInterval(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                commitInterval(e.currentTarget.value);
              }
            }}
            className="w-14"
          />
        )}
        <span className="inline-flex w-auto">
          <Select
            aria-label="Repeat frequency"
            value={rule?.unit ?? ''}
            onChange={(e) => setUnit(e.target.value as '' | RepeatUnit)}
            className="w-auto"
          >
            {FREQUENCIES.map((f) => {
              const label =
                rule && f.value && rule.interval === 1
                  ? { day: 'Day', week: 'Week', month: 'Month', year: 'Year' }[f.value]
                  : f.label;
              return (
                <option key={f.value} value={f.value}>
                  {label}
                </option>
              );
            })}
          </Select>
        </span>
      </div>
      {rule?.unit === 'week' && (
        <div className="flex flex-wrap gap-1" role="group" aria-label="Repeat on weekdays">
          {CHIP_ORDER.map((d) => {
            const on = rule.weekdays.includes(d);
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
                onClick={() => toggleDay(d)}
                className={cx(
                  'h-6 min-w-9 rounded-full border px-2 text-xs max-sm:h-9 max-sm:min-w-[44px]',
                  on
                    ? 'border-accent bg-accent-soft text-accent-text'
                    : 'border-line-strong text-fg-2 hover:bg-surface-2',
                )}
              >
                {SHORT_DAYS[d]}
              </button>
            );
          })}
        </div>
      )}
      {rule && (
        <p className="text-xs text-fg-3" data-testid="repeat-summary">
          {describeRule(rule)}
          {rule.unit === 'month' && rule.day !== null && rule.day > 28
            ? ' (short months use their last day)'
            : ''}
          {task.lastCompletedAt && ` · last done ${formatLastDone(task.lastCompletedAt, today)}`}
          {task.completionCount > 0 &&
            ` · done ${task.completionCount} ${task.completionCount === 1 ? 'time' : 'times'}`}
        </p>
      )}
    </div>
  );
}
