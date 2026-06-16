import { sweepOrphanedRuns, workAgentRuns, workTriggerDetects } from '@alfred/db'
import { APP_VERSION } from '@alfred/shared'
import { getBridge } from './browser/bridge.js'
import { publishToolCatalog } from './catalog.js'
import { startNotificationDispatcher } from './notifications/dispatcher.js'
import { runJob } from './run.js'
import { detectTrigger } from './triggers/detect.js'

console.log(`alfred-worker: version ${APP_VERSION}`)

// Fail-and-restart: on boot, any run left 'running' is orphaned -> mark it failed.
const swept = await sweepOrphanedRuns()
if (swept > 0) console.log(`alfred-worker: swept ${swept} orphaned run(s) to failed`)

// Embedded browser bridge (ARCHITECTURE §8, Option C): the WebSocket server the Chrome
// extension connects to lives in this process. It outlives individual runs; the extension
// reconnects on its own across worker restarts.
const bridge = getBridge()
bridge.start()

// Notifications dispatcher (autonomous-watchers spec): LISTENs the 'notifications' channel and
// pushes outbox rows via Web Push. Inert (no-op) when VAPID isn't configured. The disposer tears
// down its dedicated LISTEN client on shutdown.
const stopDispatcher = await startNotificationDispatcher()

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    bridge.stop()
    // Best-effort teardown of the dispatcher's LISTEN client (fire-and-forget — we exit promptly).
    if (stopDispatcher) void stopDispatcher().catch(() => {})
    process.exit(0)
  })
}

// Publish the live tool catalog to Postgres so the web Tools page can list/configure it
// (tools-page spec). Derived from the worker's real tools, so it can't drift from what runs.
await publishToolCatalog()

// Trigger-detect jobs (autonomous-watchers spec): a due trigger enqueues one; the handler runs
// the tiered detection ladder (Tier 0 gate → Tier 1 triage), only escalating to a real agent-run
// on signal. Detection creates NO agent_runs row (no idle-poll litter).
await workTriggerDetects(detectTrigger)
console.log('alfred-worker: consuming trigger-detect jobs')

await workAgentRuns(runJob)
console.log('alfred-worker: consuming agent-run jobs')
