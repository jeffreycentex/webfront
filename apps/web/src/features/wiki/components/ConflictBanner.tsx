import { GitMerge } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button, Modal, Textarea, formatRelativeShort, useToast } from '@/ui';
import { resolveConflict, type WikiPage } from '../data';
import { diffLines } from '../lib/diff';
import { CONFLICT_MARKERS } from '../lib/diff3';
import { DiffView } from './DiffView';

/** Combined starting text for "edit a combined version": both sides between markers. */
export function combinedDraft(mine: string, theirs: string): string {
  const out: string[] = [];
  const ops = diffLines(mine, theirs);
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    if (op.type === 'equal') {
      out.push(...op.lines);
      continue;
    }
    const del = op.type === 'delete' ? op.lines : [];
    const nextIns = op.type === 'delete' && ops[i + 1]?.type === 'insert' ? ops[++i]!.lines : [];
    const ins = op.type === 'insert' ? op.lines : nextIns;
    out.push(
      CONFLICT_MARKERS.mine,
      ...del,
      CONFLICT_MARKERS.separator,
      ...ins,
      CONFLICT_MARKERS.theirs,
    );
  }
  return out.join('\n');
}

/**
 * Shown when concurrent edits of this page overlapped. The page shows this device's text;
 * the other version is kept in `conflict` until the user picks: keep mine, take theirs, or
 * write a combined version. Nothing is discarded silently; the losing text also stays in the
 * page history.
 */
export function ConflictBanner({ page }: { page: WikiPage }) {
  const { toast } = useToast();
  const [showDiff, setShowDiff] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const conflict = page.conflict;
  const initial = useMemo(
    () => (conflict ? combinedDraft(page.body, conflict.body) : ''),
    [page.body, conflict],
  );
  const [combined, setCombined] = useState(initial);
  if (!conflict) return null;

  const resolve = async (body: string, label: string) => {
    setBusy(true);
    try {
      await resolveConflict(page, body);
      toast({
        title: label,
        tone: 'success',
        description: 'The other version stays in the page history.',
      });
      setEditing(false);
    } catch (err) {
      toast({ title: 'Could not resolve the conflict', description: String(err), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const hasMarkers = combined.includes(CONFLICT_MARKERS.separator);

  return (
    <div
      role="alert"
      className="mb-2 rounded-md border border-warn/50 bg-warn-soft px-2.5 py-1.5 text-sm text-warn-text"
    >
      <div className="flex flex-wrap items-center gap-2">
        <GitMerge aria-hidden className="size-4 shrink-0" />
        <p className="min-w-0 flex-1">
          <strong>Edit conflict.</strong> This page was changed on another device at the same time (
          {formatRelativeShort(conflict.detectedAt)} ago) and the changes overlap. You are seeing
          this device’s version; the other one is kept.
        </p>
        <div className="flex flex-wrap gap-1">
          <Button
            size="sm"
            variant="subtle"
            onClick={() => setShowDiff((v) => !v)}
            aria-expanded={showDiff}
          >
            {showDiff ? 'Hide differences' : 'Show differences'}
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void resolve(page.body, 'Kept your version')}
          >
            Keep mine
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void resolve(conflict.body, 'Took the other version')}
          >
            Take theirs
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={() => {
              setCombined(initial);
              setEditing(true);
            }}
          >
            Edit combined…
          </Button>
        </div>
      </div>
      {showDiff && (
        <DiffView
          className="mt-1.5"
          from={page.body}
          to={conflict.body}
          fromLabel="Mine (this device)"
          toLabel="Theirs (other device)"
        />
      )}
      <Modal
        open={editing}
        onClose={() => setEditing(false)}
        size="xl"
        title="Combine both versions"
        description={`Edit the text below. Sections that differ are between “${CONFLICT_MARKERS.mine}” and “${CONFLICT_MARKERS.theirs}” lines; remove the markers you no longer need.`}
        footer={
          <>
            <Button onClick={() => setEditing(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void resolve(combined, 'Saved the combined version')}
            >
              {hasMarkers ? 'Save (markers left in)' : 'Save combined version'}
            </Button>
          </>
        }
      >
        <Textarea
          aria-label="Combined text"
          data-autofocus
          value={combined}
          onChange={(e) => setCombined(e.target.value)}
          className="h-[55vh] w-full font-mono text-xs"
          spellCheck={false}
        />
      </Modal>
    </div>
  );
}
