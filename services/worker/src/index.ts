import { sweepOrphanedRuns, workAgentRuns } from '@alfred/db'
import { getBridge } from './browser/bridge.js'
import { publishToolCatalog } from './catalog.js'
import { runJob } from './run.js'

// Fail-and-restart: on boot, any run left 'running' is orphaned -> mark it failed.
const swept = await sweepOrphanedRuns()
if (swept > 0) console.log(`alfred-worker: swept ${swept} orphaned run(s) to failed`)

// Embedded browser bridge (ARCHITECTURE §8, Option C): the WebSocket server the Chrome
// extension connects to lives in this process. It outlives individual runs; the extension
// reconnects on its own across worker restarts.
const bridge = getBridge()
bridge.start()
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    bridge.stop()
    process.exit(0)
  })
}

// Publish the live tool catalog to Postgres so the web Tools page can list/configure it
// (tools-page spec). Derived from the worker's real tools, so it can't drift from what runs.
await publishToolCatalog()

await workAgentRuns(runJob)
console.log('alfred-worker: consuming agent-run jobs')
