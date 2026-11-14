import {
  API,
  ERROR_CODES,
  passkeyInfoSchema,
  passkeyListResponseSchema,
  passkeyRegisterOptionsResponseSchema,
  passwordSchema,
  revokeOtherSessionsResponseSchema,
  sessionListResponseSchema,
  type PasskeyInfo,
  type SessionSummary,
} from '@webfront/shared';
import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/auth';
import { useSyncStatus } from '@/data';
import { ApiRequestError, NetworkError, apiFetch } from '@/lib/api';
import {
  Button,
  ConfirmDialog,
  Field,
  Input,
  Badge,
  Switch,
  formatRelativeShort,
  useToast,
} from '@/ui';

function errorText(err: unknown, fallback: string): string {
  if (err instanceof NetworkError) return 'The server is not reachable. Try again when online.';
  if (err instanceof ApiRequestError) {
    if (err.code === ERROR_CODES.rateLimited) return 'Too many attempts. Wait a moment and retry.';
    return err.message || fallback;
  }
  return fallback;
}

export function passkeysUsable(): boolean {
  try {
    return typeof window !== 'undefined' && window.isSecureContext && browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

export default function AccountSection() {
  return (
    <div className="flex flex-col gap-4">
      <SignedInAs />
      <PasswordForm />
      <Passkeys />
      <Sessions />
    </div>
  );
}

function SignedInAs() {
  const auth = useAuth();
  const sync = useSyncStatus();
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span>
        Signed in as <strong>{auth.session?.username ?? '…'}</strong>
        {auth.session?.deviceName ? ` on ${auth.session.deviceName}` : ''}.
      </span>
      <Button size="sm" variant="secondary" className="ml-auto" onClick={() => setConfirm(true)}>
        Sign out
      </Button>
      <ConfirmDialog
        open={confirm}
        danger
        title="Sign out of this device?"
        description={
          sync.pendingChanges > 0
            ? `${sync.pendingChanges} change${sync.pendingChanges === 1 ? ' has' : 's have'} not synced yet and will be lost, because signing out removes the local copy of your data.`
            : 'Signing out removes the local copy of your data from this device. It stays on the server.'
        }
        confirmLabel="Sign out"
        onCancel={() => setConfirm(false)}
        onConfirm={async () => {
          setConfirm(false);
          await auth.logout();
        }}
      />
    </div>
  );
}

function PasswordForm() {
  const { toast } = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [revokeOthers, setRevokeOthers] = useState(true);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{
    current?: string;
    next?: string;
    again?: string;
    form?: string;
  }>({});

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs: typeof errors = {};
    if (!current) errs.current = 'Enter your current password.';
    const ok = passwordSchema.safeParse(next);
    if (!ok.success) errs.next = 'Use at least 10 characters.';
    if (next !== again) errs.again = 'The passwords do not match.';
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setBusy(true);
    try {
      await apiFetch(API.auth.password, {
        method: 'POST',
        body: { currentPassword: current, newPassword: next, revokeOtherSessions: revokeOthers },
      });
      setCurrent('');
      setNext('');
      setAgain('');
      toast({ title: 'Password changed', tone: 'success' });
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === ERROR_CODES.wrongPassword) {
        setErrors({ current: 'That is not your current password.' });
      } else {
        setErrors({ form: errorText(err, 'Could not change the password.') });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex max-w-sm flex-col gap-2" aria-label="Change password">
      <h3 className="label-caps text-fg-3">Change password</h3>
      <Field label="Current password" error={errors.current}>
        {(p) => (
          <Input
            {...p}
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        )}
      </Field>
      <Field label="New password" hint="At least 10 characters." error={errors.next}>
        {(p) => (
          <Input
            {...p}
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        )}
      </Field>
      <Field label="Repeat new password" error={errors.again}>
        {(p) => (
          <Input
            {...p}
            type="password"
            autoComplete="new-password"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
          />
        )}
      </Field>
      <Switch
        checked={revokeOthers}
        onCheckedChange={setRevokeOthers}
        label="Sign out my other devices"
      />
      {errors.form && (
        <p role="alert" className="text-xs text-bad-text">
          {errors.form}
        </p>
      )}
      <div>
        <Button type="submit" variant="primary" disabled={busy}>
          Change password
        </Button>
      </div>
    </form>
  );
}

function Passkeys() {
  const { toast } = useToast();
  const usable = passkeysUsable();
  const [list, setList] = useState<PasskeyInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<PasskeyInfo | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch(API.auth.passkeys, { schema: passkeyListResponseSchema });
      setList(r.passkeys);
      setError(null);
    } catch (err) {
      setError(errorText(err, 'Could not load passkeys.'));
    }
  }, []);
  useEffect(() => {
    if (usable) void load();
  }, [usable, load]);

  if (!usable) {
    return (
      <div className="text-sm">
        <h3 className="label-caps mb-1 text-fg-3">Passkeys</h3>
        <p className="text-fg-2">
          Passkeys are not available here. They need a secure connection (HTTPS on the real
          hostname, for example your tailscale address) and a browser that supports them. Open
          Webfront at its https address to add one.
        </p>
      </div>
    );
  }

  const add = async () => {
    setBusy(true);
    try {
      const label = name.trim() || 'Passkey';
      const { options } = await apiFetch(API.auth.passkeyRegisterOptions, {
        method: 'POST',
        body: { name: label },
        schema: passkeyRegisterOptionsResponseSchema,
      });
      let response;
      try {
        response = await startRegistration({
          optionsJSON: options as unknown as PublicKeyCredentialCreationOptionsJSON,
        });
      } catch (err) {
        const n = (err as Error)?.name;
        if (n === 'NotAllowedError' || n === 'AbortError') {
          toast({ title: 'Passkey setup was cancelled', tone: 'warning' });
          return;
        }
        throw err;
      }
      await apiFetch(API.auth.passkeyRegisterVerify, {
        method: 'POST',
        body: { name: label, response },
        schema: passkeyInfoSchema,
      });
      setName('');
      toast({ title: 'Passkey added', tone: 'success' });
      await load();
    } catch (err) {
      toast({ title: 'Could not add the passkey', description: errorText(err, ''), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 text-sm">
      <h3 className="label-caps text-fg-3">Passkeys</h3>
      {error && (
        <p role="alert" className="text-xs text-bad-text">
          {error}
        </p>
      )}
      {list && list.length === 0 && <p className="text-fg-3">No passkeys yet.</p>}
      <ul className="divide-y divide-line rounded-md border border-line">
        {(list ?? []).map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-2 px-2 py-1">
            {renaming?.id === p.id ? (
              <form
                className="flex flex-1 items-center gap-1"
                onSubmit={async (e) => {
                  e.preventDefault();
                  try {
                    await apiFetch(`${API.auth.passkeys}/${p.id}`, {
                      method: 'PATCH',
                      body: { name: renaming.name },
                      schema: passkeyInfoSchema,
                    });
                    setRenaming(null);
                    await load();
                  } catch (err) {
                    toast({ title: errorText(err, 'Could not rename'), tone: 'error' });
                  }
                }}
              >
                <Input
                  aria-label="Passkey name"
                  value={renaming.name}
                  onChange={(e) => setRenaming({ id: p.id, name: e.target.value })}
                  autoFocus
                />
                <Button size="sm" type="submit" variant="primary">
                  Save
                </Button>
                <Button size="sm" onClick={() => setRenaming(null)}>
                  Cancel
                </Button>
              </form>
            ) : (
              <>
                <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
                {p.backedUp && <Badge tone="accent">synced</Badge>}
                <span className="text-xs text-fg-3">
                  {p.lastUsedAt ? `used ${formatRelativeShort(p.lastUsedAt)} ago` : 'never used'}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setRenaming({ id: p.id, name: p.name })}
                >
                  Rename
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDeleting(p)}>
                  Delete
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
      <div className="flex max-w-sm items-end gap-2">
        <Field label="Name for the new passkey" className="flex-1">
          {(p) => (
            <Input
              {...p}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. MacBook"
            />
          )}
        </Field>
        <Button onClick={() => void add()} disabled={busy}>
          Add passkey
        </Button>
      </div>
      <ConfirmDialog
        open={!!deleting}
        danger
        title={`Delete passkey “${deleting?.name ?? ''}”?`}
        description="You will no longer be able to sign in with it."
        confirmLabel="Delete"
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          const target = deleting;
          setDeleting(null);
          if (!target) return;
          try {
            await apiFetch(`${API.auth.passkeys}/${target.id}`, { method: 'DELETE' });
            await load();
          } catch (err) {
            toast({ title: errorText(err, 'Could not delete'), tone: 'error' });
          }
        }}
      />
    </div>
  );
}

function Sessions() {
  const { toast } = useToast();
  const auth = useAuth();
  const [list, setList] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch(API.auth.sessions, { schema: sessionListResponseSchema });
      setList(r.sessions);
      setError(null);
    } catch (err) {
      setError(errorText(err, 'Could not load devices.'));
    }
  }, []);
  useEffect(() => void load(), [load]);

  const others = (list ?? []).filter((s) => !s.current);
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex items-center gap-2">
        <h3 className="label-caps text-fg-3">Signed-in devices</h3>
        {others.length > 0 && (
          <Button
            size="sm"
            className="ml-auto"
            onClick={async () => {
              try {
                const r = await apiFetch(API.auth.sessions, {
                  method: 'DELETE',
                  schema: revokeOtherSessionsResponseSchema,
                });
                toast({
                  title: `Signed out ${r.revoked} other device${r.revoked === 1 ? '' : 's'}`,
                });
                await load();
              } catch (err) {
                toast({ title: errorText(err, 'Could not sign out other devices'), tone: 'error' });
              }
            }}
          >
            Sign out all others
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-bad-text">
          {error}
        </p>
      )}
      <ul className="divide-y divide-line rounded-md border border-line">
        {(list ?? []).map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-2 px-2 py-1">
            <span className="min-w-0 flex-1">
              <span className="font-medium">{s.deviceName ?? s.userAgent ?? 'Unknown device'}</span>
              {s.current && (
                <Badge tone="ok" className="ml-1.5">
                  this device
                </Badge>
              )}
              <span className="block text-xs text-fg-3">
                {s.authMethod} sign-in · active {formatRelativeShort(s.lastSeenAt)} ago
                {s.ip ? ` · ${s.ip}` : ''}
              </span>
            </span>
            {s.current ? (
              <Button size="sm" variant="ghost" onClick={() => void auth.logout()}>
                Sign out
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  try {
                    await apiFetch(`${API.auth.sessions}/${s.id}`, { method: 'DELETE' });
                    await load();
                  } catch (err) {
                    toast({ title: errorText(err, 'Could not revoke'), tone: 'error' });
                  }
                }}
              >
                Revoke
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
