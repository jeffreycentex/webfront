import { colourForLabel } from '@webfront/shared';
import {
  Ellipsis,
  Keyboard,
  Lock,
  LogOut,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  Sun,
  TriangleAlert,
  User,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useNavigation } from 'react-router';
import { useAuth } from '../auth';
import { syncNow, useSyncStatus } from '../data';
import { useFeatures } from '../features/context';
import type { Command, NavEntry } from '../features/types';
import { cx } from '../lib/cx';
import { useIsPhone } from '../lib/online';
import { safeStorage } from '../lib/platform';
import { ShellContext, type ShellActions } from '../lib/shell';
import { useTheme, type ThemePreference } from '../lib/theme';
import {
  DropdownMenu,
  IconButton,
  Logo,
  Shortcut,
  Tooltip,
  colourStyle,
  useHotkeys,
  type MenuItem,
} from '../ui';
import { CommandPalette } from './CommandPalette';
import { ShortcutsDialog } from './ShortcutsDialog';
import { OnlineIndicator, SyncIndicator } from './SyncIndicator';
import { UpdatePrompt } from './UpdatePrompt';

const SIDEBAR_KEY = 'wf.sidebar';

/** App chrome: slim sidebar (desktop) or bottom tab bar (phone), header, palette, cheat sheet. */
export function Layout() {
  const { nav } = useFeatures();
  const navigate = useNavigate();
  const location = useLocation();
  const navigation = useNavigation();
  const auth = useAuth();
  const phone = useIsPhone();
  const theme = useTheme();

  const [collapsed, setCollapsed] = useState(() => safeStorage.get(SIDEBAR_KEY) === 'collapsed');
  const [palette, setPalette] = useState<{ open: boolean; query: string }>({
    open: false,
    query: '',
  });
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // Settings changes the stored default in this tab and announces it with a `storage` event.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === SIDEBAR_KEY) setCollapsed(safeStorage.get(SIDEBAR_KEY) === 'collapsed');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const toggleSidebar = () => {
    setCollapsed((c) => {
      safeStorage.set(SIDEBAR_KEY, c ? 'expanded' : 'collapsed');
      return !c;
    });
  };

  const actions = useMemo<ShellActions>(
    () => ({
      openPalette: (query = '') => setPalette({ open: true, query }),
      openShortcuts: () => setShortcutsOpen(true),
    }),
    [],
  );

  // Global shortcuts: palette, cheat sheet, and every feature's nav shortcut ('g b' ...).
  const navShortcuts = useMemo(
    () =>
      Object.fromEntries(
        nav.flatMap((n) =>
          n.shortcut ? [[n.shortcut, () => void navigate(n.path)] as const] : [],
        ),
      ),
    [nav, navigate],
  );
  useHotkeys({
    'mod+k': () => setPalette((p) => ({ open: !p.open, query: '' })),
    '?': () => setShortcutsOpen(true),
    ...navShortcuts,
  });

  // Document title follows the current nav entry.
  const current = useMemo(() => currentNav(nav, location.pathname), [nav, location.pathname]);
  useEffect(() => {
    document.title = current && current.path !== '/' ? `${current.label} · Webfront` : 'Webfront';
  }, [current]);

  const shellCommands = useMemo<Command[]>(
    () => [
      {
        id: 'shell.sync',
        title: 'Sync now',
        keywords: ['refresh', 'push', 'pull'],
        run: () => void syncNow(),
      },
      {
        id: 'shell.shortcuts',
        title: 'Show keyboard shortcuts',
        shortcut: '?',
        keywords: ['help', 'keys', 'cheat sheet'],
        run: () => setShortcutsOpen(true),
      },
      ...theme.themes.map((t) => ({
        id: `shell.theme.${t.id}`,
        title: `Theme: ${t.name}`,
        keywords: ['appearance', 'colour', t.mode === 'dark' ? 'night' : 'day', 'catppuccin'],
        run: () => theme.setPreference(t.id as ThemePreference),
      })),
      {
        id: 'shell.theme.system',
        title: 'Theme: Match system',
        keywords: ['appearance', 'auto'],
        run: () => theme.setPreference('system'),
      },
      {
        id: 'shell.lock',
        title: 'Lock screen',
        keywords: ['secure', 'idle'],
        run: () => auth.lock(),
      },
      {
        id: 'shell.signout',
        title: 'Sign out',
        keywords: ['logout', 'clear'],
        run: () => void auth.logout(),
      },
    ],
    [theme, auth],
  );

  const loading = navigation.state === 'loading';

  return (
    <ShellContext.Provider value={actions}>
      <a
        href="#main"
        className="sr-only z-[90] rounded-md bg-accent px-3 py-1.5 text-accent-fg focus:not-sr-only focus:fixed focus:left-2 focus:top-2"
      >
        Skip to content
      </a>
      <div className="flex h-dvh overflow-hidden bg-bg">
        {!phone && <Sidebar nav={nav} collapsed={collapsed} onToggle={toggleSidebar} />}
        <div className="flex min-w-0 flex-1 flex-col">
          <Header
            phone={phone}
            onSearch={() => setPalette({ open: true, query: '' })}
            onShortcuts={() => setShortcutsOpen(true)}
            title={current?.label}
          />
          {loading && (
            <div aria-hidden className="relative h-0.5 overflow-hidden bg-accent-soft">
              <div className="absolute inset-y-0 w-1/3 animate-[wf-progress_1s_ease-in-out_infinite] bg-accent" />
            </div>
          )}
          <RejectedBanner />
          {auth.status === 'offline' && (
            <p className="border-b border-warn/30 bg-warn-soft px-3 py-0.5 text-xs text-warn-text">
              Working offline from this device. Changes sync when the server is back.
            </p>
          )}
          <main
            id="main"
            tabIndex={-1}
            className="scroll-thin min-h-0 flex-1 overflow-auto px-3 py-2.5 outline-none max-sm:px-2.5"
          >
            <Outlet />
          </main>
          {phone && <TabBar nav={nav} />}
        </div>
      </div>
      <CommandPalette
        open={palette.open}
        initialQuery={palette.query}
        extraCommands={shellCommands}
        onClose={() => setPalette({ open: false, query: '' })}
      />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <UpdatePrompt />
    </ShellContext.Provider>
  );
}

