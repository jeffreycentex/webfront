import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorSelection, EditorState, type ChangeSpec } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  placeholder as placeholderExt,
  type Command,
} from '@codemirror/view';
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import '../wiki.css';

/**
 * CodeMirror 6 Markdown editor (lazy chunk). Uncontrolled: `initial` seeds the document,
 * `replace` pushes an external text in (a merge or a remote change), `onChange` reports edits.
 */

export type FormatKind =
  'bold' | 'italic' | 'code' | 'link' | 'heading' | 'list' | 'task' | 'wikilink';

export interface EditorHandle {
  format(kind: FormatKind): void;
  insert(text: string): void;
  focus(): void;
}

export interface EditorProps {
  initial: string;
  /** Bump `n` to replace the document with `text` (keeps the cursor near where it was). */
  replace?: { text: string; n: number };
  onChange: (text: string) => void;
  onBlur?: () => void;
  /** Titles offered by `[[` autocomplete. */
  titles: () => string[];
  /** Turn pasted/dropped image files into Markdown (upload or keep offline). */
  onImages?: (files: File[]) => Promise<string[]>;
  ref?: Ref<EditorHandle>;
  className?: string;
}

/* --------------------------------------------------------------- formatting commands */

function wrap(marker: string, empty = 'text'): Command {
  return (view) => {
    view.dispatch(
      view.state.changeByRange((range) => {
        const sel = view.state.sliceDoc(range.from, range.to);
        if (sel.startsWith(marker) && sel.endsWith(marker) && sel.length >= marker.length * 2) {
          const inner = sel.slice(marker.length, sel.length - marker.length);
          return {
            changes: { from: range.from, to: range.to, insert: inner },
            range: EditorSelection.range(range.from, range.from + inner.length),
          };
        }
        const text = sel || empty;
        return {
          changes: { from: range.from, to: range.to, insert: `${marker}${text}${marker}` },
          range: EditorSelection.range(
            range.from + marker.length,
            range.from + marker.length + text.length,
          ),
        };
      }),
    );
    return true;
  };
}

const link: Command = (view) => {
  view.dispatch(
    view.state.changeByRange((range) => {
      const sel = view.state.sliceDoc(range.from, range.to) || 'link text';
      const insert = `[${sel}](https://)`;
      const urlStart = range.from + sel.length + 3;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.range(urlStart, urlStart + 8),
      };
    }),
  );
  return true;
};

const wikilink: Command = (view) => {
  view.dispatch(
    view.state.changeByRange((range) => {
      const sel = view.state.sliceDoc(range.from, range.to);
      return {
        changes: { from: range.from, to: range.to, insert: `[[${sel}]]` },
        range: EditorSelection.cursor(range.from + 2 + sel.length),
      };
    }),
  );
  return true;
};

/** Toggle / cycle a line prefix on every selected line. */
function linePrefix(kind: 'heading' | 'list' | 'task'): Command {
  return (view) => {
    const { state } = view;
    const changes: ChangeSpec[] = [];
    const seen = new Set<number>();
    for (const r of state.selection.ranges) {
      for (let pos = r.from; pos <= r.to;) {
        const line = state.doc.lineAt(pos);
        if (!seen.has(line.number)) {
          seen.add(line.number);
          const text = line.text;
          if (kind === 'heading') {
            const m = /^(#{1,6}) /.exec(text);
            const level = m ? m[1]!.length : 0;
            const next = level === 0 ? '## ' : level >= 4 ? '' : `${'#'.repeat(level + 1)} `;
            changes.push({ from: line.from, to: line.from + (m ? m[0].length : 0), insert: next });
          } else {
            const re = kind === 'list' ? /^(\s*)[-*+] (?!\[[ xX]\] )/ : /^(\s*)[-*+] \[[ xX]\] /;
            const m = re.exec(text);
            const prefix = kind === 'list' ? '- ' : '- [ ] ';
            if (m)
              changes.push({
                from: line.from + m[1]!.length,
                to: line.from + m[0].length,
                insert: '',
              });
            else {
              const indent = /^\s*/.exec(text)![0].length;
              changes.push({ from: line.from + indent, insert: prefix });
            }
          }
        }
        if (line.to >= r.to) break;
        pos = line.to + 1;
      }
    }
    view.dispatch({ changes });
    return true;
  };
}

const COMMANDS: Record<FormatKind, Command> = {
  bold: wrap('**'),
  italic: wrap('_'),
  code: wrap('`', 'code'),
  link,
  heading: linePrefix('heading'),
  list: linePrefix('list'),
  task: linePrefix('task'),
  wikilink,
};

/* ------------------------------------------------------------------- [[ completion */

function wikiCompletion(titles: () => string[]) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const m = ctx.matchBefore(/\[\[[^\]\n|]*$/);
    if (!m) return null;
    const from = m.from + 2;
    const after = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2);
    const close = after === ']]' ? '' : ']]';
    return {
      from,
      validFor: /^[^\]\n|]*$/,
      options: titles().map((t) => ({
        label: t,
        type: 'text',
        apply: (view: EditorView, _c: unknown, f: number, to: number) => {
          view.dispatch({
            changes: { from: f, to, insert: `${t}${close}` },
            selection: { anchor: f + t.length + 2 },
          });
        },
      })),
    };
  };
}

