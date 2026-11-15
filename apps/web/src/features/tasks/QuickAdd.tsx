import { sortKeyAfter } from '@webfront/shared';
import { CalendarDays, Plus, Repeat, X } from 'lucide-react';
import { useMemo, useState, type MouseEvent, type Ref } from 'react';
import { put, reader } from '@/data';
import { Button, cx, Input, useIsPhone } from '@/ui';
import { formatDueLabel, formatShortDate } from './dates';
import { parseQuickAdd } from './quickParse';
import { describeRule, formatNextDate } from './recurrence';

/**
 * Quick add with natural-language due dates and repeat phrases ("every 2 weeks", "daily"). Each
 * recognised phrase shows as a chip before saving; removing a chip keeps its words in the title.
 */
export function QuickAdd({
  today,
  inputRef,
  className,
}: {
  today: string;
  inputRef?: Ref<HTMLInputElement>;
  className?: string;
}) {
  const phone = useIsPhone();
  const [text, setText] = useState('');
  const [ignoreDate, setIgnoreDate] = useState(false);
  const [ignoreRepeat, setIgnoreRepeat] = useState(false);
  const parsed = useMemo(
    () => parseQuickAdd(text, today, { ignoreDate, ignoreRepeat }),
    [text, today, ignoreDate, ignoreRepeat],
  );
  const { dueDate, rule, title } = parsed;

  const submit = async () => {
    if (!title) return;
    const all = await reader.list('tasks');
    let last: string | null = null;
    for (const t of all) if (last === null || t.sortKey > last) last = t.sortKey;
    setText('');
    setIgnoreDate(false);
    setIgnoreRepeat(false);
    await put('tasks', { title, dueDate, repeat: rule, sortKey: sortKeyAfter(last) });
  };

  const removeChip = (e: MouseEvent<HTMLButtonElement>, remove: () => void) => {
    remove();
    e.currentTarget.closest('form')?.querySelector('input')?.focus();
  };

  return (
    <form
      className={cx('flex flex-col gap-1', className)}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-center gap-1.5">
        <Input
          ref={inputRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (!e.target.value) {
              setIgnoreDate(false);
              setIgnoreRepeat(false);
            }
          }}
          placeholder="Add a task… try “pay rent tomorrow” or “call mum fri”"
          aria-label="New task"
          className={cx('flex-1', phone && 'h-[44px] text-base')}
          maxLength={200}
          autoComplete="off"
          enterKeyHint="done"
        />
        <Button
          type="submit"
          variant="primary"
          disabled={!title}
          className={phone ? 'h-[44px]' : ''}
        >
          <Plus className="size-3.5" aria-hidden /> Add
        </Button>
      </div>
      {(parsed.datePhrase || rule) && (
        <div
          className="flex flex-wrap items-center gap-1.5 text-xs text-fg-3"
          data-testid="due-chip-row"
        >
          {parsed.datePhrase && dueDate && (
            <>
              <span>Due</span>
              <span className="inline-flex h-5 items-center gap-1 rounded-full bg-accent-soft pl-1.5 pr-0.5 text-accent-text">
                <CalendarDays className="size-3" aria-hidden />
                <span data-testid="due-chip">
                  {formatDueLabel(dueDate, today)} · {formatShortDate(dueDate, today)}
                </span>
                <button
                  type="button"
                  aria-label="Remove due date"
                  onClick={(e) => removeChip(e, () => setIgnoreDate(true))}
                  className="inline-flex size-4 items-center justify-center rounded-full hover:bg-accent/20"
                >
                  <X className="size-3" aria-hidden />
                </button>
              </span>
            </>
          )}
          {rule && (
            <span className="inline-flex h-5 items-center gap-1 rounded-full bg-accent-soft pl-1.5 pr-0.5 text-accent-text">
              <Repeat className="size-3" aria-hidden />
              <span data-testid="repeat-chip">
                {describeRule(rule)}
                {!parsed.datePhrase && dueDate && ` · from ${formatNextDate(dueDate, today)}`}
              </span>
              <button
                type="button"
                aria-label="Remove repeat"
                onClick={(e) => removeChip(e, () => setIgnoreRepeat(true))}
                className="inline-flex size-4 items-center justify-center rounded-full hover:bg-accent/20"
              >
                <X className="size-3" aria-hidden />
              </button>
            </span>
          )}
        </div>
      )}
    </form>
  );
}
