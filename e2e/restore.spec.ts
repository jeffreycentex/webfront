import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import {
  addBookmark,
  expect,
  goTo,
  menu,
  newDevice,
  postit,
  test,
  uid,
  waitSynced,
} from './helpers';

/**
 * The reported bug: take a backup, delete a bookmark, run webfront-restore -> the bookmark must
 * come back on the server AND on every device (before the fix the devices re-pushed their newer
 * tombstone onto the restored database).
 *
 * The backup and restore go through e2e/servers.mjs's control endpoint, which runs
 * deploy/backup.sh and restore.sh's own `write_epoch` against server A and restarts it. Server A
 * is shared with the other specs: the backup is taken inside this test, so the restore only
 * rolls back this test's own changes (sessions created before the backup stay valid).
 */

const CONTROL = `http://127.0.0.1:${process.env.E2E_CONTROL_PORT ?? 8797}`;

async function control(action: 'backup' | 'restore', params: Record<string, string>) {
  const res = await fetch(
    `${CONTROL}/${action}?${new URLSearchParams({ server: 'A', ...params })}`,
    {
      method: 'POST',
    },
  );
  const body = (await res.json()) as Record<string, string>;
  expect(res.status, body.error).toBe(200);
  return body;
}

type PulledRecord = {
  collection: string;
  record: { id: string; deleted: boolean; title?: string; text?: string };
};

/** Every record (tombstones included) the server holds for a collection. */
async function serverRecords(page: Page, collection: string) {
  const res = await page.request.get('/api/sync/pull?since=0&limit=2000');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { records: PulledRecord[] };
  return body.records.filter((r) => r.collection === collection).map((r) => r.record);
}

const notice = (page: Page) => page.getByTestId('restore-notice');

test('restoring a backup brings a deleted bookmark back on the server and every device', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const s = uid();
  const title = `Restore me ${s}`;
  const note = `Offline after backup ${s}`;

  const a = await newDevice(browser, undefined, 'A');
  const b = await newDevice(browser, undefined, 'B');

  // 1. A bookmark, synced to the server and to device B.
  await addBookmark(a.page, { url: `http://127.0.0.1:9/restore-${s}`, title });
  await waitSynced(a.page);
  await goTo(b.page, 'Bookmarks');
  await expect(b.page.getByRole('link', { name: title })).toBeVisible({ timeout: 30_000 });
  await waitSynced(b.page);

  // 2. webfront-backup.
  const { id } = (await control('backup', {})) as { id: string };

  // 3. Delete the bookmark on A and sync the tombstone to the server (and B).
  await menu(a.page, `Actions for ${title}`, 'Delete');
  await expect(a.page.getByRole('link', { name: title })).toHaveCount(0);
  await waitSynced(a.page);
  await expect
    .poll(
      async () =>
        (await serverRecords(a.page, 'bookmarks')).find((r) => r.title === title)?.deleted,
    )
    .toBe(true);
  await expect(b.page.getByRole('link', { name: title })).toHaveCount(0, { timeout: 30_000 });

  // 4. Device B goes offline and makes a change the restore will set aside.
  await b.context.setOffline(true);
  await goTo(b.page, 'Post-its');
  const box = b.page.getByRole('textbox', { name: 'New post-it' });
  await box.fill(note);
  await box.press('Enter');
  await expect(postit(b.page, note)).toBeVisible();

  // 5. webfront-restore (server A restarts on the restored database with a new epoch).
  await control('restore', { id });

  // 6. Device A (online): notices the restore and gets the bookmark back, with no tombstone.
  await goTo(a.page, 'Bookmarks');
  await expect(notice(a.page)).toContainText('This device was updated to match a restored backup', {
    timeout: 60_000,
  });
  await expect(notice(a.page)).toContainText('It had no unsynced changes');
  await expect(a.page.getByRole('link', { name: title })).toBeVisible({ timeout: 30_000 });
  await waitSynced(a.page);
  const onServer = (await serverRecords(a.page, 'bookmarks')).filter((r) => r.title === title);
  expect(onServer).toHaveLength(1);
  expect(onServer[0]!.deleted).toBe(false);

  // 7. Device B reconnects: its offline post-it is set aside (not pushed), the bookmark is back.
  await b.context.setOffline(false);
  // At least the post-it (other features may have queued small writes of their own).
  await expect(notice(b.page)).toContainText(
    /\d+ unsynced changes? from this device (was|were) set aside/,
    { timeout: 60_000 },
  );
  await expect(postit(b.page, note)).toHaveCount(0);
  await goTo(b.page, 'Bookmarks');
  await expect(b.page.getByRole('link', { name: title })).toBeVisible({ timeout: 30_000 });
  await waitSynced(b.page);

  const [download] = await Promise.all([
    b.page.waitForEvent('download'),
    notice(b.page).getByRole('button', { name: 'Download them as JSON' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^webfront-set-aside-.*\.json$/);
  const file = await download.path();
  const json = JSON.parse(await readFile(file!, 'utf8')) as {
    kind: string;
    batches: Array<{
      changes: Array<{ collection: string; fields: Record<string, { value: unknown }> }>;
    }>;
  };
  expect(json.kind).toBe('webfront-set-aside-changes');
  const changes = json.batches.flatMap((x) => x.changes);
  expect(changes.some((c) => c.collection === 'postits' && c.fields.text?.value === note)).toBe(
    true,
  );

  // The server never received the set-aside post-it, and the bookmark is still live after B synced.
  const postits = await serverRecords(b.page, 'postits');
  expect(postits.some((r) => r.text === note)).toBe(false);
  const after = (await serverRecords(b.page, 'bookmarks')).filter((r) => r.title === title);
  expect(after.map((r) => r.deleted)).toEqual([false]);

  // Dismissing hides the notice (in every tab of that device).
  await notice(b.page).getByRole('button', { name: 'Dismiss restore notice' }).click();
  await expect(notice(b.page)).toHaveCount(0);

  a.guard.assertClean();
  b.guard.assertClean();
});
