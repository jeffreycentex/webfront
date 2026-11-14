import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests (`npm run e2e`). Never part of `npm test`.
 *
 * `e2e/servers.mjs` builds the app and starts two production servers on their own ports with
 * fresh temporary data directories (never the dev server on 5173/8787 or its data):
 *   A  http://localhost:8799  the main instance every spec uses
 *   B  http://localhost:8798  an empty instance for "import into a fresh account"
 * Both are stopped and their data deleted when the run ends.
 *
 * Browsers: the installed Google Chrome (`channel: 'chrome'`); nothing is downloaded.
 * There is one account per server, so specs run serially, and `auth.spec.ts` (first-run setup)
 * runs first as a dependency of everything else.
 */

const PORT_A = Number(process.env.E2E_PORT_A ?? 8799);
const PORT_B = Number(process.env.E2E_PORT_B ?? 8798);
const BASE_A = `http://localhost:${PORT_A}`;

const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = process.env.E2E_CHROME_PATH
  ? { launchOptions: { executablePath: process.env.E2E_CHROME_PATH } }
  : existsSync(macChrome) || process.platform !== 'darwin'
    ? { channel: 'chrome' as const }
    : {};

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: {
    ...browser,
    baseURL: BASE_A,
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'en-GB',
    timezoneId: 'Europe/London',
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'], ...browser },
    },
    {
      name: 'desktop',
      testIgnore: [/auth\.spec\.ts$/, /phone\.spec\.ts$/],
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], ...browser },
    },
    {
      name: 'phone',
      testMatch: /phone\.spec\.ts$/,
      dependencies: ['setup'],
      use: { ...browser, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
    },
  ],
  webServer: {
    command: 'node e2e/servers.mjs',
    url: `${BASE_A}/api/health`,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: 'pipe',
    stderr: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    env: { E2E_PORT_A: String(PORT_A), E2E_PORT_B: String(PORT_B) },
  },
});
