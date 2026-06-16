import { loadConfig } from '@alfred/shared'
import webpush, { WebPushError } from 'web-push'

// The notification abstraction — a sibling of LlmProvider / SttProvider / TtsProvider
// (autonomous-watchers spec, ARCHITECTURE §9.4 / RUNTIME §7.7). A watcher fires when no client is
// connected, so SSE (fire-and-forget) can't reach the owner; the durable `notifications` outbox +
// this Notifier are the push transport. The payload is thin — title + body + a deep link into the
// existing /conversation/:id chat — because tapping opens the full result + approval card there.
//
// `send` takes ONE subscription and returns a structured result rather than throwing: a `410 Gone`
// (or `404`) means the browser dropped the subscription, surfaced as `gone:true` so the dispatcher
// prunes the dead row. Any other failure is `gone:false` (a transient/permanent send error the
// dispatcher logs). Modelled on speech-provider.ts (config read via cast, factory returns null when
// inert) so this module compiles standalone before the sibling config-schema edit lands.

// The push subscription shape the Notifier needs. Mirrors a push_subscriptions row's
// endpoint + keys; agent-core stays free of @alfred/db, so the caller maps the row to this.
export interface PushSubscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

// The thin push payload — keep field names verbatim (title/body/deepLink): the web service worker
// parses exactly this JSON shape off event.data.json(). The body is plain text rendered by the
// browser's showNotification (sanitized text, never innerHTML) — full content stays behind the link.
export interface NotificationPayload {
  title: string
  body: string
  deepLink: string
}

export interface Notifier {
  send(
    subscription: PushSubscription,
    payload: NotificationPayload,
  ): Promise<{ ok: true } | { ok: false; gone: boolean }>
}

// VAPID config keys (added to the shared zod schema by the config slice). Read defensively via a
// cast so this module compiles standalone — the contract guarantees the keys at runtime, but
// agent-core must not hard-depend on a sibling slice's schema edit (mirrors speechConfig()).
interface VapidConfig {
  VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: string
  VAPID_SUBJECT?: string
}

function vapidConfig(): VapidConfig {
  return loadConfig() as unknown as VapidConfig
}

// WebPushNotifier — the web-push impl. VAPID details are set per-send from the constructor opts
// (web-push's setVapidDetails is global; passing them on each sendNotification keeps it instance-
// local and avoids stomping a second notifier). A 410/404 status maps to gone:true so the caller
// prunes the dead subscription; any other error is a non-gone failure.
export class WebPushNotifier implements Notifier {
  private readonly vapid: { publicKey: string; privateKey: string; subject: string }

  constructor(opts: { publicKey: string; privateKey: string; subject: string }) {
    this.vapid = { publicKey: opts.publicKey, privateKey: opts.privateKey, subject: opts.subject }
  }

  async send(
    subscription: PushSubscription,
    payload: NotificationPayload,
  ): Promise<{ ok: true } | { ok: false; gone: boolean }> {
    try {
      await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: subscription.keys },
        JSON.stringify(payload),
        {
          vapidDetails: {
            subject: this.vapid.subject,
            publicKey: this.vapid.publicKey,
            privateKey: this.vapid.privateKey,
          },
        },
      )
      return { ok: true }
    } catch (err) {
      // 410 Gone / 404 Not Found = the subscription is dead; signal a prune.
      const status = err instanceof WebPushError ? err.statusCode : undefined
      const gone = status === 410 || status === 404
      return { ok: false, gone }
    }
  }
}

// Return a WebPushNotifier when all three VAPID keys are configured, else null (Web Push inert —
// like a missing GEMINI key). The worker dispatcher no-ops when this is null. Reads config via the
// cast (see vapidConfig) so the factory works before the config slice's schema edit lands.
export function makeNotifier(): Notifier | null {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = vapidConfig()
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) return null
  return new WebPushNotifier({
    publicKey: VAPID_PUBLIC_KEY,
    privateKey: VAPID_PRIVATE_KEY,
    subject: VAPID_SUBJECT,
  })
}
