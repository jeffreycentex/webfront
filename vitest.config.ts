import { defineConfig } from 'vitest/config';

// Each workspace has its own vitest.config.ts; `npm test` at the root runs them all.
export default defineConfig({
  test: {
    projects: ['packages/shared', 'apps/server', 'apps/web'],
  },
});