/** The nav entry whose path is the longest prefix of the pathname. */
export function currentNav(nav: readonly NavEntry[], pathname: string): NavEntry | undefined {
  let best: NavEntry | undefined;
  for (const n of nav) {
    const match =
      n.path === '/' ? pathname === '/' : pathname === n.path || pathname.startsWith(`${n.path}/`);
    if (match && (!best || n.path.length > best.path.length)) best = n;
  }
  return best;
}

function Sidebar({
  nav,
  collapsed,
  onToggle,
}: {
  nav: NavEntry[];
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <aside
      className={cx(
        'flex shrink-0 flex-col border-r border-line bg-surface transition-[width] duration-150',
        collapsed ? 'w-[44px]' : 'w-[176px]',
      )}
    >
      <div className="flex h-(--header-h) items-center gap-2 border-b border-line px-2.5">
        <Logo size={22} />
        {!collapsed && <span className="text-base font-semibold tracking-tight">Webfront</span>}
      </div>
      <nav
        aria-label="Main"
        className="scroll-thin flex min-h-0 flex-1 flex-col gap-px overflow-y-auto p-1"
      >
        {nav.map((n) => (
          <NavItem key={n.path} entry={n} collapsed={collapsed} />
        ))}
      </nav>
      <div className="border-t border-line p-1">
        <Tooltip label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} placement="right">
          <button
            type="button"
            onClick={onToggle}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            className="flex h-6 w-full items-center gap-2 rounded-md px-2 text-xs text-fg-3 hover:bg-surface-2 hover:text-fg"
          >
            {collapsed ? (
              <PanelLeftOpen aria-hidden className="size-4" />
            ) : (
              <PanelLeftClose aria-hidden className="size-4" />
            )}
            {!collapsed && <span>Collapse</span>}
          </button>
        </Tooltip>
      </div>
    </aside>
  );
}

function NavItem({ entry, collapsed }: { entry: NavEntry; collapsed: boolean }) {
  const { path, label, icon: Icon, shortcut } = entry;
  const badge = useNavBadge(entry);
  const link = (
    <NavLink
      to={path}
      end={path === '/'}
      aria-label={collapsed ? label : undefined}
      style={colourStyle(colourForLabel(label))}
      className={({ isActive }) =>
        cx(
          'group relative flex h-[26px] items-center gap-2 rounded-md px-2 text-sm font-medium no-underline transition-colors',
          isActive ? 'bg-[var(--c-soft)] text-fg' : 'text-fg-2 hover:bg-surface-2 hover:text-fg',
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span
              aria-hidden
              className="absolute inset-y-1 -left-1 w-[3px] rounded-r-full bg-[var(--c)]"
            />
          )}
          <Icon
            className={cx(
              'size-4 shrink-0',
              isActive ? 'text-[color:var(--c)]' : 'text-fg-3 group-hover:text-[color:var(--c)]',
            )}
          />
          {!collapsed && <span className="flex-1 truncate">{label}</span>}
          {badge > 0 && (
            <span
              aria-label={`${badge} due`}
              className={cx(
                'inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-bad px-1 text-2xs font-semibold leading-none text-white tabular-nums dark:text-accent-fg',
                collapsed && 'absolute right-0.5 top-0 h-3 min-w-3 px-0.5 text-[9px]',
              )}
            >
              {badge > 99 ? '99+' : badge}
            </span>
          )}
          {!collapsed && shortcut && (
            <span
              aria-hidden
              className="hidden opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 lg:inline-flex"
            >
              <Shortcut spec={shortcut} />
            </span>
          )}
        </>
      )}
    </NavLink>
  );
  return collapsed ? (
    <Tooltip label={label} shortcut={shortcut} placement="right" delay={150}>
      {link}
    </Tooltip>
  ) : (
    link
  );
}

