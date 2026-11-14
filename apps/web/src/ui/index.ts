/**
 * `@/ui` — the Webfront design system. Compact (13px base, 24-26px rows; 40-44px on phones),
 * themed through CSS variables (src/styles/index.css), keyboard accessible.
 * Gallery of everything in both themes: /dev/ui.
 */
export { colourStyle, colourVar } from './colour';
export { cx } from '../lib/cx';

export {
  Button,
  IconButton,
  buttonClasses,
  type ButtonProps,
  type IconButtonProps,
} from './Button';
export {
  Checkbox,
  Field,
  Input,
  Select,
  Switch,
  Textarea,
  type CheckboxProps,
  type FieldProps,
  type InputProps,
  type SelectProps,
  type SwitchProps,
  type TextareaProps,
} from './Field';
export { Panel, type PanelProps } from './Panel';
export {
  Badge,
  ColourDot,
  ColourPicker,
  StatusDot,
  TagChip,
  TagInput,
  normaliseTag,
  type ColourPickerProps,
  type Status,
  type TagChipProps,
  type TagInputProps,
} from './Chips';
export {
  DragHandle,
  EmptyState,
  List,
  ListRow,
  PageHeader,
  PlaceholderPage,
  Skeleton,
  Spinner,
  Toolbar,
  ToolbarSeparator,
  VisuallyHidden,
  type DragHandleProps,
  type ListRowProps,
} from './Misc';
export { Kbd, Shortcut } from './Kbd';
export { Logo } from './Logo';
export { Tooltip, type TooltipProps } from './Tooltip';
export {
  ConfirmDialog,
  Drawer,
  Modal,
  Sheet,
  type ConfirmDialogProps,
  type DrawerProps,
  type ModalProps,
} from './Overlays';
export {
  DropdownMenu,
  Popover,
  type DropdownMenuProps,
  type MenuItem,
  type PopoverProps,
} from './Menus';
export { TabPanel, Tabs, type TabItem, type TabsProps } from './Tabs';
export { ToastProvider, useToast, type ToastApi, type ToastOptions, type ToastTone } from './Toast';
export {
  formatShortcut,
  isEditableTarget,
  shortcutText,
  useHotkeys,
  type HotkeyHandler,
  type HotkeyOptions,
} from './hotkeys';
export { Portal, useDismiss, useFloating, useFocusTrap, type Placement } from './floating';
export { useIsPhone, useMediaQuery, useOnline } from '../lib/online';
export { useShellActions, type ShellActions } from '../lib/shell';
export { useTheme, type ThemePreference, type ResolvedTheme } from '../lib/theme';
export { formatRelativeShort } from '../lib/time';
