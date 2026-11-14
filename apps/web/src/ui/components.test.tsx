// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Button,
  Checkbox,
  ColourPicker,
  ConfirmDialog,
  DropdownMenu,
  Field,
  Input,
  Modal,
  Popover,
  Switch,
  TabPanel,
  Tabs,
  TagChip,
  TagInput,
  ToastProvider,
  Tooltip,
  useToast,
} from './index';
import { computePosition } from './floating';
import type { ColourKey } from '@webfront/shared';

afterEach(cleanup);

describe('Modal', () => {
  function Demo({ onClose = () => {} }: { onClose?: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>open</button>
        <Modal
          open={open}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
          title="Edit"
          footer={<Button>Save</Button>}
        >
          <Input aria-label="Name" data-autofocus />
        </Modal>
      </>
    );
  }

  it('is a labelled modal dialog, focuses data-autofocus, traps Tab, closes on Escape and restores focus', async () => {
    const user = userEvent.setup();
    render(<Demo />);
    const trigger = screen.getByText('open');
    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Edit' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByLabelText('Name')).toHaveFocus();
    // Tab cycles within the dialog: Name -> Save -> Close -> Name
    await user.tab();
    expect(within(dialog).getByText('Save')).toHaveFocus();
    await user.tab();
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('closes on backdrop click', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Demo onClose={onClose} />);
    await user.click(screen.getByText('open'));
    const backdrop = document.querySelector('[aria-hidden="true"].bg-overlay')!;
    await user.pointer({ keys: '[MouseLeft]', target: backdrop });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('ConfirmDialog', () => {
  it('focuses cancel for destructive confirms and calls the right handlers', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        open
        danger
        title="Delete?"
        confirmLabel="Delete"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toHaveFocus();
    await user.click(screen.getByText('Delete'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('Tabs', () => {
  it('roving focus with arrows, Home and End; skips disabled tabs', async () => {
    const user = userEvent.setup();
    function Demo() {
      const [v, setV] = useState('a');
      return (
        <Tabs
          value={v}
          onValueChange={setV}
          items={[
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B', disabled: true },
            { id: 'c', label: 'C' },
          ]}
        >
          <TabPanel id="a">panel a</TabPanel>
          <TabPanel id="c">panel c</TabPanel>
        </Tabs>
      );
    }
    render(<Demo />);
    const tabA = screen.getByRole('tab', { name: 'A' });
    expect(tabA).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('panel a');
    tabA.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'C' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'C' })).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('panel c');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'A' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'C' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'A' })).toHaveFocus();
  });
});

describe('DropdownMenu', () => {
  it('opens with click, navigates with arrows, selects with Enter, closes on Escape', async () => {
    const user = userEvent.setup();
    const a = vi.fn();
    const b = vi.fn();
    render(
      <DropdownMenu
        trigger={<Button>Actions</Button>}
        items={[
          { label: 'Alpha', onSelect: a },
          'separator',
          { label: 'Beta', onSelect: b },
          { label: 'Gamma', onSelect: () => {}, disabled: true },
        ]}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Actions' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menuitem', { name: 'Alpha' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Beta' })).toHaveFocus();
    await user.keyboard('{ArrowDown}'); // wraps past the disabled item
    expect(screen.getByRole('menuitem', { name: 'Alpha' })).toHaveFocus();
    await user.keyboard('b'); // type-ahead
    expect(screen.getByRole('menuitem', { name: 'Beta' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('closes on outside click', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <DropdownMenu
          trigger={<Button>Actions</Button>}
          items={[{ label: 'One', onSelect: () => {} }]}
        />
        <p>outside</p>
      </div>,
    );
    await user.click(screen.getByText('Actions'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.click(screen.getByText('outside'));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('Popover', () => {
  it('toggles and closes on Escape', async () => {
    const user = userEvent.setup();
    render(<Popover trigger={<Button>More</Button>}>hello popover</Popover>);
    await user.click(screen.getByText('More'));
    expect(screen.getByRole('dialog')).toHaveTextContent('hello popover');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('TagInput', () => {
  function Demo({ initial = [] as string[] }) {
    const [tags, setTags] = useState(initial);
    return <TagInput value={tags} onChange={setTags} suggestions={['homelab', 'docs']} />;
  }

  it('adds on Enter and comma, ignores duplicates, removes with Backspace', async () => {
    const user = userEvent.setup();
    render(<Demo />);
    const input = screen.getByRole('combobox');
    await user.type(input, 'media{Enter}');
    await user.type(input, 'Work,');
    await user.type(input, 'MEDIA{Enter}');
    expect(screen.getByText('media')).toBeInTheDocument();
    expect(screen.getByText('Work')).toBeInTheDocument();
    expect(screen.getAllByText(/media/i)).toHaveLength(1);
    await user.keyboard('{Backspace}');
    expect(screen.queryByText('Work')).toBeNull();
  });

  it('picks suggestions with the keyboard', async () => {
    const user = userEvent.setup();
    render(<Demo />);
    const input = screen.getByRole('combobox');
    await user.type(input, 'ho');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(screen.getByText('homelab')).toBeInTheDocument();
  });

  it('removes a chip with its button', async () => {
    const user = userEvent.setup();
    render(<Demo initial={['a', 'b']} />);
    await user.click(screen.getByRole('button', { name: 'Remove tag a' }));
    expect(screen.queryByText('a')).toBeNull();
    expect(screen.getByText('b')).toBeInTheDocument();
  });
});

describe('ColourPicker', () => {
  it('is a radiogroup with roving arrow-key selection', async () => {
    const user = userEvent.setup();
    function Demo() {
      const [c, setC] = useState<ColourKey | null>('red');
      return <ColourPicker value={c} onChange={setC} allowNone />;
    }
    render(<Demo />);
    expect(screen.getAllByRole('radio')).toHaveLength(13);
    const red = screen.getByRole('radio', { name: 'red' });
    expect(red).toHaveAttribute('aria-checked', 'true');
    red.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'orange' })).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(screen.getByRole('radio', { name: 'No colour' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await user.click(screen.getByRole('radio', { name: 'pink' }));
    expect(screen.getByRole('radio', { name: 'pink' })).toHaveAttribute('aria-checked', 'true');
  });
});

describe('Switch and Checkbox', () => {
  it('Switch toggles with Space and exposes role=switch', async () => {
    const user = userEvent.setup();
    function Demo() {
      const [on, setOn] = useState(false);
      return <Switch checked={on} onCheckedChange={setOn} label="Dark" />;
    }
    render(<Demo />);
    const sw = screen.getByRole('switch', { name: 'Dark' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    sw.focus();
    await user.keyboard(' ');
    expect(sw).toHaveAttribute('aria-checked', 'true');
  });

  it('Checkbox has an accessible name and toggles', async () => {
    const user = userEvent.setup();
    render(<Checkbox label="Done" />);
    const cb = screen.getByRole('checkbox', { name: 'Done' });
    await user.click(cb);
    expect(cb).toBeChecked();
  });
});

describe('Field', () => {
  it('wires label, hint and error to the control', () => {
    render(
      <Field label="Name" error="Required">
        {(p) => <Input {...p} />}
      </Field>,
    );
    const input = screen.getByLabelText('Name');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Required');
  });
});

describe('Tooltip', () => {
  it('shows on keyboard focus and describes the trigger', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip label="Add item" shortcut="n">
        <Button>Add</Button>
      </Tooltip>,
    );
    await user.tab();
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('Add item');
    expect(screen.getByRole('button', { name: 'Add' })).toHaveAccessibleDescription(/Add item/);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('Toasts', () => {
  it('shows a toast with an action and dismisses it', async () => {
    const user = userEvent.setup();
    const undo = vi.fn();
    function Demo() {
      const { toast } = useToast();
      return (
        <button
          onClick={() => toast({ title: 'Deleted', action: { label: 'Undo', onClick: undo } })}
        >
          go
        </button>
      );
    }
    render(
      <ToastProvider>
        <Demo />
      </ToastProvider>,
    );
    await user.click(screen.getByText('go'));
    expect(screen.getByRole('status')).toHaveTextContent('Deleted');
    await user.click(screen.getByText('Undo'));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Deleted')).toBeNull();
  });
});

describe('TagChip', () => {
  it('gives the same label the same colour every time', () => {
    const { container, rerender } = render(<TagChip label="homelab" />);
    const first = (container.firstChild as HTMLElement).getAttribute('style');
    rerender(<TagChip label="homelab" />);
    expect((container.firstChild as HTMLElement).getAttribute('style')).toBe(first);
    expect(first).toMatch(/--wf-/);
  });
});

describe('computePosition', () => {
  const vp = { width: 800, height: 600 };
  const anchor = (x: number, y: number, w = 80, h = 24) =>
    ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h }) as DOMRect;

  it('places below, aligned to the start', () => {
    const p = computePosition(anchor(100, 100), { width: 150, height: 100 }, vp, 'bottom-start');
    expect(p).toMatchObject({ side: 'bottom', top: 128, left: 100 });
  });

  it('flips above when there is no room below', () => {
    const p = computePosition(anchor(100, 560), { width: 150, height: 120 }, vp, 'bottom-start');
    expect(p.side).toBe('top');
    expect(p.top).toBe(560 - 4 - 120);
  });

  it('clamps horizontally inside the viewport', () => {
    const p = computePosition(anchor(760, 100), { width: 200, height: 50 }, vp, 'bottom-start');
    expect(p.left).toBe(800 - 200 - 6);
  });

  it('aligns to the end', () => {
    const p = computePosition(anchor(400, 100, 80), { width: 150, height: 50 }, vp, 'bottom-end');
    expect(p.left).toBe(480 - 150);
  });
});
