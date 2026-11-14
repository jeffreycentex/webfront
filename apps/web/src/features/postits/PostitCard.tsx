import type { ColourKey } from '@webfront/shared';
import { Archive, ArchiveRestore, Pin, PinOff, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { patch, remove, restore } from '@/data';
import { colourStyle, ColourDot, ColourPicker, cx, IconButton, Popover, useToast } from '@/ui';
import { writeLastColour, type Postit } from './order';
import { firstLine, linkify } from './text';

/** Note text with auto-linked URLs and preserved line breaks, rendered as React nodes only. */
export function NoteText({ text }: { text: string }) {
  return (
    <>
      {linkify(text).map((s, i) =>
        s.type === 'link' ? (
          <a
            key={i}
            href={s.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent-text underline underline-offset-2 hover:no-underline"
            onClick={(e) => e.stopPropagation()}
          >
            {s.value}
          </a>
        ) : (
          <span key={i}>{s.value}</span>
        ),
      )}
    </>
  );
}

export interface PostitCardProps {
  note: Postit;
  /** 'archived' shows restore / delete instead of pin / colour / archive. */
  mode?: 'active' | 'archived';
  /** Drag handle element (from the sortable wrapper). */
  dragHandle?: ReactNode;
  /** Visual emphasis after arriving from search. */
  highlighted?: boolean;
  /** Limit height (dashboard strip). */
  clamp?: boolean;
  cardRef?: Ref<HTMLDivElement>;
}

/** A sticky-note card: click the text to edit in place (autosaves), Escape finishes. */
export function PostitCard({
  note,
  mode = 'active',
  dragHandle,
  highlighted,
  clamp,
  cardRef,
}: PostitCardProps) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const archived = mode === 'archived';

  const archive = (value: boolean) => {
    void patch('postits', note.id, { archived: value }).then(() =>
      toast({
        title: value ? 'Note archived' : 'Note restored',
        description: firstLine(note.text, 60),
        action: {
          label: 'Undo',
          onClick: () => void patch('postits', note.id, { archived: !value }),
        },
      }),
    );
  };
  const del = () => {
    void remove('postits', note.id).then(() =>
      toast({
        title: 'Note deleted',
        description: firstLine(note.text, 60),
        action: { label: 'Undo', onClick: () => void restore('postits', note.id) },
      }),
    );
  };

  const btn = 'sm:opacity-0 sm:group-hover/note:opacity-100 sm:group-focus-within/note:opacity-100';

  return (
    <div
      ref={cardRef}
      data-postit-id={note.id}
      tabIndex={-1}
      style={colourStyle(note.colour)}
      className={cx(
        'group/note relative flex min-w-0 flex-col rounded-sm border border-[color:var(--c)]/40 border-t-4 border-t-[color:var(--c)] bg-[var(--c-soft)] text-fg shadow-sm outline-none',
        highlighted && 'ring-2 ring-accent ring-offset-1 ring-offset-bg',
        archived && 'opacity-80',
      )}
    >
      <div className="flex items-center gap-0.5 px-0.5 pt-0.5">
        {dragHandle}
        {note.pinned && !archived && (
          <Pin aria-label="Pinned" className="ml-0.5 size-3 fill-current text-fg-2" />
        )}
        <span className="flex-1" />
        {archived ? (
          <>
            <IconButton
              label="Restore"
              size="sm"
              icon={<ArchiveRestore />}
              onClick={() => archive(false)}
            />
            <IconButton label="Delete permanently" size="sm" icon={<Trash2 />} onClick={del} />
          </>
        ) : (
          <>
            <Popover
              label="Note colour"
              placement="bottom-end"
              trigger={
                <IconButton
                  label="Change colour"
                  size="sm"
                  icon={<ColourDot colour={note.colour} />}
                  className={btn}
                />
              }
            >
              {({ close }) => (
                <div className="p-1.5">
                  <ColourPicker
                    value={note.colour}
                    onChange={(c: ColourKey | null) => {
                      if (!c) return;
                      writeLastColour(c);
                      void patch('postits', note.id, { colour: c });
                      close();
                    }}
                  />
                </div>
              )}
            </Popover>
            <IconButton
              label={note.pinned ? 'Unpin' : 'Pin'}
              size="sm"
              icon={note.pinned ? <PinOff /> : <Pin />}
              className={btn}
              onClick={() => void patch('postits', note.id, { pinned: !note.pinned })}
            />
            <IconButton
              label="Archive"
              size="sm"
              icon={<Archive />}
              className={btn}
              onClick={() => archive(true)}
            />
          </>
        )}
      </div>
      {editing && !archived ? (
        <NoteEditor note={note} onDone={() => setEditing(false)} onEmpty={del} />
      ) : (
        <div
          role={archived ? undefined : 'button'}
          tabIndex={archived ? undefined : 0}
          aria-label={archived ? undefined : 'Edit note'}
          onClick={() => !archived && setEditing(true)}
          onKeyDown={(e) => {
            if (!archived && e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault();
              setEditing(true);
            }
          }}
          className={cx(
            'min-h-8 cursor-text whitespace-pre-wrap break-words px-2 pb-2 pt-0.5 text-sm leading-snug outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
            clamp ? 'max-h-32 overflow-hidden' : 'max-h-80 overflow-y-auto',
            archived && 'cursor-default',
          )}
        >
          <NoteText text={note.text} />
        </div>
      )}
    </div>
  );
}

const AUTOSAVE_MS = 600;

/** Textarea that autosaves after a pause, on blur and on Escape (which also closes it). */
function NoteEditor({
  note,
  onDone,
  onEmpty,
}: {
  note: Postit;
  onDone: () => void;
  onEmpty: () => void;
}) {
  const [text, setText] = useState(note.text);
  const latest = useRef(note.text);
  const saved = useRef(note.text);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const ref = useRef<HTMLTextAreaElement>(null);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const value = latest.current;
    if (value.trim() && value !== saved.current) {
      saved.current = value;
      void patch('postits', note.id, { text: value });
    }
  }, [note.id]);

  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
    return flush;
  }, [flush]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [text]);

  const finish = () => {
    flush();
    if (!latest.current.trim()) onEmpty();
    onDone();
  };

  return (
    <textarea
      ref={ref}
      value={text}
      aria-label="Note text"
      maxLength={10_000}
      onChange={(e) => {
        setText(e.target.value);
        latest.current = e.target.value;
        clearTimeout(timer.current);
        timer.current = setTimeout(flush, AUTOSAVE_MS);
      }}
      onBlur={finish}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish();
        }
      }}
      className="min-h-16 w-full resize-none rounded-b-sm bg-transparent px-2 pb-2 pt-0.5 text-sm leading-snug outline-none focus:bg-surface/40"
    />
  );
}
