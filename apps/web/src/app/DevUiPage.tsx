import { COLOUR_KEYS, type ColourKey } from '@webfront/shared';
import { Archive, Copy, Pencil, Plus, Settings, Trash, Star } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTheme } from '../lib/theme';
import {
  Badge,
  Button,
  Checkbox,
  ColourDot,
  ColourPicker,
  ConfirmDialog,
  DragHandle,
  Drawer,
  DropdownMenu,
  EmptyState,
  Field,
  IconButton,
  Input,
  Kbd,
  List,
  ListRow,
  Modal,
  PageHeader,
  Panel,
  Popover,
  Select,
  Shortcut,
  Skeleton,
  Spinner,
  StatusDot,
  TabPanel,
  Tabs,
  TagChip,
  TagInput,
  Textarea,
  Switch,
  Toolbar,
  ToolbarSeparator,
  Tooltip,
  useToast,
} from '../ui';

/**
 * Hidden `/dev/ui` route: every design-system component, rendered once in a light scope and once
 * in a dark scope side by side. Overlays (menus, dialogs, toasts) use the page theme; use the
 * switcher to review them in both.
 */
export function DevUiPage() {
  const { preference, setPreference } = useTheme();
  return (
    <div>
      <PageHeader
        title="Design system"
        actions={
          <Toolbar label="Page theme">
            {(['light', 'dark', 'system'] as const).map((p) => (
              <Button
                key={p}
                size="sm"
                variant={preference === p ? 'primary' : 'secondary'}
                onClick={() => setPreference(p)}
              >
                {p}
              </Button>
            ))}
          </Toolbar>
        }
      >
        <span className="text-xs text-fg-3">
          Left: light scope. Right: dark scope. Menus, dialogs and toasts follow the page theme.
        </span>
      </PageHeader>
      <div className="grid gap-3 xl:grid-cols-2">
        <Scope theme="light" />
        <Scope theme="dark" />
      </div>
    </div>
  );
}

function Scope({ theme }: { theme: 'light' | 'dark' }) {
  return (
    <div className={`${theme} rounded-lg border border-line-strong bg-bg p-3 text-fg`}>
      <p className="label-caps mb-2 text-fg-3">{theme} theme</p>
      <Gallery />
    </div>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-3">
      <h2 className="label-caps mb-1 border-b border-line pb-0.5 text-fg-3">{title}</h2>
      {children}
    </section>
  );
}

