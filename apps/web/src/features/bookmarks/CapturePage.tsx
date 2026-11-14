import { Check } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router';
import { put } from '@/data';
import { Button, Field, Input, Logo, Select, Spinner, TagInput, useOnline } from '@/ui';
import { resolveTitle } from './api';
import { allTags, useBookmarks, useCategories } from './data';
import { categoryOptions, normaliseUrl, parseCaptureParams, sortKeyForAppend } from './model';

const LAST_CATEGORY_KEY = 'wf.capture.category';

/**
 * Bare route `/capture?url=&title=`: the window the save-this-page bookmarklet opens. Saves
 * through `@/data` (so it works offline too) and closes itself.
 */
export function CapturePage() {
  const { search } = useLocation();
  const initial = useMemo(() => parseCaptureParams(search), [search]);
  const categories = useCategories();
  const bookmarks = useBookmarks();
  const online = useOnline();
  const [url, setUrl] = useState(initial.url);
  const [title, setTitle] = useState(initial.title);
  const [categoryId, setCategoryId] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [state, setState] = useState<'form' | 'saving' | 'saved'>('form');
  const [error, setError] = useState<string | null>(null);
  const touched = useRef(Boolean(initial.title));

  // Remember the last used category on this device.
  useEffect(() => {
    try {
      const last = localStorage.getItem(LAST_CATEGORY_KEY);
      if (last) setCategoryId(last);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (initial.title || !initial.url) return;
    void resolveTitle(initial.url, online).then((t) => {
      if (!touched.current) setTitle(t);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.url]);

  const existing = useMemo(() => (bookmarks ?? []).find((b) => b.url === url), [bookmarks, url]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!url) return setError('This page has no usable address.');
    // The field is editable: re-check, so only an http(s) address is ever stored.
    const safeUrl = normaliseUrl(url);
    if (!safeUrl) return setError('Only http and https addresses can be saved.');
    setState('saving');
    try {
      const target = categories?.some((c) => c.id === categoryId) ? categoryId : '';
      await put('bookmarks', {
        url: safeUrl,
        title: title.trim() || safeUrl,
        categoryId: target || null,
        tags,
        sortKey: sortKeyForAppend(
          (bookmarks ?? []).filter((b) => b.categoryId === (target || null)),
        ),
      });
      try {
        localStorage.setItem(LAST_CATEGORY_KEY, target);
      } catch {
        // ignore
      }
      setState('saved');
      setTimeout(() => window.close(), 700);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
      setState('form');
    }
  };

  if (state === 'saved') {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-2 bg-bg p-4 text-fg">
        <Check aria-hidden className="size-8 text-ok" />
        <p className="text-base font-medium">Saved</p>
        <p className="text-xs text-fg-3">You can close this window.</p>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-bg p-3 text-fg">
      <div className="mb-3 flex items-center gap-2">
        <Logo />
        <h1 className="text-base font-semibold">Save bookmark</h1>
        {categories === undefined && <Spinner className="ml-auto size-3" />}
      </div>
      <form onSubmit={(e) => void save(e)} className="flex flex-col gap-2.5">
        <Field label="Address">
          {(p) => <Input {...p} value={url} onChange={(e) => setUrl(e.target.value)} />}
        </Field>
        <Field
          label="Title"
          hint={existing ? 'Already saved. Saving again creates a second copy.' : undefined}
        >
          {(p) => (
            <Input
              {...p}
              autoFocus
              value={title}
              onChange={(e) => {
                touched.current = true;
                setTitle(e.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Category">
          {(p) => (
            <Select {...p} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">Uncategorised</option>
              {categoryOptions(categories ?? []).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Tags">
          {(p) => (
            <TagInput id={p.id} value={tags} onChange={setTags} suggestions={allTags(bookmarks)} />
          )}
        </Field>
        {error && (
          <p role="alert" className="text-sm text-bad-text">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={() => window.close()}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={state === 'saving' || !url}>
            Save
          </Button>
        </div>
      </form>
    </main>
  );
}
