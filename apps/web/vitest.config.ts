import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@webfront/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    name: 'web',
    // Switch individual files to a DOM environment with a `// @vitest-environment` comment
    // once a DOM library is added; the scaffold's tests are pure logic.
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
