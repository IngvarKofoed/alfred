// Web Push client helpers (spec 2026-06-16 autonomous watchers). The Settings page calls these
// to opt the browser in/out of watcher notifications. The flow:
//   enable  → request permission → fetch the VAPID public key → subscribe via pushManager
//             → POST the subscription to the webserver (stored in push_subscriptions)
//   disable → unsubscribe locally → POST /api/push/unsubscribe so the dead row is pruned
// The actual push payload + service-worker handling live in service-worker.ts.

// Whether Web Push is even possible in this browser (Notification + SW + PushManager).
export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window
  )
}

export type PushState = {
  supported: boolean
  permission: NotificationPermission // 'default' | 'granted' | 'denied'
  subscribed: boolean
}

// Read the current permission + whether this browser holds a live push subscription.
export async function getPushState(): Promise<PushState> {
  if (!pushSupported()) {
    return { supported: false, permission: 'denied', subscribed: false }
  }
  let subscribed = false
  try {
    const reg = await navigator.serviceWorker.ready
    subscribed = (await reg.pushManager.getSubscription()) != null
  } catch {
    subscribed = false
  }
  return { supported: true, permission: Notification.permission, subscribed }
}

// Opt this browser in. Returns the resulting state; throws on a hard failure (network, missing
// VAPID key) so the caller can surface it. A denied permission resolves (not throws) with the
// denied state so the UI can explain the browser block.
export async function enableNotifications(): Promise<PushState> {
  if (!pushSupported()) throw new Error('Web Push is not supported in this browser.')

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    return { supported: true, permission, subscribed: false }
  }

  const publicKey = await fetchVapidPublicKey()
  const reg = await navigator.serviceWorker.ready

  // Reuse an existing subscription if present (idempotent re-enable), else create one.
  let sub = await reg.pushManager.getSubscription()
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      // The Push API accepts a string or BufferSource; pass the decoded key's underlying
      // ArrayBuffer (the Uint8Array<ArrayBufferLike> typing doesn't narrow to BufferSource).
      applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
    })
  }

  await postSubscription(sub)
  return { supported: true, permission, subscribed: true }
}

// Opt this browser out: drop the local subscription and tell the server to prune the row.
export async function disableNotifications(): Promise<PushState> {
  if (!pushSupported()) return { supported: false, permission: 'denied', subscribed: false }

  try {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    if (sub) {
      // Tell the server first (we still have the endpoint), then unsubscribe locally.
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => {})
      await sub.unsubscribe()
    }
  } catch {
    // best-effort
  }
  return { supported: true, permission: Notification.permission, subscribed: false }
}

async function fetchVapidPublicKey(): Promise<string> {
  const r = await fetch('/api/push/vapid-public-key')
  if (!r.ok) throw new Error(`Could not fetch the VAPID key (${r.status}).`)
  const d = (await r.json()) as { publicKey?: string }
  if (!d.publicKey) throw new Error('Server returned no VAPID public key — is Web Push configured?')
  return d.publicKey
}

async function postSubscription(sub: PushSubscription): Promise<void> {
  // PushSubscription.toJSON() yields { endpoint, keys: { p256dh, auth } } — exactly the shape
  // the webserver's /api/push/subscribe + push_subscriptions row expect.
  const json = sub.toJSON()
  const r = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys: {
        p256dh: json.keys?.p256dh,
        auth: json.keys?.auth,
      },
      userAgent: navigator.userAgent,
    }),
  })
  if (!r.ok) throw new Error(`Could not register for notifications (${r.status}).`)
}

// Standard helper: decode a URL-safe base64 VAPID key into the Uint8Array `applicationServerKey`
// the Push API wants.
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const output = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i)
  return output
}