/* ----------------------------------------------------------------------- component */

export default function Editor({
  initial,
  replace,
  onChange,
  onBlur,
  titles,
  onImages,
  ref,
  className,
}: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cb = useRef({ onChange, onBlur, titles, onImages });
  cb.current = { onChange, onBlur, titles, onImages };
  const lastReplace = useRef(replace?.n ?? 0);

  useEffect(() => {
    if (!host.current) return;
    const insertImages = (files: File[], at: number | null) => {
      const handler = cb.current.onImages;
      if (!handler || files.length === 0) return false;
      void handler(files).then((snippets) => {
        const v = view.current;
        if (!v || snippets.length === 0) return;
        const pos = Math.min(at ?? v.state.selection.main.head, v.state.doc.length);
        const text = snippets.join('\n');
        v.dispatch({
          changes: { from: pos, insert: text },
          selection: { anchor: pos + text.length },
        });
      });
      return true;
    };
    const imagesOf = (list: FileList | null | undefined) =>
      [...(list ?? [])].filter((f) => f.type.startsWith('image/'));

    const state = EditorState.create({
      doc: initial,
      extensions: [
        history(),
        drawSelection(),
        highlightActiveLine(),
        closeBrackets(),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        placeholderExt('Write in Markdown. [[ links a page, Ctrl/Cmd+B bold, paste images…'),
        autocompletion({ override: [wikiCompletion(() => cb.current.titles())], icons: false }),
        keymap.of([
          { key: 'Mod-b', run: COMMANDS.bold },
          { key: 'Mod-i', run: COMMANDS.italic },
          { key: 'Mod-e', run: COMMANDS.code },
          { key: 'Mod-k', run: COMMANDS.link },
          { key: 'Mod-Alt-h', run: COMMANDS.heading },
          { key: 'Mod-Shift-8', run: COMMANDS.list },
          { key: 'Mod-Shift-9', run: COMMANDS.task },
          ...closeBracketsKeymap,
          ...completionKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) cb.current.onChange(u.state.doc.toString());
        }),
        EditorView.domEventHandlers({
          blur: () => {
            cb.current.onBlur?.();
          },
          paste: (e) => {
            const files = imagesOf(e.clipboardData?.files);
            if (files.length === 0) return false;
            e.preventDefault();
            return insertImages(files, null);
          },
          drop: (e, v) => {
            const files = imagesOf(e.dataTransfer?.files);
            if (files.length === 0) return false;
            e.preventDefault();
            return insertImages(files, v.posAtCoords({ x: e.clientX, y: e.clientY }));
          },
        }),
        EditorView.contentAttributes.of({
          'aria-label': 'Page text (Markdown)',
          spellcheck: 'true',
        }),
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // The editor is created once per mount; later `initial` changes go through `replace`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = view.current;
    if (!v || !replace || replace.n === lastReplace.current) return;
    lastReplace.current = replace.n;
    const current = v.state.doc.toString();
    if (current === replace.text) return;
    // Replace only the differing middle so the cursor and scroll stay put.
    let start = 0;
    while (
      start < current.length &&
      start < replace.text.length &&
      current[start] === replace.text[start]
    )
      start++;
    let endA = current.length;
    let endB = replace.text.length;
    while (endA > start && endB > start && current[endA - 1] === replace.text[endB - 1]) {
      endA--;
      endB--;
    }
    v.dispatch({ changes: { from: start, to: endA, insert: replace.text.slice(start, endB) } });
  }, [replace]);

  useImperativeHandle(
    ref,
    () => ({
      format: (kind) => {
        const v = view.current;
        if (!v) return;
        COMMANDS[kind](v);
        v.focus();
      },
      insert: (text) => {
        const v = view.current;
        if (!v) return;
        const { from, to } = v.state.selection.main;
        v.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + text.length },
        });
        v.focus();
      },
      focus: () => view.current?.focus(),
    }),
    [],
  );

  return <div ref={host} className={className ? `wf-editor ${className}` : 'wf-editor'} />;
}
