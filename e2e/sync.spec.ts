import type { Page } from '@playwright/test';
import {
  addBookmark,
  createWikiPage,
  ensureShoppingList,
  expandGroup,
  expect,
  goTo,
  menu,
  newDevice,
  postit,
  setWikiBody,
  taskRow,
  test,
  uid,
  waitSynced,
} from './helpers';

/**
 * Scenario 2: two devices, one offline. Device A goes offline and both adds records and edits
 * fields of shared records; device B (online) edits *other* fields of the same records and
 * another paragraph of the same wiki page. When A reconnects both converge with nothing lost.
 * Then an overlapping wiki edit produces the conflict banner on both, and resolving it
 * converges.
 */

type Rec = Record<string, unknown> & { id: string };

/** The server's copy of every live record of a collection (the convergence target). */
async function serverRecords(page: Page, collection: string): Promise<Rec[]> {
  const res = await page.request.get('/api/sync/pull?since=0&limit=2000');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    records: Array<{ collection: string; record: Rec & { deleted: boolean } }>;
  };
  return body.records
    .filter((r) => r.collection === collection && !r.record.deleted)
    .map((r) => r.record);
}

async function serverRecord(page: Page, collection: string, where: (r: Rec) => boolean) {
  let found: Rec | undefined;
  await expect
    .poll(
      async () => {
        found = (await serverRecords(page, collection)).find(where);
        return found !== undefined;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return found!;
}

/** Open a wiki page through the app's own navigation (works offline without a reload). */
async function openWikiPage(page: Page, title: string) {
  await goTo(page, 'Wiki');
  await page.getByRole('link', { name: title, exact: true }).first().click();
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
}

async function addPostit(page: Page, text: string) {
  await goTo(page, 'Post-its');
  const box = page.getByRole('textbox', { name: 'New post-it' });
  await box.fill(text);
  await box.press('Enter');
  await expect(postit(page, text)).toBeVisible();
}

async function addTask(page: Page, text: string) {
  await goTo(page, 'Tasks');
  const box = page.getByRole('textbox', { name: 'New task' });
  await box.fill(text);
  await box.press('Enter');
  await expect(taskRow(page, text)).toBeVisible();
}

async function addItem(page: Page, list: string, text: string) {
  const panel = await ensureShoppingList(page, list);
  const box = panel.getByRole('combobox', { name: 'Add item' });
  await box.fill(text);
  await box.press('Enter');
  await expect(panel.getByRole('checkbox', { name: new RegExp(text) })).toBeVisible();
}

test('offline edits on one device and concurrent edits on another converge', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const s = uid();
  const a = await newDevice(browser);
  const b = await newDevice(browser);

  const names = {
    bookmark: `Shared BM ${s}`,
    note: `Shared note ${s}`,
    task: `Shared task ${s}`,
    list: `Sync list ${s}`,
    item: `shared item ${s}`,
    wiki: `Shared page ${s}`,
  };

  /* ---- 1. seed shared records online from A; B sees them ---- */
  await addBookmark(a.page, { url: `http://127.0.0.1:9/${s}`, title: names.bookmark });
  await addPostit(a.page, names.note);
  await addTask(a.page, names.task);
  await addItem(a.page, names.list, names.item);
  await createWikiPage(a.page, names.wiki);
  const wikiPath = new URL(a.page.url()).pathname;
  await setWikiBody(a.page, 'Alpha paragraph.\n\nBeta paragraph.');
  await waitSynced(a.page);

  await goTo(b.page, 'Bookmarks');
  await expect(b.page.getByRole('link', { name: names.bookmark })).toBeVisible();
  await goTo(b.page, 'Post-its');
  await expect(postit(b.page, names.note)).toBeVisible();
  await goTo(b.page, 'Tasks');
  await expect(taskRow(b.page, names.task)).toBeVisible();
  await ensureShoppingList(b.page, names.list);
  await b.page.goto(wikiPath);
  await expect(b.page.locator('.wf-markdown').getByText('Beta paragraph.')).toBeVisible();

  /* ---- 2. A goes offline: adds new records and edits shared ones ---- */
  await a.context.setOffline(true);
  await expect(a.page.getByRole('button', { name: /^Sync status: Offline/ })).toBeVisible();

  await goTo(a.page, 'Bookmarks');
  await menu(a.page, `Actions for ${names.bookmark}`, 'Edit');
  const edit = a.page.getByRole('dialog', { name: 'Edit bookmark' });
  await edit.getByLabel('Title').fill(`${names.bookmark} (A)`);
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(edit).toBeHidden();
  await addBookmark(a.page, { url: `http://127.0.0.1:9/offline-${s}`, title: `Offline BM ${s}` });

  await goTo(a.page, 'Post-its');
  await postit(a.page, names.note).getByRole('button', { name: 'Edit note' }).click();
  const noteText = a.page.getByRole('textbox', { name: 'Note text' });
  await noteText.fill(`${names.note} edited on A`);
  await noteText.press('Escape');
  await addPostit(a.page, `Offline note ${s}`);

  await goTo(a.page, 'Tasks');
  await taskRow(a.page, names.task).getByRole('button', { name: names.task, exact: true }).click();
  const taskTitle = a.page.getByRole('textbox', { name: 'Task title' });
  await taskTitle.fill(`${names.task} renamed on A`);
  await taskTitle.press('Enter');
  await addTask(a.page, `Offline task ${s}`);

  const listA = await ensureShoppingList(a.page, names.list);
  await listA.getByRole('checkbox', { name: new RegExp(names.item) }).click();
  await addItem(a.page, names.list, `offline item ${s}`);

  // In-app navigation only while offline (a full page load would need the service worker).
  await openWikiPage(a.page, names.wiki);
  await a.page.getByRole('button', { name: 'Edit', exact: true }).click();
  await setWikiBody(a.page, 'Alpha paragraph edited on A.\n\nBeta paragraph.');

  /* ---- 3. meanwhile B edits other fields of the same records ---- */
  await goTo(b.page, 'Bookmarks');
  await menu(b.page, `Actions for ${names.bookmark}`, 'Edit');
  const editB = b.page.getByRole('dialog', { name: 'Edit bookmark' });
  await editB.getByLabel('Username').fill(`user-${s}`);
  await editB.getByRole('button', { name: 'Save' }).click();
  await expect(editB).toBeHidden();

  await goTo(b.page, 'Post-its');
  await postit(b.page, names.note).getByRole('button', { name: 'Pin', exact: true }).click();

  await goTo(b.page, 'Tasks');
  await b.page.getByRole('checkbox', { name: `Complete ${names.task}` }).check();

  const listB = await ensureShoppingList(b.page, names.list);
  await listB.getByRole('button', { name: `Edit ${names.item}` }).click();
  const sheet = b.page.getByRole('dialog', { name: 'Edit item' });
  await sheet.getByLabel('Quantity').fill('3');
  await sheet.getByRole('button', { name: 'Save' }).click();

  await b.page.goto(wikiPath);
  await b.page.getByRole('button', { name: 'Edit', exact: true }).click();
  await setWikiBody(b.page, 'Alpha paragraph.\n\nBeta paragraph edited on B.');
  await waitSynced(b.page);

  /* ---- 4. A reconnects: everything converges, nothing is lost ---- */
  await a.context.setOffline(false);
  await waitSynced(a.page, 60_000);
  await waitSynced(b.page, 60_000);

  // Polled until the server holds the merged record: both sides' fields, nothing lost.
  await serverRecord(
    a.page,
    'bookmarks',
    (r) => r.title === `${names.bookmark} (A)` && r.username === `user-${s}`,
  );
  await serverRecord(
    a.page,
    'postits',
    (r) => r.text === `${names.note} edited on A` && r.pinned === true,
  );
  await serverRecord(
    a.page,
    'tasks',
    (r) => r.title === `${names.task} renamed on A` && r.completedAt !== null,
  );
  await serverRecord(
    a.page,
    'shoppingItems',
    (r) => r.name === names.item && r.checked === true && r.quantity === '3',
  );
  for (const [collection, field, value] of [
    ['bookmarks', 'title', `Offline BM ${s}`],
    ['postits', 'text', `Offline note ${s}`],
    ['tasks', 'title', `Offline task ${s}`],
    ['shoppingItems', 'name', `offline item ${s}`],
  ] as const) {
    await serverRecord(a.page, collection, (r) => r[field] === value);
  }

  // Both devices show the converged state.
  for (const page of [a.page, b.page]) {
    await goTo(page, 'Bookmarks');
    await expect(page.getByRole('link', { name: `${names.bookmark} (A)` })).toBeVisible();
    await expect(page.getByRole('link', { name: `Offline BM ${s}` })).toBeVisible();
    await goTo(page, 'Post-its');
    await expect(postit(page, `${names.note} edited on A`)).toBeVisible();
    await expect(postit(page, `${names.note} edited on A`).getByLabel('Pinned')).toBeVisible();
    await expect(postit(page, `Offline note ${s}`)).toBeVisible();
    await goTo(page, 'Tasks');
    await expandGroup(page, 'Completed');
    await expect(
      page.getByRole('checkbox', { name: `Reopen ${names.task} renamed on A` }),
    ).toBeVisible();
    await expect(taskRow(page, `Offline task ${s}`)).toBeVisible();
    await page.goto(wikiPath);
    const view = page.locator('.wf-markdown').first();
    await expect(view.getByText('Alpha paragraph edited on A.')).toBeVisible();
    await expect(view.getByText('Beta paragraph edited on B.')).toBeVisible();
  }

  /* ---- 5. overlapping wiki edits: conflict on both, resolved once, converges ---- */
  await a.context.setOffline(true);
  await a.page.getByRole('button', { name: 'Edit', exact: true }).click();
  await setWikiBody(a.page, 'Alpha rewritten on A.\n\nBeta paragraph edited on B.');

  await b.page.getByRole('button', { name: 'Edit', exact: true }).click();
  await setWikiBody(b.page, 'Alpha rewritten on B.\n\nBeta paragraph edited on B.');
  await waitSynced(b.page);

  await a.context.setOffline(false);
  await waitSynced(a.page, 60_000);

  for (const page of [a.page, b.page]) {
    await page.goto(wikiPath);
    await expect(page.getByRole('alert').filter({ hasText: 'Edit conflict' })).toBeVisible({
      timeout: 30_000,
    });
  }

  await a.page
    .getByRole('alert')
    .filter({ hasText: 'Edit conflict' })
    .getByRole('button', { name: 'Keep mine' })
    .click();
  await waitSynced(a.page);

  for (const page of [a.page, b.page]) {
    await expect(page.getByRole('alert').filter({ hasText: 'Edit conflict' })).toBeHidden({
      timeout: 30_000,
    });
  }
  const [bodyA, bodyB] = await Promise.all(
    [a.page, b.page].map(async (page) => {
      await page.goto(wikiPath);
      return page.locator('.wf-markdown').first().innerText();
    }),
  );
  expect(bodyA).toBe(bodyB);
  expect(bodyA).toMatch(/Alpha rewritten on (A|B)\./);
  expect(bodyA).toContain('Beta paragraph edited on B.');

  a.guard.assertClean();
  b.guard.assertClean();
  await a.context.close();
  await b.context.close();
});
