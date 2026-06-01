import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { loadConfig } from '@alfred/shared'
import { app } from './app.js'

const config = loadConfig()

// Serve the built web client (production). In dev, Vite serves the page itself and
// proxies /api here, so these routes are unused. `root` is relative to the process
// cwd, which pm2 sets to the repo root (see ecosystem.config.cjs).
const webRoot = './clients/web/dist'
app.use('/*', serveStatic({ root: webRoot }))
app.get('*', serveStatic({ path: `${webRoot}/index.html` })) // SPA fallback

// Bind loopback only — the server sits behind `tailscale serve` (ARCHITECTURE §12).
serve({ fetch: app.fetch, hostname: '127.0.0.1', port: config.WEBSERVER_PORT }, (info) => {
  console.log(`alfred-webserver listening on http://127.0.0.1:${info.port}`)
})
