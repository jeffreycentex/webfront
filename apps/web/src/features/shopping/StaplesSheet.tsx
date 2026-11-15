import { Pencil, Plus, Star, X } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { colourForLabel } from '@webfront/shared';
import {
  Badge,
  Button,
  colourStyle,
  cx,
  Drawer,
  EmptyState,
  Input,
  Select,
  useIsPhone,
  useToast,
} from '@/ui';
import { useStaples } from './hooks';
import { groupStaples, planAddStaples, stapleState, type Staple, type StapleState } from './logic';
import { addStaples, setStaple, updateStaple, type ShoppingList } from './store';

const STATE_LABEL: Record<StapleState, string> = {
  missing: 'Not on the list',
  'on-list': 'On the list',
  'in-trolley': 'In the trolley',
};

/** "Staples" button for a list header, with a badge counting staples that are not on the list. */
export function StaplesButton({
  missing,
  onClick,
  className,
}: {
  missing: number;
  onClick: () => void;
  className?: string;
}) {
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={onClick}
      className={cx('max-sm:h-[44px]', className)}
    >
      <Star aria-hidden className="size-3.5" />
      Staples
      {missing > 0 && (
        <Badge tone="accent" className="max-sm:h-5">
          <span aria-label={`${missing} not on the list`}>{missing}</span>
        </Badge>
      )}
    </Button>
  );
}

export interface StaplesSheetProps {
  list: ShoppingList | null;
  open: boolean;
  onClose: () => void;
}

/** Compact sheet (bottom on phones): every staple of the list, its state, one-tap add. */
export function StaplesSheet({ list, open, onClose }: StaplesSheetProps) {
  const phone = useIsPhone();
  return (
    <Drawer
      open={open && list !== null}
      onClose={onClose}
      title="Staples"
      description={list ? `Regular items for ${list.name}` : undefined}
      side={phone ? 'bottom' : 'right'}
    >
      {list && <StaplesBody list={list} />}
    </Drawer>
  );
}

function StaplesBody({ list }: { list: ShoppingList }) {
  const { staples, live, loading } = useStaples(list.id);
  const { toast } = useToast();
  const [editKey, setEditKey] = useState<string | null>(null);
  const groups = useMemo(() => groupStaples(staples, list.sections), [staples, list.sections]);
  const pending = planAddStaples(staples, live).length;

  const add = async (items: readonly Staple[]) => {
    try {
      await addStaples(list.id, items);
    } catch {
      toast({ title: 'Could not add staples', tone: 'error', description: 'Nothing was saved.' });
    }
  };

  if (loading) return <p className="text-sm text-fg-3">Loading</p>;
  if (staples.length === 0) {
    return (
      <EmptyState title="No staples yet" icon={<Star />}>
        Star an item on the list, or a suggestion while typing, to keep it here for next time.
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="primary"
        disabled={pending === 0}
        onClick={() => void add(staples)}
        className="max-sm:h-[44px]"
      >
        <Plus aria-hidden className="size-3.5" />
        {pending ? `Add all missing (${pending})` : 'Nothing missing'}
      </Button>
      {groups.map((g) => (
        <section
          key={g.section}
          aria-label={g.section}
          style={colourStyle(colourForLabel(g.section))}
        >
          <h3 className="label-caps flex items-center gap-1.5 border-y border-line bg-[var(--c-soft)] px-2 py-0.5 text-[color:var(--c)]">
            <span aria-hidden className="size-2 rounded-full bg-[var(--c)]" />
            {g.section}
          </h3>
          <ul className="divide-y divide-line">
            {g.items.map((s) => {
              const state = stapleState(s, live);
              return (
                <li key={s.key}>
                  {editKey === s.key ? (
                    <StapleEditor
                      staple={s}
                      sections={list.sections}
                      onDone={() => setEditKey(null)}
                    />
                  ) : (
                    <div className="flex min-h-(--row-h) items-center gap-1.5 py-0.5 max-sm:min-h-[44px]">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm max-sm:text-base">
                          {s.name}
                          {s.quantity && (
                            <span className="ml-1.5 rounded-full bg-[var(--c-soft)] px-1.5 text-xs font-medium tabular-nums text-[color:var(--c)]">
                              {s.quantity}
                            </span>
                          )}
                        </span>
                        <span
                          className={cx(
                            'block text-xs',
                            state === 'missing' ? 'text-fg-3' : 'text-ok-text',
                          )}
                        >
                          {STATE_LABEL[state]}
                        </span>
                      </span>
                      <Button
                        size="sm"
                        variant={state === 'on-list' ? 'ghost' : 'secondary'}
                        disabled={state === 'on-list'}
                        aria-label={`Add ${s.name}`}
                        onClick={() => void add([s])}
                        className="max-sm:h-[44px] max-sm:min-w-[44px]"
                      >
                        {state === 'in-trolley' ? 'Add again' : 'Add'}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Edit ${s.name}`}
                        onClick={() => setEditKey(s.key)}
                        className="!px-0 w-[28px] max-sm:h-[44px] max-sm:w-[44px]"
                      >
                        <Pencil aria-hidden className="size-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Remove ${s.name} from staples`}
                        onClick={() =>
                          void setStaple({ id: s.recordId, listId: list.id, name: s.name }, false)
                        }
                        className="!px-0 w-[28px] max-sm:h-[44px] max-sm:w-[44px]"
                      >
                        <X aria-hidden className="size-4" />
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

function StapleEditor({
  staple,
  sections,
  onDone,
}: {
  staple: Staple;
  sections: readonly string[];
  onDone: () => void;
}) {
  const [quantity, setQuantity] = useState(staple.quantity ?? '');
  const [section, setSection] = useState(staple.section ?? '');
  const options =
    staple.section && !sections.includes(staple.section) ? [...sections, staple.section] : sections;
  const save = (e: FormEvent) => {
    e.preventDefault();
    void updateStaple(staple, {
      quantity: quantity.trim() || null,
      section: section || null,
      note: staple.note,
    });
    onDone();
  };
  return (
    <form onSubmit={save} className="flex flex-col gap-1.5 py-1.5">
      <span className="text-sm font-medium">{staple.name}</span>
      <div className="grid grid-cols-2 gap-1.5">
        <Input
          aria-label={`Usual quantity for ${staple.name}`}
          value={quantity}
          placeholder="Quantity"
          onChange={(e) => setQuantity(e.target.value)}
          className="max-sm:h-[44px]"
        />
        <Select
          aria-label={`Section for ${staple.name}`}
          value={section}
          onChange={(e) => setSection(e.target.value)}
          className="max-sm:h-[44px]"
        >
          <option value="">No section</option>
          {options.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex justify-end gap-1.5">
        <Button size="sm" onClick={onDone} className="max-sm:h-[44px]">
          Cancel
        </Button>
        <Button size="sm" type="submit" variant="primary" className="max-sm:h-[44px]">
          Save
        </Button>
      </div>
    </form>
  );
}
