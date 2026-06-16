import { makeNotifier, type Notifier } from '@alfred/agent-core'
import {
  deletePushSubscription,
  getDb,
  listPendingNotifications,
  listPushSubscriptions,
  markNotificationFailed,
  markNotificationSent,
} from '@alfred/db'
import { loadConfig } from '@alfred/shared'
import pg from 'pg'

// The notifications dispatcher (autonomous-watchers spec, "Notifications"). A watcher fires when no
// client is connected, so SSE is useless — notifications are a DURABLE outbox + Web Push. The
// worker writes a notifications row + NOTIFY on the SEPARATE 'notifications' channel; this
// dispatcher LISTENs (mirroring run.ts's watchForCancel dedicated-client + 'error' pattern), loads
// the pending rows, and pushes each to every push_subscriptions row for the user via the
// WebPushNotifier. On a 410 Gone it prunes the dead subscription; marks the row sent if any device
// succeeded, else failed. A boot catch-up drains anything written while the dispatcher was down.

let drainChain: Promise<void> = Promise.resolve()

// Drain all pending notifications, serialized (drainChain) so concurrent NOTIFY events + the boot
// catch-up don't double-send the same row. Best-effort: any failure logs and the row stays pending
// or is marked failed — never throws into the LISTEN handler.
async function drainPending(notifier: Notifier): Promise<void> {
  const db = getDb()
  const pending = await listPendingNotifications(db)
  for (const n of pending) {
    const subs = await listPushSubscriptions(db, n.userId)
    if (subs.length === 0) {
      // No devices to reach — mark failed so it isn't retried forever (the owner can re-enable
      // push and a future notification will reach them; this stale one stays in the audit trail).
      await markNotificationFailed(db, n.id).catch(() => {})
      continue
    }
    const payload = { title: n.title, body: n.body, deepLink: n.deepLink }
    // Split the terminal decision three ways so a transient push-service failure (429/500/network
    // blip → gone:false, no success) doesn't strand the owner permanently: marking it 'failed'
    // would be terminal and the boot catch-up only re-drains 'pending', so the notification would
    // be lost silently. Instead: 'sent' if any device succeeded; 'failed' ONLY when every failing
    // device was truly undeliverable (gone:true, pruned); LEAVE 'pending' on any transient failure
    // (gone:false) with no success, so the next NOTIFY / boot catch-up retries it.
    let anySucceeded = false
    let anyTransientFailure = false
    for (const sub of subs) {
      try {
        const result = await notifier.send(
          { endpoint: sub.endpoint, keys: sub.keys as { p256dh: string; auth: string } },
          payload,
        )
        if (result.ok) {
          anySucceeded = true
        } else if (result.gone) {
          // 410 Gone / 404: the browser dropped this subscription — prune the dead row.
          await deletePushSubscription(db, sub.endpoint).catch(() => {})
        } else {
          // Transient (429/5xx/network) — the subscription is still valid, retry later.
          anyTransientFailure = true
          console.error(`[notifications] transient send failure to ${sub.endpoint.slice(0, 40)}…`)
        }
      } catch (err) {
        // A thrown error (the Notifier shouldn't throw, but be defensive) is treated as transient
        // too — don't mark a row terminal on an unexpected throw; retry on the next drain.
        anyTransientFailure = true
        console.error(`[notifications] send to ${sub.endpoint.slice(0, 40)}… failed:`, err instanceof Error ? err.message : String(err))
      }
    }
    if (anySucceeded) {
      await markNotificationSent(db, n.id).catch(() => {})
    } else if (anyTransientFailure) {
      // Leave the row 'pending' — a next NOTIFY (a later watcher firing) or the next boot catch-up
      // re-drains it. We don't self-reschedule here: that could spin a tight requeue loop while the
      // push service is down. The owner is no worse off than before the transient outage.
      console.error(`[notifications] notification ${n.id} left pending (transient failure, will retry on next drain)`)
    } else {
      // Every failing device was gone:true (pruned) — truly undeliverable. Mark terminal 'failed'.
      await markNotificationFailed(db, n.id).catch(() => {})
    }
  }
}

// Schedule a drain on the shared chain (so overlapping NOTIFYs don't race the same rows).
function scheduleDrain(notifier: Notifier): void {
  drainChain = drainChain
    .then(() => drainPending(notifier))
    .catch((err) => console.error('[notifications] drain failed:', err instanceof Error ? err.message : String(err)))
}

// Start the dispatcher. Returns an async disposer (stop the LISTEN client) or undefined when Web
// Push is inert (VAPID unset) — the caller's shutdown handler runs the disposer if present.
export async function startNotificationDispatcher(): Promise<(() => Promise<void>) | undefined> {
  const notifier = makeNotifier()
  if (!notifier) {
    // VAPID not configured — Web Push is inert (like a missing GEMINI key). Log once and no-op,
    // so a watcher's notification row simply stays pending (delivered if push is configured later).
    console.log('[notifications] Web Push not configured (VAPID keys unset); dispatcher idle')
    return undefined
  }

  const { POSTGRES_URL } = loadConfig()
  if (!POSTGRES_URL) throw new Error('POSTGRES_URL is not set — required for the notifications dispatcher')
  const client = new pg.Client({ connectionString: POSTGRES_URL })
  await client.connect()
  // A dropped LISTEN socket is otherwise an unhandled 'error' EventEmitter event that crashes the
  // worker; log and degrade (the boot catch-up + future NOTIFYs still drive delivery once the
  // socket recovers on a worker restart).
  client.on('error', (err) => console.error('[notifications] LISTEN connection error:', err))
  client.on('notification', () => scheduleDrain(notifier))

  try {
    await client.query('LISTEN "notifications"')
  } catch (err) {
    await client.end().catch(() => {})
    throw err
  }

  // Boot catch-up: drain anything written while the dispatcher was down.
  scheduleDrain(notifier)
  console.log('[notifications] dispatcher listening on the notifications channel')

  return async () => {
    await client.query('UNLISTEN "notifications"').catch(() => {})
    await client.end().catch(() => {})
  }
}