function Header({
  phone,
  onSearch,
  onShortcuts,
  title,
}: {
  phone: boolean;
  onSearch: () => void;
  onShortcuts: () => void;
  title: string | undefined;
}) {
  return (
    <header className="flex h-(--header-h) shrink-0 items-center gap-2 border-b border-line bg-surface px-2.5 pt-safe">
      {phone ? (
        <>
          <Logo size={22} />
          <span className="min-w-0 flex-1 truncate text-base font-semibold tracking-tight">
            {title ?? 'Webfront'}
          </span>
        </>
      ) : (
        <button
          type="button"
          onClick={onSearch}
          aria-label="Open command palette"
          aria-keyshortcuts="Control+K Meta+K"
          className="group flex h-[26px] w-72 max-w-[40%] items-center gap-2 rounded-md border border-line bg-bg px-2 text-left text-xs text-fg-3 transition-colors hover:border-line-strong hover:text-fg-2"
        >
          <Search aria-hidden className="size-3.5" />
          <span className="flex-1 truncate">Search or run a command…</span>
          <Shortcut spec="mod+k" />
        </button>
      )}
      <div className={cx('flex items-center gap-1', !phone && 'ml-auto')}>
        {phone && <IconButton label="Search" icon={<Search />} onClick={onSearch} />}
        <OnlineIndicator />
        <SyncIndicator />
        <ThemeMenu />
        <UserMenu onShortcuts={onShortcuts} />
      </div>
    </header>
  );
}

function ThemeMenu() {
  const { preference, resolved, themes, setPreference } = useTheme();
  const item = (value: ThemePreference, label: string, icon: ReactNode): MenuItem => ({
    label,
    icon,
    checked: preference === value,
    onSelect: () => setPreference(value),
  });
  const label =
    preference === 'system'
      ? 'System'
      : (themes.find((t) => t.id === preference)?.name ?? preference);
  return (
    <DropdownMenu
      label="Theme"
      placement="bottom-end"
      trigger={
        <IconButton
          label={`Theme: ${label}`}
          icon={preference === 'system' ? <Monitor /> : resolved === 'dark' ? <Moon /> : <Sun />}
        />
      }
      items={[
        ...themes.map((t) =>
          item(t.id as ThemePreference, t.name, t.mode === 'dark' ? <Moon /> : <Sun />),
        ),
        'separator',
        item('system', 'System', <Monitor />),
      ]}
    />
  );
}

function UserMenu({ onShortcuts }: { onShortcuts: () => void }) {
  const auth = useAuth();
  const items: MenuItem[] = [
    {
      label: auth.session?.username ?? 'Signed in',
      onSelect: () => {},
      icon: <User />,
      disabled: true,
    },
    'separator',
    { label: 'Sync now', icon: <RefreshCw />, onSelect: () => void syncNow() },
    { label: 'Lock', icon: <Lock />, onSelect: () => auth.lock() },
    { label: 'Keyboard shortcuts', icon: <Keyboard />, shortcut: '?', onSelect: onShortcuts },
    'separator',
    { label: 'Sign out', icon: <LogOut />, danger: true, onSelect: () => void auth.logout() },
  ];
  return (
    <DropdownMenu
      label="Account"
      placement="bottom-end"
      trigger={<IconButton label="Account" icon={<User />} />}
      items={items}
    />
  );
}

const TAB_LIMIT = 5;

/** Phone tab bar order: `phoneOrder` first (Home, Shopping, Tasks, Bookmarks), then desktop order. */
export function phoneNav(nav: readonly NavEntry[]): NavEntry[] {
  const key = (n: NavEntry) => n.phoneOrder ?? 1000 + n.order;
  return [...nav].sort((a, b) => key(a) - key(b));
}

