import {
  API,
  ERROR_CODES,
  NOTIFY_MIN_DOWN_MINUTES,
  NOTIFY_REPEAT_MINUTES,
  PUSHOVER_KEY_PATTERN,
  PUSHOVER_SOUNDS,
  notificationConfigResponseSchema,
  notificationTestResponseSchema,
  type MaskedCredential,
  type NotificationConfigRequest,
  type NotificationConfigResponse,
  type NotificationOptions,
} from '@webfront/shared';
import { useCallback, useEffect, useState } from 'react';
import { ApiRequestError, NetworkError, apiFetch } from '@/lib/api';
import {
  Badge,
  Button,
  ConfirmDialog,
  Field,
  Input,
  Select,
  Switch,
  formatRelativeShort,
  useOnline,
} from '@/ui';

/**
 * Settings → Notifications: Pushover alerts for service outages. Server-only state (the
 * credentials never reach the synced settings and are never sent back after saving), so every
 * read and write goes through `apiFetch` and needs the server.
 */

function errorText(err: unknown, fallback: string): string {
  if (err instanceof NetworkError) return 'The server is not reachable. Try again when online.';
  if (err instanceof ApiRequestError) return err.message || fallback;
  return fallback;
}

function minutesLabel(m: number, zero: string): string {
  if (m === 0) return zero;
  if (m >= 60 && m % 60 === 0) return `${m / 60} hour${m === 60 ? '' : 's'}`;
  return `${m} minutes`;
}

