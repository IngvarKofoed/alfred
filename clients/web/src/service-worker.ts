/// <reference lib="webworker" />

// Alfred's Web Push service worker (spec 2026-06-16 autonomous watchers). It is a thin
// notification *doorbell*: a watcher fires somewhere off-screen → the webserver pushes a tiny
// { title, body, deepLink } payload → this SW shows a system notification → tapping it deep-links
// into the existing /conversation/:id, where the full result and approval card already render
// over normal SSE/REST. No app content lives here.
//
// Built via vite-plugin-pwa `injectManifest`: we own this file; the plugin only compiles +
// registers it. We don't precache app shell (this is a doorbell, not an offline cache).
//
// Typing note: the web tsconfig includes the DOM lib (it's a shared project config), so the
// ambient `self` is typed as `Window`. We can't redeclare it, so we alias it once to the
// service-worker scope (`/// <reference lib="webworker" />` above provides the worker types) and
// use `sw` for every worker-only API. The runtime `self` is the worker scope regardless.

const sw = self as unknown as ServiceWorkerGlobalScope

// vite-plugin-pwa's injectManifest requires the literal token `self.__WB_MANIFEST` to survive
// verbatim into the COMPILED service worker (it splices the precache list in at that exact
// string — so the alias `sw` won't do, and a tree-shakeable bare reference gets dropped before
// workbox sees it). We stash it on a global property: the assignment is an observable side effect
// the bundler cannot elide, keeping the literal `self.__WB_MANIFEST` in the output without
// pulling in workbox-precaching. We don't actually precache (this is a doorbell, see header).
;(self as unknown as { __alfredPrecache?: unknown; __WB_MANIFEST: unknown }).__alfredPrecache =
  (self as unknown as { __WB_MANIFEST: unknown }).__WB_MANIFEST

// Activate immediately on update (autoUpdate registration), so a new SW version takes over
// without waiting for every tab to close.
sw.addEventListener('install', () => {
  void sw.skipWaiting()
})
sw.addEventListener('activate', (event) => {
  event.waitUntil(sw.clients.claim())
})

// The push payload contract is byte-identical to agent-core's NotificationPayload, which
// WebPushNotifier sends verbatim. Keep field names exact (deepLink camelCase).
type PushPayload = {
  title: string
  body?: string
  deepLink: string
}

sw.addEventListener('push', (event: PushEvent) => {
  // No payload (or unparseable) → nothing to show. Fail quiet, not loud, in the SW.
  let data: PushPayload | null = null
  try {
    data = (event.data?.json() as PushPayload | undefined) ?? null
  } catch {
    data = null
  }
  // Observability: Web Push is opaque — these logs (in the SW's own console) confirm the push
  // actually reached the SW and whether showNotification succeeded, so a "sent but not shown" gap
  // can be pinned to delivery vs. display. Low-noise (only on a real push).
  console.log('[sw] push received', { hasData: Boolean(event.data), title: data?.title ?? null })
  if (!data?.title) {
    console.warn('[sw] push had no usable payload (no title); nothing to show')
    return
  }

  const { title, body, deepLink } = data
  event.waitUntil(
    // XSS-safe: showNotification renders `title`/`body` as browser-sanitized text, never HTML.
    // Tag by deep-link so repeated pushes about the same conversation collapse rather than stack.
    sw.registration
      .showNotification(title, {
        body,
        tag: deepLink,
        data: { deepLink },
        icon: '/icon.svg',
        badge: '/icon.svg',
      })
      .then(() => console.log('[sw] showNotification ok:', title))
      .catch((err) => console.error('[sw] showNotification failed:', err)),
  )
})

sw.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close()

  const deepLink = (event.notification.data as { deepLink?: string } | null)?.deepLink ?? '/'
  // Resolve against the SW's origin so we always match/open same-origin clients.
  const targetUrl = new URL(deepLink, sw.location.origin).href
  const targetPath = new URL(targetUrl).pathname

  event.waitUntil(
    (async () => {
      const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true })
      // Prefer focusing an already-open tab already on the target path.
      for (const client of windows) {
        if (new URL(client.url).pathname === targetPath) {
          await client.focus()
          return
        }
      }
      // Otherwise reuse any open Alfred window (navigate it there), else open a fresh one.
      // navigate() rejects on an uncontrolled window (matchAll uses includeUncontrolled:true), so
      // guard it and fall through to openWindow on rejection rather than dropping the click.
      const existing = windows[0]
      if (existing) {
        try {
          const navigated = await existing.navigate(targetUrl)
          await (navigated ?? existing).focus()
          return
        } catch {
          // Window not controllable — fall through to opening a fresh one below.
        }
      }
      await sw.clients.openWindow(targetUrl)
    })(),
  )
})
