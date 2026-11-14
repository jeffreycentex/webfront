import { serviceCheckSchema, type ServiceCheck } from '@webfront/shared';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { patch, put } from '@/data';
import {
  Button,
  Checkbox,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Switch,
  TagInput,
  Textarea,
  useOnline,
  useToast,
} from '@/ui';
import type { ColourKey } from '@webfront/shared';
import { resolveTitle } from './api';
import { allTags } from './data';
import {
  categoryOptions,
  hostOf,
  normaliseUrl,
  sortKeyForAppend,
  type Bookmark,
  type Category,
} from './model';

export interface BookmarkFormProps {
  open: boolean;
  onClose: () => void;
  /** Editing this bookmark; otherwise creating a new one. */
  bookmark?: Bookmark | null;
  /** Prefill for a new bookmark. */
  defaults?: { url?: string; title?: string; categoryId?: string | null };
  categories: readonly Category[];
  bookmarks: readonly Bookmark[];
  tagColours?: Record<string, ColourKey>;
}

interface FormState {
  url: string;
  title: string;
  categoryId: string;
  tags: string[];
  username: string;
  hint: string;
  notes: string;
  isService: boolean;
  checkType: 'http' | 'tcp';
  checkUrl: string;
  method: 'GET' | 'HEAD';
  expectedStatus: string;
  insecure: boolean;
  host: string;
  port: string;
}

function initialState(b: Bookmark | null | undefined, d: BookmarkFormProps['defaults']): FormState {
  const c = b?.serviceCheck;
  return {
    url: b?.url ?? d?.url ?? '',
    title: b?.title ?? d?.title ?? '',
    categoryId: b ? (b.categoryId ?? '') : (d?.categoryId ?? ''),
    tags: b?.tags ?? [],
    username: b?.username ?? '',
    hint: b?.hint ?? '',
    notes: b?.notes ?? '',
    isService: b?.isService ?? false,
    checkType: c?.type ?? 'http',
    checkUrl: c?.type === 'http' ? (c.url ?? '') : '',
    method: c?.type === 'http' ? c.method : 'GET',
    expectedStatus: c?.type === 'http' && c.expectedStatus ? String(c.expectedStatus) : '',
    insecure: c?.type === 'http' ? c.allowInsecureTls : true,
    host: c?.type === 'tcp' ? c.host : '',
    port: c?.type === 'tcp' ? String(c.port) : '',
  };
}

function buildCheck(s: FormState): ServiceCheck {
  if (s.checkType === 'tcp') {
    return serviceCheckSchema.parse({ type: 'tcp', host: s.host, port: Number(s.port) });
  }
  const override = s.checkUrl.trim() ? normaliseUrl(s.checkUrl) : null;
  if (s.checkUrl.trim() && !override)
    throw new Error('The check URL is not a valid http(s) address');
  return serviceCheckSchema.parse({
    type: 'http',
    url: override,
    method: s.method,
    expectedStatus: s.expectedStatus.trim() ? Number(s.expectedStatus) : null,
    allowInsecureTls: s.insecure,
  });
}

export function BookmarkForm(props: BookmarkFormProps) {
  const { open, onClose, bookmark, defaults, categories, bookmarks, tagColours } = props;
  // Remount the body on each open so state always starts from the current record.
  if (!open) return null;
  return (
    <FormBody
      key={bookmark?.id ?? 'new'}
      onClose={onClose}
      bookmark={bookmark ?? null}
      defaults={defaults}
      categories={categories}
      bookmarks={bookmarks}
      tagColours={tagColours}
    />
  );
}