export default function NotificationsSection() {
  const online = useOnline();
  const [config, setConfig] = useState<NotificationConfigResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [options, setOptions] = useState<NotificationOptions | null>(null);
  const [token, setToken] = useState('');
  const [userKey, setUserKey] = useState('');
  const [errors, setErrors] = useState<{ token?: string; userKey?: string; form?: string }>({});
  const [busy, setBusy] = useState<'save' | 'test' | 'clear' | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const apply = useCallback((c: NotificationConfigResponse) => {
    setConfig(c);
    setEnabled(c.enabled);
    setOptions(c.options);
  }, []);

  const load = useCallback(async () => {
    try {
      apply(await apiFetch(API.notifications, { schema: notificationConfigResponseSchema }));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err, 'Could not load the notification settings.'));
    }
  }, [apply]);

  useEffect(() => {
    if (online) void load();
  }, [online, load]);

  const offline = !online;
  const typedSecrets = token.trim() !== '' || userKey.trim() !== '';

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!options || offline) return;
    const errs: typeof errors = {};
    const t = token.trim();
    const u = userKey.trim();
    if (t && !PUSHOVER_KEY_PATTERN.test(t)) errs.token = 'An API token is 30 letters and digits.';
    if (u && !PUSHOVER_KEY_PATTERN.test(u)) errs.userKey = 'A user key is 30 letters and digits.';
    if (enabled && !t && !config?.token.configured) errs.token = 'Enter the API token.';
    if (enabled && !u && !config?.userKey.configured) errs.userKey = 'Enter your user key.';
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    const body: NotificationConfigRequest = { enabled, options };
    if (t) body.token = t;
    if (u) body.userKey = u;
    setBusy('save');
    setNotice(null);
    try {
      apply(
        await apiFetch(API.notifications, {
          method: 'PUT',
          body,
          schema: notificationConfigResponseSchema,
        }),
      );
      setToken('');
      setUserKey('');
      setNotice({ tone: 'ok', text: 'Saved.' });
    } catch (err) {
      setErrors({ form: errorText(err, 'Could not save the notification settings.') });
    } finally {
      setBusy(null);
    }
  };

  const sendTest = async () => {
    setBusy('test');
    setNotice(null);
    try {
      await apiFetch(API.notificationsTest, {
        method: 'POST',
        schema: notificationTestResponseSchema,
      });
      setNotice({ tone: 'ok', text: 'Test notification sent. Check your phone.' });
    } catch (err) {
      const text =
        err instanceof ApiRequestError && err.code === ERROR_CODES.rateLimited
          ? 'Wait a few seconds before sending another test.'
          : errorText(err, 'The test notification failed.');
      setNotice({ tone: 'bad', text });
    } finally {
      setBusy(null);
      void load();
    }
  };

  const clear = async () => {
    setConfirmClear(false);
    setBusy('clear');
    setNotice(null);
    try {
      apply(
        await apiFetch(API.notificationsCredentials, {
          method: 'DELETE',
          schema: notificationConfigResponseSchema,
        }),
      );
      setNotice({ tone: 'ok', text: 'Saved credentials removed.' });
    } catch (err) {
      setNotice({ tone: 'bad', text: errorText(err, 'Could not remove the credentials.') });
    } finally {
      setBusy(null);
    }
  };

  const intro = (
    <p className="text-fg-3">
      Get a phone notification through{' '}
      <a
        href="https://pushover.net"
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent-text hover:underline"
      >
        Pushover
      </a>{' '}
      when a service goes down and when it recovers. In Pushover, create an application to get an
      API token; your user key is shown on your Pushover dashboard. Both stay on the Webfront server
      and are never shown again after saving. Service names, hostnames and failure reasons are sent
      to Pushover.
    </p>
  );

  if (!config || !options) {
    return (
      <div className="flex max-w-xl flex-col gap-2 text-sm">
        {intro}
        {offline ? (
          <p role="status" className="text-warn-text">
            Notification settings are stored on the server. Connect to view or change them.
          </p>
        ) : loadError ? (
          <div className="flex items-center gap-2">
            <p role="alert" className="text-xs text-bad-text">
              {loadError}
            </p>
            <Button size="sm" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        ) : (
          <p className="text-fg-3">Loading…</p>
        )}
      </div>
    );
  }

  const set = <K extends keyof NotificationOptions>(k: K, v: NotificationOptions[K]) =>
    setOptions((o) => (o ? { ...o, [k]: v } : o));
  const savedCredentials = config.token.source === 'saved' || config.userKey.source === 'saved';
  const testReason = offline
    ? 'Connect to the server to send a test.'
    : !config.configured
      ? 'Save the API token and user key first.'
      : typedSecrets
        ? 'Save the new credentials first.'
        : null;
  const d = config.delivery;
  const lastFailed =
    d.lastError && d.lastErrorAt && (!d.lastSuccessAt || d.lastErrorAt >= d.lastSuccessAt);

  return (
    <form
      onSubmit={save}
      className="flex max-w-xl flex-col gap-3 text-sm"
      aria-label="Pushover notifications"
      autoComplete="off"
    >
      {intro}

      <div
        role="status"
        aria-label="Notification status"
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
      >
        {config.configured ? (
          <Badge tone={config.enabled && !d.paused ? 'ok' : 'neutral'}>
            {config.enabled ? (d.paused ? 'paused' : 'on') : 'off'}
          </Badge>
        ) : (
          <Badge tone="neutral">not configured</Badge>
        )}
        <span className="text-fg-2">
          {config.configured ? 'Configured' : 'Not configured'}
          {d.lastSuccessAt
            ? ` · last sent ${formatRelativeShort(d.lastSuccessAt)} ago`
            : ' · nothing sent yet'}
        </span>
        {lastFailed && (
          <span className="w-full text-bad-text">
            Last delivery failed: {d.lastError}
            {d.lastErrorAt ? ` (${formatRelativeShort(d.lastErrorAt)} ago)` : ''}
          </span>
        )}
        {d.paused && (
          <span className="w-full text-warn-text">
            Alerts are paused because Pushover rejected a request. Fix the settings and save, or
            send a successful test.
          </span>
        )}
      </div>

      {offline && (
        <p role="status" className="text-xs text-warn-text">
          You are offline. These settings live on the server, so they cannot be changed until you
          reconnect.
        </p>
      )}

      <Switch
        checked={enabled}
        onCheckedChange={setEnabled}
        label="Send outage notifications"
        disabled={offline}
      />

      <div className="grid gap-2 sm:grid-cols-2">
        <SecretField
          label="API token (application)"
          value={token}
          onChange={setToken}
          credential={config.token}
          error={errors.token}
          disabled={offline}
        />
        <SecretField
          label="User key"
          value={userKey}
          onChange={setUserKey}
          credential={config.userKey}
          error={errors.userKey}
          disabled={offline}
        />
      </div>

      <fieldset className="flex flex-col gap-2" disabled={offline}>
        <legend className="label-caps mb-1 text-fg-3">When to notify</legend>
        <div className="flex flex-wrap gap-x-4">
          <Switch
            checked={options.notifyDown}
            onCheckedChange={(v) => set('notifyDown', v)}
            label="When a service goes down"
            disabled={offline}
          />
          <Switch
            checked={options.notifyRecovery}
            onCheckedChange={(v) => set('notifyRecovery', v)}
            label="When it recovers"
            disabled={offline}
          />
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field
            label="Alert after it has been down for"
            hint="A service counts as down after two failed checks in a row."
          >
            {(p) => (
              <Select
                {...p}
                value={options.minDownMinutes}
                onChange={(e) =>
                  set(
                    'minDownMinutes',
                    Number(e.target.value) as NotificationOptions['minDownMinutes'],
                  )
                }
              >
                {NOTIFY_MIN_DOWN_MINUTES.map((m) => (
                  <option key={m} value={m}>
                    {minutesLabel(m, 'Right away')}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Remind me while still down">
            {(p) => (
              <Select
                {...p}
                value={options.repeatMinutes}
                onChange={(e) =>
                  set(
                    'repeatMinutes',
                    Number(e.target.value) as NotificationOptions['repeatMinutes'],
                  )
                }
              >
                {NOTIFY_REPEAT_MINUTES.map((m) => (
                  <option key={m} value={m}>
                    {m === 0 ? 'Never' : `Every ${minutesLabel(m, '')}`}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Priority when down">
            {(p) => (
              <Select
                {...p}
                value={options.downPriority}
                onChange={(e) =>
                  set('downPriority', e.target.value as NotificationOptions['downPriority'])
                }
              >
                <option value="normal">Normal</option>
                <option value="high">High (bypasses Pushover quiet hours)</option>
              </Select>
            )}
          </Field>
          <Field label="Priority when recovered">
            {(p) => (
              <Select
                {...p}
                value={options.recoveryPriority}
                onChange={(e) =>
                  set('recoveryPriority', e.target.value as NotificationOptions['recoveryPriority'])
                }
              >
                <option value="low">Low (no sound)</option>
                <option value="normal">Normal</option>
              </Select>
            )}
          </Field>
          <Field label="Sound">
            {(p) => (
              <Select
                {...p}
                value={options.sound ?? ''}
                onChange={(e) =>
                  set(
                    'sound',
                    e.target.value === ''
                      ? null
                      : (e.target.value as NonNullable<NotificationOptions['sound']>),
                  )
                }
              >
                <option value="">Your Pushover default</option>
                {PUSHOVER_SOUNDS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Device" hint="Leave empty to notify all your devices.">
            {(p) => (
              <Input
                {...p}
                value={options.device ?? ''}
                maxLength={25}
                placeholder="e.g. iphone"
                autoComplete="off"
                onChange={(e) =>
                  set('device', e.target.value.trim() === '' ? null : e.target.value.trim())
                }
              />
            )}
          </Field>
        </div>
      </fieldset>

      {errors.form && (
        <p role="alert" className="text-xs text-bad-text">
          {errors.form}
        </p>
      )}
      {notice && (
        <p
          role={notice.tone === 'bad' ? 'alert' : 'status'}
          className={notice.tone === 'bad' ? 'text-xs text-bad-text' : 'text-xs text-ok-text'}
        >
          {notice.text}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" disabled={offline || busy !== null}>
          Save
        </Button>
        <Button
          onClick={() => void sendTest()}
          disabled={testReason !== null || busy !== null}
          title={testReason ?? undefined}
        >
          {busy === 'test' ? 'Sending…' : 'Send test'}
        </Button>
        <Button
          variant="ghost"
          className="ml-auto"
          onClick={() => setConfirmClear(true)}
          disabled={offline || busy !== null || !savedCredentials}
        >
          Remove credentials
        </Button>
      </div>
      {testReason && !offline && <p className="text-xs text-fg-3">{testReason}</p>}

      <ConfirmDialog
        open={confirmClear}
        danger
        title="Remove the Pushover credentials?"
        description="The saved API token and user key are deleted from the server, and no more outage notifications are sent until you enter them again."
        confirmLabel="Remove"
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => void clear()}
      />
    </form>
  );
}

function SecretField({
  label,
  value,
  onChange,
  credential,
  error,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  credential: MaskedCredential;
  error: string | undefined;
  disabled: boolean;
}) {
  const fromEnv = credential.source === 'env';
  const hint = fromEnv
    ? `Set in the server's env file (${credential.hint ?? ''}).`
    : credential.configured
      ? `Saved (${credential.hint ?? ''}). Leave empty to keep it.`
      : '30 letters and digits.';
  return (
    <Field label={label} hint={hint} error={error}>
      {(p) => (
        <Input
          {...p}
          type="password"
          autoComplete="off"
          spellCheck={false}
          maxLength={64}
          value={value}
          disabled={disabled || fromEnv}
          placeholder={credential.configured ? '••••••••' : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}
