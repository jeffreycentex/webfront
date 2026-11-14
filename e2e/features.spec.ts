import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  BASE_B,
  addBookmark,
  createAccount,
  closeSuggestions,
  createWikiPage,
  ensureShoppingList,
  expandGroup,
  expect,
  goTo,
  menu,
  postit,
  setWikiBody,
  signIn,
  taskRow,
  test,
  uid,
  undo,
  waitSynced,
  watchPage,
  wikiEditor,
} from './helpers';

/** Scenario 4: one smoke test per feature. All data is suffixed so specs never collide. */

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test('bookmarks: create, reveal the masked hint, edit, delete and undo', async ({ page }) => {
  const s = uid();
  const title = `Router ${s}`;
  await addBookmark(page, {
    // Port 9 (discard) refuses fast: favicon and title lookups never leave the machine.
    url: `http://127.0.0.1:9/router-${s}`,
    title,
    username: 'admin',
    hint: `sticker on the back ${s}`,
  });

  // The hint is masked until revealed, and never part of the row.
  await expect(page.getByText(`sticker on the back ${s}`)).toHaveCount(0);
  await page.getByRole('button', { name: `Details for ${title}` }).click();
  const hint = page.getByTestId('hint');
  await expect(hint).not.toContainText('sticker');
  await page.getByRole('button', { name: 'Reveal' }).click();
  await expect(hint).toHaveText(`sticker on the back ${s}`);
  await page.getByRole('button', { name: 'Hide' }).click();
  await expect(hint).not.toContainText('sticker');
  await page.keyboard.press('Escape');

  // Edit.
  await menu(page, `Actions for ${title}`, 'Edit');
  const dialog = page.getByRole('dialog', { name: 'Edit bookmark' });
  await dialog.getByLabel('Title').fill(`${title} edited`);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('link', { name: `${title} edited` })).toBeVisible();

  // The row is a real link that opens in a new tab without an opener or referrer.
  const link = page.getByRole('link', { name: `${title} edited` });
  await expect(link).toHaveAttribute('href', `http://127.0.0.1:9/router-${s}`);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);

  // Delete, then undo.
  await menu(page, `Actions for ${title} edited`, 'Delete');
  await expect(page.getByRole('link', { name: `${title} edited` })).toHaveCount(0);
  await undo(page);
  await expect(page.getByRole('link', { name: `${title} edited` })).toBeVisible();
});

test('post-its: create, edit, archive and undo', async ({ page }) => {
  const s = uid();
  await goTo(page, 'Post-its');
  const box = page.getByRole('textbox', { name: 'New post-it' });
  await box.fill(`Call the plumber ${s}`);
  await box.press('Enter');
  const card = postit(page, `Call the plumber ${s}`);
  await expect(card).toBeVisible();

  await card.getByRole('button', { name: 'Edit note' }).click();
  const text = page.getByRole('textbox', { name: 'Note text' });
  await text.fill(`Call the plumber ${s} at 9 https://example.com/plumber`);
  await text.press('Escape');
  const edited = postit(page, `${s} at 9`);
  await expect(edited).toBeVisible();
  // Auto-linked, opening safely in a new tab.
  const link = edited.getByRole('link', { name: 'https://example.com/plumber' });
  await expect(link).toHaveAttribute('rel', /noopener/);

  await edited.getByRole('button', { name: 'Archive' }).click();
  await expect(postit(page, `Call the plumber ${s}`)).toHaveCount(0);
  await undo(page);
  await expect(postit(page, `Call the plumber ${s}`)).toBeVisible();
});

test('tasks: natural-language due date, complete, delete and undo', async ({ page }) => {
  const s = uid();
  await goTo(page, 'Tasks');
  const box = page.getByRole('textbox', { name: 'New task' });
  await box.fill(`pay rent ${s} tomorrow`);
  // The recognised date shows as a chip before saving.
  await expect(page.getByTestId('due-chip')).toContainText('Tomorrow');
  await box.press('Enter');
  const row = taskRow(page, `pay rent ${s}`);
  await expect(row).toBeVisible();
  await expect(row).toContainText('Tomorrow');
  await expect(row.getByRole('button', { name: `pay rent ${s}`, exact: true })).toBeVisible();

  // Completing moves the row into the collapsed "Completed" group and relabels its checkbox
  // ("Reopen …"), so click rather than `.check()` and assert on the new row below.
  await page.getByRole('checkbox', { name: `Complete pay rent ${s}` }).click();
  // Completed tasks collapse into their own group.
  await expandGroup(page, 'Completed');
  await expect(page.getByRole('checkbox', { name: `Reopen pay rent ${s}` })).toBeChecked();

  await page.getByRole('button', { name: `Delete pay rent ${s}` }).click();
  await expect(taskRow(page, `pay rent ${s}`)).toHaveCount(0);
  await undo(page);
  await expect(taskRow(page, `pay rent ${s}`)).toBeVisible();
});

