import type { ColourKey } from '@webfront/shared';
import { useEffect, useRef, useState } from 'react';
import { put, reader } from '@/data';
import { Button, ColourDot, ColourPicker, cx, Popover, Textarea, useIsPhone } from '@/ui';
import { colourStyle } from '@/ui';
import { newNoteKey, readLastColour, writeLastColour } from './order';

/**
 * Quick-capture box: Enter saves, Shift+Enter adds a line, focus stays for the next note.
 * New notes use the last chosen colour (remembered on this device).
 */
export function QuickCapture({
  className,
  autoFocus,
  compact,
}: {
  className?: string;
  autoFocus?: boolean;
  compact?: boolean;
}) {
  const phone = useIsPhone();
  const [text, setText] = useState('');
  const [colour, setColour] = useState<ColourKey>(() => readLastColour());
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow with content (up to the CSS max-height).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const save = async () => {
    const value = text.trim();
    if (!value) return;
    setText('');
    ref.current?.focus();
    const all = await reader.list('postits');
    await put('postits', { text: value, colour, sortKey: newNoteKey(all) });
  };

  const pick = (c: ColourKey | null) => {
    if (!c) return;
    setColour(c);
    writeLastColour(c);
  };

  return (
    <div
      className={cx(
        'flex items-start gap-1.5 rounded-md border border-line-strong border-t-[3px] border-t-[color:var(--c)] bg-[var(--c-soft)] p-1.5 shadow-sm',
        className,
      )}
      style={colourStyle(colour)}
    >
      <Textarea
        ref={ref}
        value={text}
        rows={1}
        autoFocus={autoFocus}
        aria-label="New post-it"
        placeholder="Jot something down… (Enter to save, Shift+Enter for a new line)"
        maxLength={10_000}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void save();
          }
        }}
        className={cx(
          'max-h-40 min-h-(--control-h) flex-1 resize-none bg-surface/70',
          phone && 'min-h-[44px] text-base',
        )}
      />
      <Popover
        label="Note colour"
        placement="bottom-end"
        trigger={
          <Button
            variant="secondary"
            size={compact ? 'sm' : 'md'}
            aria-label={`Note colour: ${colour}`}
            title="Note colour"
            className={phone ? 'h-[44px] w-[44px] !px-0' : 'w-8 !px-0'}
          >
            <ColourDot colour={colour} />
          </Button>
        }
      >
        {({ close }) => (
          <div className="p-1.5">
            <ColourPicker
              value={colour}
              onChange={(c) => {
                pick(c);
                close();
              }}
            />
          </div>
        )}
      </Popover>
      <Button
        variant="primary"
        size={compact ? 'sm' : 'md'}
        disabled={!text.trim()}
        onClick={() => void save()}
        className={phone ? 'h-[44px]' : ''}
      >
        Add
      </Button>
    </div>
  );
}