/** Live badge count for a nav entry (0 when it has none). The hook identity is stable per entry. */
function useNavBadge(entry: NavEntry): number {
  const n = entry.useBadge?.();
  return n && n > 0 ? n : 0;
}

function TabLink({ entry }: { entry: NavEntry }) {
  const n = entry;
  const badge = useNavBadge(n);
  return (
    <NavLink
      to={n.path}
      end={n.path === '/'}
      style={colourStyle(colourForLabel(n.label))}
      className={({ isActive }) =>
        cx(
          'flex h-[56px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-2xs font-medium no-underline',
          isActive ? 'text-fg' : 'text-fg-3',
        )
      }
    >
      {({ isActive }) => (
        <>
          <span
            className={cx(
              'relative flex h-6 w-10 items-center justify-center rounded-full transition-colors',
              isActive && 'bg-[var(--c-soft)]',
            )}
          >
            <n.icon className={cx('size-[18px]', isActive && 'text-[color:var(--c)]')} />
            {badge > 0 && (
              <span
                aria-label={`${badge} due`}
                className="absolute right-0.5 top-[-2px] inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-bad px-1 text-2xs font-semibold leading-none text-white tabular-nums dark:text-accent-fg"
              >
                {badge > 99 ? '99+' : badge}
              </span>
            )}
          </span>
          <span className="max-w-full truncate px-0.5">{n.label}</span>
        </>
      )}
    </NavLink>
  );
}

function TabBar({ nav: desktopNav }: { nav: NavEntry[] }) {
  const location = useLocation();
  const nav = useMemo(() => phoneNav(desktopNav), [desktopNav]);
  const overflow = nav.length > TAB_LIMIT;
  const primary = overflow ? nav.slice(0, TAB_LIMIT - 1) : nav;
  const rest = overflow ? nav.slice(TAB_LIMIT - 1) : [];
  const navigate = useNavigate();
  const restActive = rest.some((n) => currentNav([n], location.pathname));
  return (
    <nav aria-label="Main" className="flex shrink-0 border-t border-line bg-surface pb-safe">
      {primary.map((n) => (
        <TabLink key={n.path} entry={n} />
      ))}
      {overflow && (
        <DropdownMenu
          label="More"
          placement="top-end"
          trigger={
            <button
              type="button"
              aria-label="More"
              className={cx(
                'flex h-[56px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-2xs font-medium',
                restActive ? 'text-fg' : 'text-fg-3',
              )}
            >
              <span
                className={cx(
                  'flex h-6 w-10 items-center justify-center rounded-full',
                  restActive && 'bg-accent-soft',
                )}
              >
                <Ellipsis aria-hidden className="size-[18px]" />
              </span>
              More
            </button>
          }
          items={rest.map((n) => ({
            label: n.label,
            icon: <n.icon />,
            checked: currentNav([n], location.pathname) ? true : undefined,
            onSelect: () => void navigate(n.path),
          }))}
        />
      )}
    </nav>
  );
}

/**
 * Persistent warning when the server rejected local changes (they will never sync). Dismissible
 * for this session only: it returns on the next load while the rejected changes remain.
 */
export function RejectedBanner() {
  const { rejectedChanges } = useSyncStatus();
  const [dismissed, setDismissed] = useState(() => safeSession.get(REJECTED_DISMISSED_KEY) === '1');
  if (!rejectedChanges || rejectedChanges <= 0 || dismissed) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-2 border-b border-bad/30 bg-bad-soft px-3 py-1 text-xs text-bad-text"
    >
      <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
      <p className="min-w-0 flex-1">
        The server rejected {rejectedChanges} change{rejectedChanges === 1 ? '' : 's'} made on this
        device, so {rejectedChanges === 1 ? 'it' : 'they'} will not sync. The most likely causes are
        that this device&apos;s clock is wrong or that the app is out of date (reload to update).{' '}
        <Link to="/settings#data" className="font-medium underline">
          See sync details in Settings
        </Link>
        .
      </p>
      <button
        type="button"
        aria-label="Dismiss for this session"
        className="shrink-0 rounded-sm p-0.5 hover:bg-bad/10"
        onClick={() => {
          safeSession.set(REJECTED_DISMISSED_KEY, '1');
          setDismissed(true);
        }}
      >
        <X aria-hidden className="size-3.5" />
      </button>
    </div>
  );
}

const REJECTED_DISMISSED_KEY = 'wf.rejected.dismissed';
const safeSession = {
  get(key: string): string | null {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  },
};
