import { useFeatures } from '../features/context';
import { Modal, Shortcut } from '../ui';

const GENERAL: Array<{ title: string; shortcut: string }> = [
  { title: 'Command palette / search', shortcut: 'mod+k' },
  { title: 'Show this cheat sheet', shortcut: '?' },
  { title: 'Close dialog, menu or palette', shortcut: 'escape' },
];

function Section({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ title: string; shortcut: string }>;
}) {
  if (rows.length === 0) return null;
  return (
    <section>
      <h3 className="label-caps mb-1 border-b border-line pb-0.5 text-fg-3">{title}</h3>
      <ul>
        {rows.map((r) => (
          <li
            key={r.title + r.shortcut}
            className="flex min-h-6 items-center justify-between gap-3 text-sm"
          >
            <span className="truncate">{r.title}</span>
            <Shortcut spec={r.shortcut} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** `?` cheat sheet built from the nav shortcuts and every registered command shortcut. */
export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { nav, commands } = useFeatures();
  const navRows = nav.flatMap((n) =>
    n.shortcut ? [{ title: `Go to ${n.label}`, shortcut: n.shortcut }] : [],
  );
  const commandRows = commands.flatMap((c) =>
    c.shortcut ? [{ title: c.title, shortcut: c.shortcut }] : [],
  );
  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts" size="lg">
      <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
        <Section title="General" rows={GENERAL} />
        <Section title="Navigation" rows={navRows} />
        <Section title="Commands" rows={commandRows} />
      </div>
      <p className="mt-3 text-xs text-fg-3">
        Sequences like <Shortcut spec="g b" className="align-middle" /> are typed one key after the
        other. Shortcuts are off while you type in a field.
      </p>
    </Modal>
  );
}
