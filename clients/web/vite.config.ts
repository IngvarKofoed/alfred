import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Web Push: we own the service worker (src/service-worker.ts) and only need
    // vite-plugin-pwa to compile + register it (injectManifest), not to generate caching
    // strategies. The SW handles `push`/`notificationclick` for autonomous-watcher
    // notifications (spec 2026-06-16). autoUpdate so a new SW activates without a prompt.
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'service-worker.ts',
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      // The SW is a notification doorbell, not an offline cache — keep the precache tiny.
      injectManifest: {
        globPatterns: ['**/*.{js,css,html}'],
      },
      manifest: {
        name: 'Alfred',
        short_name: 'Alfred',
        description: 'Your personal AI agent, at your service.',
        theme_color: '#1b1714',
        background_color: '#1b1714',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
      devOptions: {
        // Allow exercising the SW (push) against `vite dev`.
        enabled: true,
        type: 'module',
      },
    }),
  ],
  server: {
    // Dev: proxy API calls to the Hono webserver so the page's /api/health works
    // without any front proxy. Prod: Hono serves this client's built dist directly.
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      // Workspace images (<img src="/media/...">) are served by the Hono server too.
      '/media': 'http://127.0.0.1:3000',
    },
  },
  build: {
    outDir: 'dist',
  },
})