test('shopping: quantity parsing, check off, clear checked and undo', async ({ page }) => {
  const s = uid();
  const list = await ensureShoppingList(page, `Groceries ${s}`);
  const add = list.getByRole('combobox', { name: 'Add item' });
  await add.fill(`2 oat milk ${s}`);
  await add.press('Enter');
  await add.fill(`eggs ${s} x6`);
  await add.press('Enter');
  await closeSuggestions(page);

  const milk = list.getByRole('checkbox', { name: new RegExp(`^Oat milk ${s}`) });
  const eggs = list.getByRole('checkbox', { name: new RegExp(`^Eggs ${s}`) });
  await expect(milk).toBeVisible();
  // "2 oat milk" is stored as name "Oat milk" (all-lower-case input is capitalised) with
  // quantity 2.
  await expect(milk).toContainText('2');
  await expect(milk).not.toContainText(/2 oat milk/i);
  await expect(eggs).toContainText('6');

  // Checking an item moves it into the (collapsed) "In the trolley" group.
  await milk.click();
  await expect(milk).toHaveCount(0);
  await expandGroup(list, 'In the trolley');
  const trolley = list.getByRole('region', { name: 'In the trolley' });
  await expect(
    trolley.getByRole('checkbox', { name: new RegExp(`^Oat milk ${s}`) }),
  ).toHaveAttribute('aria-checked', 'true');

  await list.getByRole('button', { name: 'Clear checked' }).click();
  await expect(list.getByRole('checkbox', { name: new RegExp(`^Oat milk ${s}`) })).toHaveCount(0);
  await expect(eggs).toBeVisible();
  await undo(page);
  await expandGroup(list, 'In the trolley');
  await expect(list.getByRole('checkbox', { name: new RegExp(`^Oat milk ${s}`) })).toBeVisible();
});

test('wiki: create a page, a wiki link creates the target, the backlink appears', async ({
  page,
}) => {
  const s = uid();
  const home = `E2E Home ${s}`;
  const target = `E2E Target ${s}`;
  await createWikiPage(page, home);
  await setWikiBody(page, `Start here. See [[${target}]] for more.\n\n<script>alert(1)</script>`);

  // Read mode: the raw HTML is shown as text, never run; the missing link creates the page.
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  const view = page.locator('.wf-markdown').first();
  await expect(view.locator('script')).toHaveCount(0);
  await view.getByRole('link', { name: target }).click();
  await expect(page.getByRole('heading', { name: target, level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/wiki\/e2e-target-/);
  // A page created from a link opens in the editor...
  await expect(wikiEditor(page)).toBeVisible();

  // ...and backlinks ("Linked from") are part of the reading view.
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  const backlinks = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: /Linked from/ }) })
    .last(); // the innermost section (the panel), not an enclosing one
  await expect(backlinks.getByRole('link', { name: home })).toBeVisible();
});

