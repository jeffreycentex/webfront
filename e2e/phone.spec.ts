import { expect, signIn, test, uid } from './helpers';

/** Scenario 5: phone viewport (390x844, touch). Runs in the `phone` project. */

test('the bottom tab bar puts Home, Shopping, Tasks and Bookmarks first', async ({ page }) => {
  await signIn(page);
  const tabs = page.getByRole('navigation', { name: 'Main' });
  await expect(tabs).toBeInViewport();
  const box = await tabs.boundingBox();
  const viewport = page.viewportSize()!;
  // A bottom bar, not a sidebar.
  expect(box!.y + box!.height).toBeGreaterThan(viewport.height - 100);
  expect(box!.width).toBeGreaterThan(viewport.width - 2);

  const labels = (
    await tabs
      .locator(':scope > a, :scope > button, :scope button[aria-label="More"]')
      .allInnerTexts()
  )
    .map((t) => t.replace(/\d+/g, '').trim())
    .filter(Boolean);
  expect(labels).toEqual(['Home', 'Shopping', 'Tasks', 'Bookmarks', 'More']);

  // The rest of the sections are under "More".
  await tabs.getByRole('button', { name: 'More' }).click();
  for (const name of ['Post-its', 'Calendar', 'Wiki', 'Settings']) {
    await expect(page.getByRole('menuitem', { name })).toBeVisible();
  }
  await page.keyboard.press('Escape');
});

test('shopping quick add is reachable and adds with one tap', async ({ page }) => {
  const s = uid();
  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Shopping' })
    .tap();
  // Routes are lazy: wait until the Shopping page has replaced the dashboard, whose
  // shopping widget has an "Add item" box of its own that would otherwise match and vanish.
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Shopping' }),
  ).toHaveAttribute('aria-current', 'page');

  const first = page.getByRole('button', { name: 'Create your first list' });
  const add = page.getByRole('combobox', { name: 'Add item' }).first();
  await expect(first.or(add)).toBeVisible(); // lists loaded (either state)
  if (await first.isVisible()) {
    await first.tap();
    const dialog = page.getByRole('dialog', { name: 'New shopping list' });
    await dialog.getByLabel('Name').fill(`Phone list ${s}`);
    await dialog.getByRole('button', { name: 'Create' }).tap();
  }

  await expect(add).toBeInViewport();
  const box = await add.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(40); // phone-sized touch target
  await add.tap();
  await add.fill(`3 Apples ${s}`);
  await page.getByRole('button', { name: 'Add', exact: true }).first().tap();
  const item = page.getByRole('checkbox', { name: new RegExp(`^Apples ${s}`) });
  await expect(item).toBeVisible();
  await expect(item).toContainText('3');
  const itemBox = await item.boundingBox();
  expect(itemBox!.height).toBeGreaterThanOrEqual(40);
});
