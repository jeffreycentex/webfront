import { COLOUR_KEYS } from '@webfront/shared';
import { Fingerprint, WifiOff } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ApiRequestError, NetworkError } from '../lib/api';
import { Button, Field, Input, Logo, Spinner } from '../ui';
import { useAuth } from './context';
import { passkeysSupported } from './deps';

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof NetworkError)
    return "Can't reach the server. Check your connection and try again.";
  if (err instanceof ApiRequestError) {
    if (err.status === 429 || err.code === 'rate_limited') {
      return 'Too many attempts. Wait a minute, then try again.';
    }
    if (err.status === 401) return 'Wrong username or password.';
    if (err.code === 'validation_error') return 'Check the form: some values are not valid.';
    if (err.status >= 500) return 'The server had a problem. Try again in a moment.';
    return err.message || fallback;
  }
  return err instanceof Error && err.message ? err.message : fallback;
}

function Shell({
  title,
  subtitle,
  children,
  notice,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  notice?: ReactNode;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-bg p-4">
      <div className="w-full max-w-[360px]">
        <div className="mb-3 flex items-center gap-2.5">
          <Logo size={34} />
          <div>
            <p className="label-caps text-fg-3">Webfront</p>
            <h1 className="text-xl font-semibold leading-tight tracking-tight">{title}</h1>
          </div>
        </div>
        {/* Colour strip: the palette as a signature. */}
        <div aria-hidden className="mb-3 flex h-[3px] overflow-hidden rounded-full">
          {COLOUR_KEYS.map((k) => (
            <span key={k} className="flex-1" style={{ background: `var(--wf-${k})` }} />
          ))}
        </div>
        {subtitle && <p className="mb-3 text-sm text-fg-2">{subtitle}</p>}
        {notice}
        <div className="rounded-lg border border-line bg-surface p-3.5 shadow-sm">{children}</div>
      </div>
    </main>
  );
}

function Notice({ tone, children }: { tone: 'warn' | 'bad'; children: ReactNode }) {
  return (
    <p
      role="alert"
      className={`mb-2 flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs ${tone === 'warn' ? 'border-warn/40 bg-warn-soft text-warn-text' : 'border-bad/40 bg-bad-soft text-bad-text'}`}
    >
      {children}
    </p>
  );
}

export function LoadingScreen() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-bg text-fg-3">
      <div className="flex items-center gap-2 text-sm">
        <Logo size={22} />
        <Spinner label="Loading Webfront" />
      </div>
    </main>
  );
}

function ServerNotice() {
  const { serverReachable } = useAuth();
  if (serverReachable) return null;
  return (
    <Notice tone="warn">
      <WifiOff aria-hidden className="mt-px size-3.5 shrink-0" />
      <span>
        The server is unreachable. Sign-in needs a connection the first time on this device; this
        page retries automatically.
      </span>
    </Notice>
  );
}

