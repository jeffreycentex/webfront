import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AlignLeft, MoreHorizontal, Repeat, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { patch } from '@/data';
import {
  Badge,
  Checkbox,
  cx,
  DragHandle,
  DropdownMenu,
  IconButton,
  Input,
  Textarea,
  Tooltip,
} from '@/ui';
import { formatDueLabel } from './dates';
import type { GroupId, Task } from './logic';
import { RepeatEditor } from './RepeatEditor';
import { describeRule, formatLastDone } from './recurrence';

export interface TaskRowProps {
  task: Task;
  group: GroupId;
  today: string;
  selected: boolean;
  editing: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onEditDone: () => void;
  onToggle: () => void;
  /** Complete a recurring task for good and drop its repeat rule. */
  onCompleteAndStop: () => void;
  onDelete: () => void;
  phone: boolean;
}

/** One task: checkbox, title (click to edit in place), due chip, notes marker, delete. */
export function TaskRow(props: TaskRowProps) {
  const { task, group, today, selected, editing, onSelect, onEdit, onEditDone, onToggle } = props;
  const sortable = useSortable({ id: task.id, disabled: group === 'completed' });
  const style = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };
  const done = task.completedAt !== null;
  const repeatSummary = task.repeat
    ? [
        describeRule(task.repeat),
        task.lastCompletedAt ? `last done ${formatLastDone(task.lastCompletedAt, today)}` : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  const tone = group === 'overdue' ? 'bad' : group === 'today' ? 'warn' : 'neutral';

  return (
    <li
      ref={sortable.setNodeRef}
      style={style}
      data-task-id={task.id}
      data-selected={selected || undefined}
      aria-current={selected ? 'true' : undefined}
      onFocusCapture={onSelect}
      onMouseDown={onSelect}
      className={cx(
        'group/row relative border-l-2 text-sm',
        group === 'overdue' ? 'border-l-bad bg-bad-soft/40' : 'border-l-transparent',
        group === 'today' && 'border-l-warn bg-warn-soft/40',
        selected && 'bg-accent-soft',
        !selected && 'hover:bg-surface-2',
        sortable.isDragging && 'z-10 bg-surface shadow-md',
      )}
    >
      <div className="flex min-h-(--row-h) items-center gap-1.5 px-2 max-sm:px-3">
        {group !== 'completed' && (
          <DragHandle
            ref={sortable.setActivatorNodeRef}
            {...sortable.attributes}
            {...sortable.listeners}
            aria-label={`Reorder ${task.title}`}
          />
        )}
        <Checkbox
          checked={done}
          onChange={onToggle}
          aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
          className="min-h-0"
        />
        {editing ? (
          <TaskEditor
            task={task}
            today={today}
            onDone={onEditDone}
            onCompleteAndStop={props.onCompleteAndStop}
          />
        ) : (
          <>
            <button
              type="button"
              onClick={onEdit}
              title="Click to edit"
              className={cx(
                'min-w-0 flex-1 truncate py-0.5 text-left max-sm:py-2.5',
                done && 'text-fg-3 line-through',
              )}
            >
              {task.title}
            </button>
            {task.notes && (
              <AlignLeft aria-label="Has notes" className="size-3 shrink-0 text-fg-3" />
            )}
            {task.repeat && (
              <Tooltip label={repeatSummary}>
                <span
                  role="img"
                  aria-label={`Repeats: ${repeatSummary}`}
                  className="inline-flex shrink-0 items-center text-fg-3"
                  data-testid="repeat-icon"
                >
                  <Repeat className="size-3" aria-hidden />
                </span>
              </Tooltip>
            )}
            {task.repeat && task.lastCompletedAt && (
              <span className="hidden shrink-0 text-xs text-fg-3 lg:inline">
                done {formatLastDone(task.lastCompletedAt, today)}
              </span>
            )}
            {task.dueDate && (
              <Badge tone={done ? 'neutral' : tone} className="shrink-0">
                {formatDueLabel(task.dueDate, today)}
              </Badge>
            )}
            {task.repeat && !done && (
              <DropdownMenu
                label={`${task.title} actions`}
                placement="bottom-end"
                items={[
                  {
                    label: 'Complete and stop repeating',
                    onSelect: props.onCompleteAndStop,
                  },
                ]}
                trigger={
                  <IconButton
                    label={`${task.title} actions`}
                    icon={<MoreHorizontal />}
                    size="sm"
                    className="sm:opacity-0 sm:group-focus-within/row:opacity-100 sm:group-hover/row:opacity-100"
                  />
                }
              />
            )}
            <IconButton
              label={`Delete ${task.title}`}
              icon={<Trash2 />}
              size="sm"
              onClick={props.onDelete}
              className="sm:opacity-0 sm:group-focus-within/row:opacity-100 sm:group-hover/row:opacity-100"
            />
          </>
        )}
      </div>
    </li>
  );
}

