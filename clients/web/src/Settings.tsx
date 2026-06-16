import { useEffect, useState } from 'react'
import {
  disableNotifications,
  enableNotifications,
  getPushState,
  type PushState,
} from './push'

// Settings → Notifications. The owner enables Web Push here (the one permission prompt), so
// autonomous watchers (spec 2026-06-16) can reach them when no chat is open. Themed to match
// the Tools/Debug pages (espresso/brass, hand-rolled).
export default function Settings() {
  const [state, setState] = useState<PushState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let ignore = false
    void getPushState().then((s) => {
      if (!ignore) setState(s)
    })
    return () => {
      ignore = true
    }
  }, [])

  const refresh = async () => setState(await getPushState())

  const enable = async () => {
    setBusy(true)
    setError(null)
    try {
      setState(await enableNotifications())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not enable notifications.')
      await refresh().catch(() => {})
    } finally {
      setBusy(false)
    }
  }

  const disable = async () => {
    setBusy(true)
    setError(null)
    try {
      setState(await disableNotifications())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not disable notifications.')
      await refresh().catch(() => {})
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl flex-1 overflow-y-auto px-5 py-6">
      <h1 className="text-xl font-semibold text-ink">Settings</h1>

      <section className="mt-6 overflow-hidden rounded-2xl border border-line bg-paper-raised">
        <header className="border-b border-line px-4 py-3">
          <h2 className="font-medium text-ink">Notifications</h2>
          <p className="mt-0.5 text-xs text-muted">
            Let Alfred notify this device when a watcher finds something or needs your approval —
            even when no chat is open. Tapping a notification opens the conversation.
          </p>
        </header>

        <div className="px-4 py-4">
          {state == null ? (
            <p className="text-sm text-muted">Checking notification status…</p>
          ) : (
            <NotificationControl state={state} busy={busy} onEnable={enable} onDisable={disable} />
          )}
          {error && (
            <p className="mt-3 rounded-lg border border-red-400/40 bg-red-400/5 px-3 py-2 text-xs text-red-400">
              {error}
            </p>
          )}
        </div>
      </section>
    </div>
  )
}

function NotificationControl({
  state,
  busy,
  onEnable,
  onDisable,
}: {
  state: PushState
  busy: boolean
  onEnable: () => void
  onDisable: () => void
}) {
  if (!state.supported) {
    return (
      <p className="text-sm text-muted">
        This browser doesn’t support Web Push. On iOS, add Alfred to your Home Screen first
        (Share → Add to Home Screen), then open it from there.
      </p>
    )
  }

  if (state.permission === 'denied') {
    return (
      <div className="flex items-center gap-3">
        <StatusDot tone="off" />
        <p className="text-sm text-muted">
          Notifications are <span className="text-ink">blocked</span> in your browser settings.
          Re-allow them for this site, then return here to enable.
        </p>
      </div>
    )
  }

  if (state.subscribed) {
    return (
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <StatusDot tone="on" />
          <p className="text-sm text-ink-dim">
            Notifications are <span className="text-brass-soft">on</span> for this device.
          </p>
        </div>
        <button
          type="button"
          onClick={onDisable}
          disabled={busy}
          className="shrink-0 rounded-full border border-line px-4 py-1.5 text-sm text-ink-dim transition-colors hover:border-brass hover:text-brass disabled:opacity-50"
        >
          {busy ? 'Working…' : 'Turn off'}
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <StatusDot tone="off" />
        <p className="text-sm text-muted">Notifications are off for this device.</p>
      </div>
      <button
        type="button"
        onClick={onEnable}
        disabled={busy}
        className="shrink-0 rounded-full border border-brass bg-brass/15 px-4 py-1.5 text-sm text-brass-soft transition-colors hover:bg-brass/25 disabled:opacity-50"
      >
        {busy ? 'Working…' : 'Enable notifications'}
      </button>
    </div>
  )
}

function StatusDot({ tone }: { tone: 'on' | 'off' }) {
  return (
    <span
      aria-hidden="true"
      className={`h-2.5 w-2.5 shrink-0 rounded-full ${
        tone === 'on' ? 'bg-brass shadow-[0_0_6px_rgba(205,163,95,0.6)]' : 'bg-line'
      }`}
    />
  )
}
