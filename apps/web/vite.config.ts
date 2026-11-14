import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const serverPort = process.env.PORT ?? '8787';

export default defineConfig({
  resolve: {
    alias: {
      // Use shared's TypeScript source directly (no build step in dev or for the web build).
      '@webfront/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // "Update available, reload" prompt (src/app/UpdatePrompt.tsx) instead of silent takeover.
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['icon.svg', 'favicon-32.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'Webfront',
        short_name: 'Webfront',
        description: 'Personal homepage: bookmarks, notes, tasks, calendar and wiki',
        id: '/',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#f5f3ee',
        theme_color: '#f5f3ee',
        categories: ['productivity', 'utilities'],
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: '/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
        shortcuts: [
          {
            name: 'Bookmarks',
            url: '/bookmarks',
            icons: [{ src: '/icon-192.png', sizes: '192x192' }],
          },
          { name: 'To-do', url: '/tasks', icons: [{ src: '/icon-192.png', sizes: '192x192' }] },
        ],
      },
      workbox: {
        // App shell and every build asset (hashed JS/CSS chunks, icons) are precached.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2,webmanifest}'],
        globIgnores: ['**/*.map'],
        // Chunks of the larger features (editor, markdown) can exceed the 2 MiB default.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        // SPA navigation fallback, but never for the API or for URLs that look like files.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [
          /^\/api\//,
          /^[^?]*\.(?:js|mjs|css|map|json|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|txt|xml|webmanifest)(?:\?.*)?$/i,
        ],
        // Do not take over open tabs until the user accepts the update prompt.
        skipWaiting: false,
        clientsClaim: false,
        runtimeCaching: [
          {
            // Favicons are immutable enough: serve cached, refresh in the background.
            urlPattern: ({ url, request }) =>
              request.method === 'GET' && url.pathname.startsWith('/api/favicons'),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'wf-favicons',
              expiration: {
                maxEntries: 600,
                maxAgeSeconds: 60 * 60 * 24 * 30,
                purgeOnQuotaError: true,
              },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            // Wiki images pasted as attachments: viewable offline once seen.
            urlPattern: ({ url, request }) =>
              request.method === 'GET' && url.pathname.startsWith('/api/attachments/'),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'wf-attachments',
              expiration: {
                maxEntries: 300,
                maxAgeSeconds: 60 * 60 * 24 * 60,
                purgeOnQuotaError: true,
              },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Dev: the API runs on the Node server. SSE (/api/sync/events) passes through as well.
      '/api': { target: `http://127.0.0.1:${serverPort}`, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