/** In-place editor: title, due date and notes. Each field saves when it loses focus / changes. */
function TaskEditor({
  task,
  today,
  onDone,
  onCompleteAndStop,
}: {
  task: Task;
  today: string;
  onDone: () => void;
  onCompleteAndStop: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => titleRef.current?.focus(), []);

  const saveTitle = () => {
    const t = title.trim();
    if (t && t !== task.title) void patch('tasks', task.id, { title: t });
    else if (!t) setTitle(task.title);
  };
  const saveNotes = () => {
    if (notes !== task.notes) void patch('tasks', task.id, { notes });
  };
  /** Changing the due date of a monthly task re-anchors its day of the month. */
  const changeDue = (dueDate: string | null) => {
    const day = dueDate ? Number(dueDate.slice(8, 10)) : 0;
    if (task.repeat?.unit === 'month' && day >= 1 && task.repeat.day !== null) {
      void patch('tasks', task.id, { dueDate, repeat: { ...task.repeat, day } });
    } else void patch('tasks', task.id, { dueDate });
  };
  const finish = () => {
    saveTitle();
    saveNotes();
    onDone();
  };

  return (
    <div
      className="flex min-w-0 flex-1 flex-col gap-1 py-1"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          finish();
        }
      }}
    >
      <Input
        ref={titleRef}
        value={title}
        aria-label="Task title"
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={saveTitle}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            finish();
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <label className="flex items-center gap-1 text-xs text-fg-3">
          Due
          <Input
            type="date"
            aria-label="Due date"
            value={task.dueDate ?? ''}
            min="1970-01-01"
            onChange={(e) => changeDue(e.target.value || null)}
            className="w-auto"
          />
        </label>
        <button
          type="button"
          className="text-xs text-accent-text hover:underline max-sm:py-2"
          onClick={() => void patch('tasks', task.id, { dueDate: today })}
        >
          Today
        </button>
        {task.dueDate && !task.repeat && (
          <button
            type="button"
            className="text-xs text-fg-3 hover:underline max-sm:py-2"
            onClick={() => void patch('tasks', task.id, { dueDate: null })}
          >
            Clear date
          </button>
        )}
        <button
          type="button"
          className="ml-auto text-xs font-medium text-accent-text hover:underline max-sm:py-2"
          onClick={finish}
        >
          Done
        </button>
      </div>
      <RepeatEditor task={task} today={today} />
      {task.repeat && (
        <button
          type="button"
          className="self-start text-xs text-fg-2 hover:underline max-sm:py-2"
          onClick={() => {
            onCompleteAndStop();
            onDone();
          }}
        >
          Complete and stop repeating
        </button>
      )}
      <Textarea
        value={notes}
        rows={2}
        aria-label="Notes"
        placeholder="Notes"
        onChange={(e) => setNotes(e.target.value)}
        onBlur={saveNotes}
      />
    </div>
  );
}