export function SetupScreen() {
  const { setup, serverReachable } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mismatch = confirm.length > 0 && confirm !== password;
  const tooShort = password.length > 0 && password.length < 10;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 10) return setError('Use at least 10 characters for the password.');
    if (password !== confirm) return setError('The passwords do not match.');
    setBusy(true);
    setError(null);
    try {
      await setup({ username: username.trim(), password });
    } catch (err) {
      setError(errorMessage(err, 'Could not create the account.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell
      title="Create your account"
      subtitle="First run. This single account protects your data; you will not see this screen again."
      notice={serverReachable ? null : <ServerNotice />}
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-2.5" noValidate>
        <Field label="Username">
          {(p) => (
            <Input
              {...p}
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              data-autofocus
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          )}
        </Field>
        <Field
          label="Password"
          hint="At least 10 characters. A passphrase works well."
          error={tooShort ? 'Too short' : undefined}
        >
          {(p) => (
            <Input
              {...p}
              type="password"
              name="new-password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        <Field label="Confirm password" error={mismatch ? 'Does not match' : undefined}>
          {(p) => (
            <Input
              {...p}
              type="password"
              name="confirm-password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          )}
        </Field>
        {error && <Notice tone="bad">{error}</Notice>}
        <Button type="submit" variant="primary" disabled={busy || !username.trim() || !password}>
          {busy && <Spinner label="Creating account" />}
          Create account
        </Button>
      </form>
    </Shell>
  );
}

export function LoginScreen() {
  const { login, loginWithPasskey, passkeysAvailable } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'password' | 'passkey' | null>(null);
  const showPasskey = passkeysAvailable && passkeysSupported();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy('password');
    setError(null);
    try {
      await login({ username: username.trim(), password });
    } catch (err) {
      setError(errorMessage(err, 'Could not sign in.'));
      setBusy(null);
    }
  }

  async function onPasskey() {
    setBusy('passkey');
    setError(null);
    try {
      await loginWithPasskey();
    } catch (err) {
      setError(errorMessage(err, 'Passkey sign-in failed.'));
      setBusy(null);
    }
  }

  return (
    <Shell title="Sign in" notice={<ServerNotice />}>
      <form onSubmit={onSubmit} className="flex flex-col gap-2.5">
        <Field label="Username">
          {(p) => (
            <Input
              {...p}
              name="username"
              autoComplete="username webauthn"
              autoCapitalize="none"
              spellCheck={false}
              required
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          )}
        </Field>
        <Field label="Password">
          {(p) => (
            <Input
              {...p}
              type="password"
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        {error && <Notice tone="bad">{error}</Notice>}
        <Button type="submit" variant="primary" disabled={busy !== null || !username || !password}>
          {busy === 'password' && <Spinner label="Signing in" />}
          Sign in
        </Button>
        {showPasskey && (
          <>
            <div className="flex items-center gap-2 text-2xs text-fg-3" aria-hidden>
              <span className="h-px flex-1 bg-line" />
              or
              <span className="h-px flex-1 bg-line" />
            </div>
            <Button onClick={() => void onPasskey()} disabled={busy !== null}>
              {busy === 'passkey' ? (
                <Spinner label="Waiting for passkey" />
              ) : (
                <Fingerprint className="size-4" aria-hidden />
              )}
              Sign in with a passkey
            </Button>
          </>
        )}
      </form>
      <p className="mt-2.5 text-xs text-fg-3">
        Your local data stays on this device while signed out.
      </p>
    </Shell>
  );
}

export function LockScreen() {
  const { session, unlockWithPassword, loginWithPasskey, logout, passkeysAvailable } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const showPasskey = passkeysAvailable && passkeysSupported();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const ok = await unlockWithPassword(password);
      if (!ok) {
        setError('Wrong password.');
        setPassword('');
        inputRef.current?.focus();
      }
    } catch (err) {
      setError(errorMessage(err, 'Could not unlock.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell title="Locked" subtitle="Locked after inactivity. Enter your password to continue.">
      <form onSubmit={onSubmit} className="flex flex-col gap-2.5">
        <p id={nameId} className="text-sm text-fg-2">
          Signed in as{' '}
          <strong className="font-semibold text-fg">{session?.username ?? 'you'}</strong>
        </p>
        <Field label="Password">
          {(p) => (
            <Input
              {...p}
              ref={inputRef}
              type="password"
              autoComplete="current-password"
              aria-describedby={nameId}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        {error && <Notice tone="bad">{error}</Notice>}
        <Button type="submit" variant="primary" disabled={busy || !password}>
          {busy && <Spinner label="Unlocking" />}
          Unlock
        </Button>
        {showPasskey && (
          <Button
            onClick={() => {
              setBusy(true);
              loginWithPasskey()
                .catch((err) => setError(errorMessage(err, 'Passkey sign-in failed.')))
                .finally(() => setBusy(false));
            }}
            disabled={busy}
          >
            <Fingerprint className="size-4" aria-hidden />
            Use a passkey
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => void logout()}>
          Sign out and clear this device
        </Button>
      </form>
    </Shell>
  );
}