function Gallery() {
  const { toast } = useToast();
  const [tab, setTab] = useState('one');
  const [colour, setColour] = useState<ColourKey | null>('indigo');
  const [tags, setTags] = useState(['homelab', 'docs']);
  const [checked, setChecked] = useState(true);
  const [on, setOn] = useState(true);
  const [modal, setModal] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [rows, setRows] = useState([true, false, false]);

  return (
    <div>
      <Block title="Buttons">
        <div className="flex flex-wrap items-center gap-1.5">
          <Button variant="primary">Primary</Button>
          <Button>Secondary</Button>
          <Button variant="subtle">Subtle</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button disabled>Disabled</Button>
          <Button size="sm">Small</Button>
          <Button variant="primary">
            <Plus className="size-3.5" /> With icon
          </Button>
          <IconButton label="Settings" shortcut="g s" icon={<Settings />} />
          <IconButton label="Delete" variant="danger" icon={<Trash />} />
        </div>
      </Block>

      <Block title="Fields">
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Name" hint="Shown in the sidebar">
            {(p) => <Input {...p} placeholder="Homelab" />}
          </Field>
          <Field label="With error" error="Required">
            {(p) => <Input {...p} defaultValue="" />}
          </Field>
          <Field label="Select">
            {(p) => (
              <Select {...p} defaultValue="b">
                <option value="a">Alpha</option>
                <option value="b">Beta</option>
              </Select>
            )}
          </Field>
          <Field label="Disabled">{(p) => <Input {...p} disabled defaultValue="Locked" />}</Field>
          <Field label="Notes" className="sm:col-span-2">
            {(p) => <Textarea {...p} placeholder="Markdown…" />}
          </Field>
          <Checkbox
            label="Checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
          />
          <Checkbox label="Indeterminate" indeterminate checked={false} onChange={() => {}} />
          <Switch label="Switch" checked={on} onCheckedChange={setOn} />
          <Switch label="Switch off" checked={false} onCheckedChange={() => {}} />
        </div>
      </Block>

      <Block title="Tags and colours">
        <div className="flex flex-wrap items-center gap-1">
          {['homelab', 'docs', 'media', 'work', 'read later', 'recipes'].map((t) => (
            <TagChip key={t} label={t} />
          ))}
          <TagChip label="removable" onRemove={() => {}} />
          <TagChip label="clickable" onClick={() => {}} colour="pink" />
        </div>
        <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
          <TagInput
            value={tags}
            onChange={setTags}
            suggestions={['homelab', 'docs', 'media', 'work']}
          />
          <div className="flex flex-col gap-1">
            <ColourPicker value={colour} onChange={setColour} allowNone />
            <span className="flex items-center gap-1 text-xs text-fg-3">
              Selected: {colour ? <ColourDot colour={colour} /> : null} {colour ?? 'none'}
            </span>
          </div>
        </div>
      </Block>

      <Block title="Panels (all 12 colours)">
        <div className="grid gap-2 sm:grid-cols-2">
          {COLOUR_KEYS.map((c) => (
            <Panel key={c} title={c} colour={c} actions={<Badge>3</Badge>}>
              <List>
                <ListRow leading={<ColourDot colour={c} />} trailing={<TagChip label="tag" />}>
                  First bookmark
                </ListRow>
                <ListRow leading={<ColourDot colour={c} />}>Second bookmark</ListRow>
              </List>
            </Panel>
          ))}
        </div>
      </Block>

      <Block title="Status">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="inline-flex items-center gap-1">
            <StatusDot status="ok" pulse /> Up
          </span>
          <span className="inline-flex items-center gap-1">
            <StatusDot status="warn" /> Slow
          </span>
          <span className="inline-flex items-center gap-1">
            <StatusDot status="bad" /> Down
          </span>
          <span className="inline-flex items-center gap-1">
            <StatusDot status="idle" /> Unknown
          </span>
          <Badge tone="ok">synced</Badge>
          <Badge tone="warn">3 due</Badge>
          <Badge tone="bad">2 overdue</Badge>
          <Badge tone="accent">new</Badge>
          <Badge>12</Badge>
          <Spinner />
        </div>
      </Block>

      <Block title="Dense list with drag handles and row actions">
        <Panel title="Tasks" colour="teal" className="max-w-md">
          <List>
            {rows.map((done, i) => (
              <ListRow
                key={i}
                muted={done}
                revealTrailing
                leading={
                  <>
                    <DragHandle />
                    <Checkbox
                      aria-label={`Task ${i + 1}`}
                      checked={done}
                      onChange={(e) =>
                        setRows((r) => r.map((v, j) => (j === i ? e.target.checked : v)))
                      }
                    />
                  </>
                }
                trailing={
                  <>
                    <IconButton label="Edit" size="sm" icon={<Pencil />} />
                    <IconButton label="Archive" size="sm" icon={<Archive />} />
                  </>
                }
              >
                <span className={done ? 'line-through' : undefined}>Task number {i + 1}</span>
              </ListRow>
            ))}
          </List>
        </Panel>
      </Block>

      <Block title="Menus, popover, tooltip, toolbar">
        <div className="flex flex-wrap items-center gap-1.5">
          <DropdownMenu
            trigger={<Button>Menu</Button>}
            items={[
              {
                label: 'Copy',
                icon: <Copy />,
                shortcut: 'mod+c',
                onSelect: () => toast({ title: 'Copied' }),
              },
              { label: 'Edit', icon: <Pencil />, shortcut: 'e', onSelect: () => {} },
              { label: 'Pinned', checked: true, onSelect: () => {} },
              'separator',
              { label: 'Disabled', disabled: true, onSelect: () => {} },
              { label: 'Delete', icon: <Trash />, danger: true, onSelect: () => {} },
            ]}
          />
          <Popover trigger={<Button>Popover</Button>}>
            {({ close }) => (
              <div className="flex w-56 flex-col gap-2">
                <Field label="Rename">
                  {(p) => <Input {...p} autoFocus defaultValue="Homelab" />}
                </Field>
                <ColourPicker value={colour} onChange={setColour} />
                <Button variant="primary" size="sm" onClick={close}>
                  Done
                </Button>
              </div>
            )}
          </Popover>
          <Tooltip label="Add item" shortcut="n">
            <Button variant="subtle">Hover for tooltip</Button>
          </Tooltip>
          <Toolbar label="Formatting" className="rounded-md border border-line p-0.5">
            <IconButton label="Star" size="sm" icon={<Star />} />
            <ToolbarSeparator />
            <IconButton label="Copy" size="sm" icon={<Copy />} />
          </Toolbar>
          <span className="inline-flex items-center gap-1 text-xs text-fg-3">
            <Kbd>Esc</Kbd> <Shortcut spec="mod+k" /> <Shortcut spec="g b" />
          </span>
        </div>
      </Block>

      <Block title="Tabs">
        <Tabs
          value={tab}
          onValueChange={setTab}
          label="Demo"
          items={[
            { id: 'one', label: 'Overview', count: 4 },
            { id: 'two', label: 'Details' },
            { id: 'three', label: 'Disabled', disabled: true },
          ]}
        >
          <TabPanel id="one">Overview panel content.</TabPanel>
          <TabPanel id="two">Details panel content.</TabPanel>
        </Tabs>
      </Block>

      <Block title="Overlays and toasts">
        <div className="flex flex-wrap gap-1.5">
          <Button onClick={() => setModal(true)}>Modal</Button>
          <Button onClick={() => setConfirm(true)}>Confirm</Button>
          <Button onClick={() => setDrawer(true)}>Drawer</Button>
          <Button onClick={() => toast({ title: 'Saved', tone: 'success' })}>Toast</Button>
          <Button
            onClick={() =>
              toast({ title: 'Task deleted', action: { label: 'Undo', onClick: () => {} } })
            }
          >
            Toast + undo
          </Button>
          <Button
            onClick={() =>
              toast({ title: 'Sync failed', description: 'Server returned 500', tone: 'error' })
            }
          >
            Error toast
          </Button>
        </div>
        <Modal
          open={modal}
          onClose={() => setModal(false)}
          title="Edit category"
          description="Phones show this as a bottom sheet."
          footer={
            <>
              <Button onClick={() => setModal(false)}>Cancel</Button>
              <Button variant="primary" onClick={() => setModal(false)}>
                Save
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-2">
            <Field label="Name">
              {(p) => <Input {...p} data-autofocus defaultValue="Homelab" />}
            </Field>
            <ColourPicker value={colour} onChange={setColour} />
          </div>
        </Modal>
        <ConfirmDialog
          open={confirm}
          danger
          title="Delete category?"
          description="Its 12 bookmarks move to Uncategorised. You can undo this for a few seconds."
          confirmLabel="Delete"
          onCancel={() => setConfirm(false)}
          onConfirm={() => setConfirm(false)}
        />
        <Drawer open={drawer} onClose={() => setDrawer(false)} title="Details">
          Drawer content.
        </Drawer>
      </Block>

      <Block title="Loading and empty">
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5 rounded-md border border-line bg-surface p-2">
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-1/2" />
          </div>
          <div className="rounded-md border border-line bg-surface">
            <EmptyState
              title="No bookmarks yet"
              action={
                <Button size="sm" variant="primary">
                  Add bookmark
                </Button>
              }
            >
              Press <Kbd>n</Kbd> to add one.
            </EmptyState>
          </div>
        </div>
      </Block>
    </div>
  );
}
