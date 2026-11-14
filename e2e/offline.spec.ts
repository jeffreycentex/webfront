import { expect, goTo, newDevice, postit, test, uid, waitSynced } from './helpers';

/**
 * Scenario 3: the service worker. After one online load the app shell loads with the server
 * unreachable and shows local data; an edit made then syncs after reconnecting.
 * (Service workers need a secure context; http://localhost qualifies.)
 */
test('the app shell and local data load without the server; edits sync later', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const s = uid();
  const { context, page, guard } = await newDevice(browser);

  // Local data to look for later.
  await goTo(page, 'Post-its');
  const box = page.getByRole('textbox', { name: 'New post-it' });
  await box.fill(`Before offline ${s}`);
  await box.press('Enter');
  await expect(postit(page, `Before offline ${s}`)).toBeVisible();
  await waitSynced(page);

  // The service worker installs on the first load; it controls the page after a reload.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
  // Precaching finished: the shell is in Cache Storage.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const names = await caches.keys();
        return names.some((n) => n.includes('precache'));
      }),
    )
    .toBe(true);

  // Server unreachable: every network request fails.
  await context.setOffline(true);
  await page.goto('/postits');
  await expect(page.getByRole('heading', { name: 'Post-its', level: 1 })).toBeVisible();
  await expect(postit(page, `Before offline ${s}`)).toBeVisible();
  await expect(page.getByRole('button', { name: /^Sync status: Offline/ })).toBeVisible();

  // An edit while the server is unreachable stays local...
  const offlineBox = page.getByRole('textbox', { name: 'New post-it' });
  await offlineBox.fill(`Written offline ${s}`);
  await offlineBox.press('Enter');
  await expect(postit(page, `Written offline ${s}`)).toBeVisible();
  await expect(page.getByRole('button', { name: /^Sync status: Offline · \d+/ })).toBeVisible();

  // ...and reaches the server after reconnecting.
  await context.setOffline(false);
  await waitSynced(page, 60_000);
  await expect
    .poll(async () => {
      const res = await page.request.get('/api/sync/pull?since=0&limit=2000');
      return (await res.text()).includes(`Written offline ${s}`);
    })
    .toBe(true);

  guard.assertClean();
  await context.close();
});

test('API responses are never served from the service worker cache except images', async ({
  page,
}) => {
  // Static check of the generated worker: only favicons and attachments have runtime routes.
  const sw = await (await page.request.get('/sw.js')).text();
  expect(sw).toContain('wf-favicons');
  expect(sw).toContain('wf-attachments');
  expect(sw).not.toMatch(/\/api\/sync/);
  expect(sw).not.toMatch(/\/api\/auth/);
});