test('calendar: an ICS feed from a local server shows its events in the agenda', async ({
  page,
}) => {
  const s = uid();
  const day = new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '');
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//webfront//e2e//EN',
    'BEGIN:VEVENT',
    `UID:e2e-${s}@webfront.test`,
    'DTSTAMP:20260101T000000Z',
    `DTSTART:${day}T100000Z`,
    `DTEND:${day}T110000Z`,
    `SUMMARY:Dentist ${s}`,
    'LOCATION:Main Street 1',
    'DESCRIPTION:Bring <b>the card</b> https://example.com/dentist',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
  let fetched = 0;
  const server: Server = createServer((req, res) => {
    fetched++;
    res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8' });
    res.end(ics);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  try {
    await goTo(page, 'Calendar');
    const empty = page.getByRole('button', { name: 'Add calendar feed' });
    const options = page.getByRole('button', { name: 'Calendar options' });
    await expect(options).toBeVisible();
    await expect(empty.or(page.getByRole('list', { name: 'Calendars' }))).toBeVisible();
    if (await empty.isVisible()) {
      await empty.click();
    } else {
      await menu(page, 'Calendar options', 'Manage feeds…');
      await page.getByRole('button', { name: 'Add feed' }).click();
    }
    const modal = page.getByRole('dialog', { name: 'Calendar feeds' });
    await modal.getByLabel('Name').fill(`E2E calendar ${s}`);
    await modal.getByLabel('ICS link').fill(`http://127.0.0.1:${port}/feed-${s}.ics`);
    await modal.getByRole('button', { name: 'Add feed' }).click();
    await expect(modal.getByText(`E2E calendar ${s}`)).toBeVisible();
    await page.keyboard.press('Escape');

    // The server fetches the feed, expands it and syncs the events down.
    const event = page.getByRole('button', { name: new RegExp(`Dentist ${s}`) });
    await expect(event).toBeVisible({ timeout: 45_000 });
    expect(fetched).toBeGreaterThan(0);

    // Description HTML is reduced to text; links are http(s) only and open safely.
    await event.click();
    await expect(page.getByText('Main Street 1').last()).toBeVisible();
    const link = page.getByRole('link', { name: 'https://example.com/dentist' });
    await expect(link).toHaveAttribute('rel', /noopener/);
    await expect(page.locator('b', { hasText: 'the card' })).toHaveCount(0);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('dashboard search: finds a bookmark; no match goes to the web search engine', async ({
  page,
}) => {
  const s = uid();
  const title = `Zettelkasten ${s}`;
  const url = `http://127.0.0.1:9/zk-${s}`;
  await addBookmark(page, { url, title });

  // Leaving the app is intercepted: nothing reaches the network.
  const opened: string[] = [];
  await page.context().route(/^https?:\/\/(127\.0\.0\.1:9|duckduckgo\.com)\//, async (route) => {
    if (route.request().isNavigationRequest()) opened.push(route.request().url());
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>intercepted</p>' });
  });

  await goTo(page, 'Home');
  const search = page.getByRole('combobox', { name: 'Search your pages or the web' });
  await search.fill(`zettelkasten ${s}`);
  await expect(page.getByRole('option', { name: new RegExp(title) })).toBeVisible();
  await search.press('Enter');
  await expect.poll(() => opened).toContain(url);

  await page.goBack();
  await expect(page.getByRole('combobox', { name: 'Search your pages or the web' })).toBeVisible();
  const again = page.getByRole('combobox', { name: 'Search your pages or the web' });
  await again.fill(`nothing-matches-${s}`);
  await expect(page.getByRole('option', { name: /Search the web for/ })).toBeVisible();
  await again.press('Enter');
  await expect.poll(() => opened).toContain(`https://duckduckgo.com/?q=nothing-matches-${s}`);
});

test('settings: export, then import into a fresh account on another server', async ({
  page,
  browser,
}) => {
  const s = uid();
  const title = `Exported ${s}`;
  await addBookmark(page, { url: `http://127.0.0.1:9/exported-${s}`, title });
  await waitSynced(page);

  await goTo(page, 'Settings');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export everything' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^webfront-export-\d{4}-\d{2}-\d{2}\.json$/);
  const file = await download.path();
  expect(file).toBeTruthy();

  // Server B is empty: create its (first and only) account, then import.
  const context = await browser.newContext({ baseURL: BASE_B });
  const pageB = await context.newPage();
  const guardB = watchPage(pageB);
  await createAccount(pageB, BASE_B);
  await goTo(pageB, 'Settings');
  await pageB.getByLabel('Import file').setInputFiles(file!);
  const summary = pageB.getByLabel('Import summary');
  await expect(summary).toBeVisible();
  await summary.getByRole('button', { name: /^Import \d+ records$/ }).click();
  await expect(pageB.getByText(/^Imported \d+ records?$/)).toBeVisible();

  await goTo(pageB, 'Bookmarks');
  await expect(pageB.getByRole('link', { name: title })).toBeVisible();
  await waitSynced(pageB);
  const pulled = await pageB.request.get('/api/sync/pull?since=0&limit=2000');
  expect(await pulled.text()).toContain(title);
  guardB.assertClean();
  await context.close();
});