function FormBody({
  onClose,
  bookmark,
  defaults,
  categories,
  bookmarks,
  tagColours,
}: Omit<BookmarkFormProps, 'open' | 'bookmark'> & { bookmark: Bookmark | null }) {
  const online = useOnline();
  const { toast } = useToast();
  const [s, setS] = useState(() => initialState(bookmark, defaults));
  const [error, setError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const titleTouched = useRef(Boolean(bookmark) || Boolean(defaults?.title));
  const lastFetched = useRef<string | null>(null);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setS((p) => ({ ...p, [k]: v }));
  const options = useMemo(() => categoryOptions(categories), [categories]);
  const suggestions = useMemo(() => allTags(bookmarks), [bookmarks]);

  /** Fill the title from the server (online) or the hostname (offline) once the URL is valid. */
  const autofill = async (raw: string) => {
    const url = normaliseUrl(raw);
    if (!url || titleTouched.current || lastFetched.current === url) return;
    lastFetched.current = url;
    setFetching(true);
    const title = await resolveTitle(url, online);
    setFetching(false);
    if (!titleTouched.current) setS((p) => (normaliseUrl(p.url) === url ? { ...p, title } : p));
  };

  useEffect(() => {
    if (defaults?.url && !bookmark) void autofill(defaults.url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const url = normaliseUrl(s.url);
    if (!url) return setError('Enter a valid http(s) address.');
    const title = s.title.trim() || (await resolveTitle(url, false));
    let serviceCheck: ServiceCheck | null = null;
    if (s.isService) {
      try {
        serviceCheck = buildCheck(s);
      } catch (err) {
        return setError(err instanceof Error ? err.message : 'The service check is not valid.');
      }
    }
    const categoryId = s.categoryId || null;
    setSaving(true);
    try {
      const values = {
        url,
        title,
        categoryId,
        tags: s.tags,
        username: s.username.trim() || null,
        hint: s.hint.trim() || null,
        notes: s.notes,
        isService: s.isService,
        serviceCheck,
      };
      if (bookmark) {
        const changes: Partial<typeof values & { sortKey: string }> = { ...values };
        if (categoryId !== bookmark.categoryId) {
          changes.sortKey = sortKeyForAppend(bookmarks.filter((b) => b.categoryId === categoryId));
        }
        await patch('bookmarks', bookmark.id, changes);
      } else {
        await put('bookmarks', {
          ...values,
          sortKey: sortKeyForAppend(bookmarks.filter((b) => b.categoryId === categoryId)),
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the bookmark.');
      toast({ title: 'Could not save', tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const enableService = (on: boolean) => {
    setS((p) => {
      if (!on || p.host) return { ...p, isService: on };
      let host = '';
      let port = '';
      try {
        const u = new URL(normaliseUrl(p.url) ?? '');
        host = u.hostname;
        port = u.port || (u.protocol === 'https:' ? '443' : '80');
      } catch {
        // leave blank
      }
      return { ...p, isService: on, host, port };
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={bookmark ? 'Edit bookmark' : 'New bookmark'}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="bookmark-form" variant="primary" disabled={saving}>
            {bookmark ? 'Save' : 'Add bookmark'}
          </Button>
        </>
      }
    >
      <form id="bookmark-form" onSubmit={(e) => void submit(e)} className="flex flex-col gap-2.5">
        <Field label="Address">
          {(p) => (
            <Input
              {...p}
              data-autofocus=""
              type="text"
              inputMode="url"
              autoComplete="off"
              placeholder="https://example.com"
              value={s.url}
              onChange={(e) => set('url', e.target.value)}
              onBlur={(e) => void autofill(e.target.value)}
              onPaste={(e) => {
                const text = e.clipboardData.getData('text');
                setTimeout(() => void autofill(text), 0);
              }}
            />
          )}
        </Field>
        <Field
          label={
            <span className="inline-flex items-center gap-1.5">
              Title {fetching && <Spinner label="Fetching title" className="size-3" />}
            </span>
          }
          hint={online ? undefined : 'Offline: the title falls back to the host name.'}
        >
          {(p) => (
            <Input
              {...p}
              value={s.title}
              placeholder={s.url ? hostOf(normaliseUrl(s.url) ?? s.url) : 'Page title'}
              onChange={(e) => {
                titleTouched.current = true;
                set('title', e.target.value);
              }}
            />
          )}
        </Field>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <Field label="Category">
            {(p) => (
              <Select
                {...p}
                value={s.categoryId}
                onChange={(e) => set('categoryId', e.target.value)}
              >
                <option value="">Uncategorised</option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Tags">
            {(p) => (
              <TagInput
                id={p.id}
                value={s.tags}
                onChange={(t) => set('tags', t)}
                suggestions={suggestions}
                {...(tagColours ? { colours: tagColours } : {})}
              />
            )}
          </Field>
        </div>

        <fieldset className="rounded-md border border-line p-2">
          <legend className="px-1 text-xs font-medium text-fg-2">Sign-in reminder</legend>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <Field label="Username">
              {(p) => (
                <Input
                  {...p}
                  autoComplete="off"
                  value={s.username}
                  onChange={(e) => set('username', e.target.value)}
                />
              )}
            </Field>
            <Field label="Hint">
              {(p) => (
                <Input
                  {...p}
                  autoComplete="off"
                  value={s.hint}
                  onChange={(e) => set('hint', e.target.value)}
                />
              )}
            </Field>
          </div>
          <p className="mt-1.5 text-xs text-fg-3">
            Store a reminder only, such as “the usual one plus the year”. Do not put real passwords
            here: this text is saved unencrypted on the server and on every device.
          </p>
        </fieldset>

        <Field label="Notes" hint="Markdown is supported.">
          {(p) => (
            <Textarea
              {...p}
              rows={3}
              value={s.notes}
              onChange={(e) => set('notes', e.target.value)}
            />
          )}
        </Field>

        <fieldset className="rounded-md border border-line p-2">
          <legend className="px-1 text-xs font-medium text-fg-2">Service status</legend>
          <Switch
            label="Monitor this as a service"
            checked={s.isService}
            onCheckedChange={enableService}
          />
          {s.isService && (
            <div className="mt-2 flex flex-col gap-2.5">
              <Field label="Check type">
                {(p) => (
                  <Select
                    {...p}
                    value={s.checkType}
                    onChange={(e) => set('checkType', e.target.value as 'http' | 'tcp')}
                  >
                    <option value="http">HTTP request</option>
                    <option value="tcp">TCP port</option>
                  </Select>
                )}
              </Field>
              {s.checkType === 'http' ? (
                <>
                  <Field label="URL to check" hint="Leave empty to use the bookmark address.">
                    {(p) => (
                      <Input
                        {...p}
                        value={s.checkUrl}
                        placeholder={s.url}
                        onChange={(e) => set('checkUrl', e.target.value)}
                      />
                    )}
                  </Field>
                  <div className="grid grid-cols-2 gap-2.5">
                    <Field label="Method">
                      {(p) => (
                        <Select
                          {...p}
                          value={s.method}
                          onChange={(e) => set('method', e.target.value as 'GET' | 'HEAD')}
                        >
                          <option>GET</option>
                          <option>HEAD</option>
                        </Select>
                      )}
                    </Field>
                    <Field label="Expected status" hint="Empty: anything below 500 is up.">
                      {(p) => (
                        <Input
                          {...p}
                          inputMode="numeric"
                          value={s.expectedStatus}
                          placeholder="any"
                          onChange={(e) => set('expectedStatus', e.target.value.replace(/\D/g, ''))}
                        />
                      )}
                    </Field>
                  </div>
                  <Checkbox
                    label="Accept self-signed certificates"
                    checked={s.insecure}
                    onChange={(e) => set('insecure', e.target.checked)}
                  />
                </>
              ) : (
                <div className="grid grid-cols-[1fr_6rem] gap-2.5">
                  <Field label="Host">
                    {(p) => (
                      <Input {...p} value={s.host} onChange={(e) => set('host', e.target.value)} />
                    )}
                  </Field>
                  <Field label="Port">
                    {(p) => (
                      <Input
                        {...p}
                        inputMode="numeric"
                        value={s.port}
                        onChange={(e) => set('port', e.target.value.replace(/\D/g, ''))}
                      />
                    )}
                  </Field>
                </div>
              )}
              <p className="text-xs text-fg-3">
                The server checks every minute from inside your network.
              </p>
            </div>
          )}
        </fieldset>
        {error && (
          <p role="alert" className="text-sm text-bad-text">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
