import { BASE_A, USER, createAccount, expect, menu, signIn, test } from './helpers';

/**
 * Scenario 1: first-run setup, sign out, sign in, wrong password, and the API refusing a
 * signed-out client. Runs first (the `setup` project): every other spec signs in with USER.
 */
test.describe.configure({ mode: 'serial' });

test('the shell is served with the security headers', async ({ request }) => {
  const res = await request.get('/');
  expect(res.status()).toBe(200);
  const h = res.headers();
  expect(h['content-security-policy']).toContain("script-src 'self'");
  expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['referrer-policy']).toBe('no-referrer');
  expect(h['x-content-type-options']).toBe('nosniff');
  const html = await res.text();
  expect(html).not.toMatch(/<script>(?!\s*<\/script>)/);
});

test('first-run setup creates the account and signs in', async ({ page }) => {
  await createAccount(page);
  // Setup happens once: the API now refuses a second account.
  const again = await page.request.post('/api/auth/setup', {
    data: { username: 'intruder', password: 'another long password' },
    headers: { origin: BASE_A },
  });
  expect(again.status()).toBe(409);
});

test('sign out, wrong password, sign in; the API is closed while signed out', async ({ page }) => {
  await signIn(page);
  expect((await page.request.get('/api/sync/pull?since=0')).status()).toBe(200);

  await menu(page, 'Account', 'Sign out');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  expect((await page.request.get('/api/sync/pull?since=0')).status()).toBe(401);
  expect((await page.request.get('/api/sync/events')).status()).toBe(401);

  await page.getByLabel('Username').fill(USER.username);
  await page.getByLabel('Password', { exact: true }).fill('not the password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: /wrong username or password/i }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  expect((await page.request.get('/api/sync/pull?since=0')).status()).toBe(401);

  await page.getByLabel('Password', { exact: true }).fill(USER.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  expect((await page.request.get('/api/sync/pull?since=0')).status()).toBe(200);
});

test('a cross-site request cannot use the session', async ({ page }) => {
  await signIn(page);
  const res = await page.request.get('/api/sync/pull?since=0', {
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  expect(res.status()).toBe(403);
  const post = await page.request.post('/api/auth/logout', {
    headers: { origin: 'https://evil.example' },
  });
  expect(post.status()).toBe(403);
});
