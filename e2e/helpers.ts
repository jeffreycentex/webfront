import {
  expect,
  test as base,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';

/** Servers started by e2e/servers.mjs (see playwright.config.ts). */
export const BASE_A = `http://localhost:${process.env.E2E_PORT_A ?? 8799}`;
export const BASE_B = `http://localhost:${process.env.E2E_PORT_B ?? 8798}`;

/** The single account every spec signs in with (created by auth.spec.ts on server A). */
export const USER = { username: 'e2e-owner', password: 'correct horse battery staple' };

/** A short unique suffix so specs sharing one server never trip over each other's data. */
export const uid = () => Math.random().toString(36).slice(2, 7);

/**
 * Collects Content-Security-Policy violations; `assertClean()` fails the test if the strict CSP
 * sent by the server blocked anything the app needs.
 */
export function watchPage(page: Page) {
  const problems: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && /Content Security Policy|Refused to/i.test(msg.text())) {
      problems.push(`console: ${msg.text()}`);
    }
  });
  return {
    problems,
    assertClean() {
      expect(problems, problems.join('\n')).toEqual([]);
    },
  };
}

/** Contexts opened by `newDevice` in the running test (traced, closed by the fixture). */
const devices: Array<{ context: BrowserContext; label: string }> = [];

/**
 * Every test fails on CSP violations in its default page. Extra "devices" from `newDevice` are
 * traced (network, console, DOM snapshots: Playwright only traces the default context itself),
 * and their traces are saved next to the test's other artifacts, also when the test fails.
 */
export const test = base.extend<{ guard: void }>({
  guard: [
    async ({ page }, use, testInfo) => {
      const w = watchPage(page);
      await use();
      for (const d of devices.splice(0)) {
        await d.context.close().catch(() => undefined);
      }
      w.assertClean();
    },
    { auto: true },
  ],
});
export { expect };

/** Fill and submit the sign-in screen, then wait for the app chrome. */
export async function signIn(page: Page, base = BASE_A, user = USER) {
  await page.goto(`${base}/`);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Username').fill(user.username);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

/** First-run "create account" screen. */
export async function createAccount(page: Page, base = BASE_A, user = USER) {
  await page.goto(`${base}/`);
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  await page.getByLabel('Username').fill(user.username);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByLabel('Confirm password').fill(user.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

/** A new browser context (a separate "device"), signed in. */
export async function newDevice(
  browser: Browser,
  base = BASE_A,
  label = `${devices.length + 1}`,
): Promise<{ context: BrowserContext; page: Page; guard: ReturnType<typeof watchPage> }> {
  const context = await browser.newContext({ baseURL: base, serviceWorkers: 'allow' });
  // Playwright's own `trace` setting already records contexts made with browser.newContext.
  devices.push({ context, label });
  const page = await context.newPage();
  const guard = watchPage(page);
  await signIn(page, base);
  return { context, page, guard };
}

/** The sync indicator in the header (`aria-label="Sync status: <state>. Press to sync now."`). */
export function syncButton(page: Page): Locator {
  return page.getByRole('button', { name: /^Sync status:/ });
}

/** Wait until this device has nothing left to upload and the last sync succeeded. */
export async function waitSynced(page: Page, timeout = 30_000) {
  await expect(syncButton(page)).toHaveAttribute('aria-label', /Sync status: Synced\./, {
    timeout,
  });
}

/** Navigate inside the app with the sidebar/tab bar (keeps the SPA and its sync loop alive). */
export async function goTo(page: Page, label: string) {
  const link = page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: label, exact: true });
  await link.click();
  // Routes are lazy: the old page stays on screen until the new chunk has loaded, and the URL
  // and the active nav entry change in the same commit as the new page. Without this wait a
  // locator can resolve against the old page (e.g. the dashboard's "New post-it" widget).
  await expect(link).toHaveAttribute('aria-current', 'page');
}

/** Open a row's "…" menu and pick an item. */
export async function menu(page: Page, trigger: string | RegExp, item: string) {
  await page.getByRole('button', { name: trigger }).first().click();
  await page.getByRole('menuitem', { name: item }).click();
}

/** Click the Undo action of the most recent toast. */
export async function undo(page: Page) {
  await page.getByRole('button', { name: 'Undo' }).last().click();
}

/** The CodeMirror editor of the wiki page being edited. */
export function wikiEditor(page: Page): Locator {
  return page.locator('.cm-content').first();
}

/** Replace the whole wiki body (as typed text, so autosave and merges behave as for a user). */
export async function setWikiBody(page: Page, text: string) {
  const editor = wikiEditor(page);
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  // insertText: no auto-closed brackets and no autocomplete popup getting in the way.
  await page.keyboard.insertText(text);
  // Autosave runs ~700 ms after the last keystroke; the indicator says "Saved" before typing
  // too, so give the debounce time to fire before trusting it.
  await page.waitForTimeout(1_200);
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
}

/**
 * Create a top-level wiki page through the "New wiki page" dialog; lands in the editor. Uses the
 * page tree's "New top-level page" button (desktop), which exists whether or not the wiki is
 * empty (the home view shows "Create a Home page" instead of "New page" when it is).
 */
export async function createWikiPage(page: Page, title: string) {
  await goTo(page, 'Wiki');
  await page.getByRole('button', { name: 'New top-level page' }).click();
  const dialog = page.getByRole('dialog', { name: 'New wiki page' });
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByRole('button', { name: 'Create page' }).click();
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
  await expect(wikiEditor(page)).toBeVisible();
}

/** Create a shopping list if none with this name exists; returns its panel. */
export async function ensureShoppingList(page: Page, name: string): Promise<Locator> {
  await goTo(page, 'Shopping');
  const panel = page.getByRole('region', { name });
  const first = page.getByRole('button', { name: 'Create your first list' });
  // Wait for the lists to load (skeletons are aria-busy) before deciding to create one.
  await expect(page.getByRole('heading', { name: 'Shopping', level: 1 })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  if (await panel.count()) {
    await closeSuggestions(page);
    return panel;
  }
  if (await first.isVisible()) await first.click();
  else await page.getByRole('button', { name: 'New list' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New shopping list' });
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('region', { name })).toBeVisible();
  await closeSuggestions(page);
  return page.getByRole('region', { name });
}

/**
 * Move focus out of a shopping quick-add box. While it has focus it shows its "Suggestions"
 * popup (favourites even for an empty box, by design), which covers the first rows of the
 * list, so a click aimed at an item would land on a suggestion. A user clicks elsewhere first;
 * the test does the same by blurring the box.
 */
export async function closeSuggestions(page: Page) {
  await page.evaluate(() => {
    const el = document.activeElement;
    if (el instanceof HTMLElement && el.getAttribute('role') === 'combobox') el.blur();
  });
  await expect(page.getByRole('listbox', { name: 'Suggestions' })).toHaveCount(0);
}

/** Add a bookmark through the form. URLs should point at hosts that fail fast (no internet). */
export async function addBookmark(
  page: Page,
  values: { url: string; title: string; username?: string; hint?: string; notes?: string },
) {
  await goTo(page, 'Bookmarks');
  await page.getByRole('button', { name: 'Bookmark', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New bookmark' });
  await dialog.getByLabel('Address').fill(values.url);
  await dialog.getByLabel('Title').fill(values.title);
  if (values.username) await dialog.getByLabel('Username').fill(values.username);
  if (values.hint) await dialog.getByLabel('Hint').fill(values.hint);
  if (values.notes) await dialog.getByLabel('Notes').fill(values.notes);
  await dialog.getByRole('button', { name: 'Add bookmark' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('link', { name: values.title })).toBeVisible();
}

/**
 * Expand a collapsible group ("Completed" tasks, "In the trolley") if it is collapsed. The
 * group is a region named `name` whose toggle button's text starts with the same words.
 */
export async function expandGroup(scope: Page | Locator, name: string) {
  const toggle = scope
    .getByRole('region', { name })
    .getByRole('button', { name: new RegExp(`^${name}`) })
    .first();
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

/** A post-it card by (part of) its text. */
export function postit(page: Page, text: string): Locator {
  return page.locator('[data-postit-id]').filter({ hasText: text });
}

/** A task row by (part of) its title. */
export function taskRow(page: Page, title: string): Locator {
  return page.locator('[data-task-id]').filter({ hasText: title });
}

/**
 * Today's date in the browser's time zone as YYYY-MM-DD (the tests pin `timezoneId`), plus an
 * offset in days.
 */
export function isoDay(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
